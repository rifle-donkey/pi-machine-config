/* Encode and validate the regular-file-only portable archive without extraction. */
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { invalid } from './errors.ts';
import { excluded, MiB, portableKey, relativePath } from './env-files.ts';
import { decodeUtf8, parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';

export const totalLimit = 100 * MiB;
export const entryLimit = 10_000;
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type Entry = { root: 'agent' | 'pi-lens'; path: string; bytes: Buffer; mode: number; templated: boolean };
const member = (e: Entry) => `files/${e.root}/${e.path}`;
export function object(v: JsonValue | undefined): JsonObject {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('invalid-object');
  return v;
}
export function array(v: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(v)) throw invalid('invalid-array');
  return v;
}
export function str(v: JsonValue | undefined): string {
  if (typeof v !== 'string') throw invalid('invalid-string');
  return v;
}
const block = 512;
const zeros = (b: Buffer) => b.every(n => n === 0);
const pad = (len: number) => (block - len % block) % block;
const checksum = (h: Buffer) => h.reduce((sum, n, i) => sum + (i >= 148 && i < 156 ? 32 : n), 0);
function record(path: string, bytes: Buffer, mode: number): Buffer[] {
  let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/');
    prefix = name.slice(0, i); name = name.slice(i + 1);
    if (i < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) throw invalid('archive-path-limit');
  }
  const h = Buffer.alloc(block);
  const oct = (n: number, at: number, len: number) => h.write(n.toString(8).padStart(len - 1, '0'), at, len - 1, 'ascii');
  h.write(name, 0, 100); h.write(prefix, 345, 155);
  oct(mode, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(bytes.length, 124, 12); oct(0, 136, 12);
  h[156] = 48; h.write('ustar\0' + '00', 257); oct(checksum(h), 148, 7); h[155] = 32;
  return [h, bytes, Buffer.alloc(pad(bytes.length))];
}
export function encode(metadata: JsonObject, entries: Entry[]): Buffer {
  validateNames(entries);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, ...metadata, files: entries.map(e => ({
    root: e.root, path: e.path, size: e.bytes.length, sha256: digest(e.bytes), mode: e.mode, templated: e.templated,
  })) }));
  if (manifest.length > MiB || entries.length > entryLimit) throw invalid('archive-limit');
  const records = [...record('manifest.json', manifest, 0o600), ...entries.flatMap(e => record(member(e), e.bytes, e.mode)), Buffer.alloc(2 * block)];
  const size = records.reduce((n, b) => n + b.length, 0);
  if (size > totalLimit) throw invalid('archive-limit');
  const result = gzipSync(Buffer.concat(records, size));
  if (result.length > totalLimit) throw invalid('archive-limit');
  return result;
}
export function decode(compressed: Buffer) {
  let raw: Buffer;
  try { raw = gunzipSync(compressed, { maxOutputLength: totalLimit }); } catch { throw invalid('invalid-archive'); }
  const found = new Map<string, Buffer>();
  const readName = (h: Buffer, a: number, b: number) => {
    const field = h.subarray(a, b), end = field.indexOf(0);
    if (end >= 0 && !zeros(field.subarray(end))) throw invalid('invalid-archive');
    return decodeUtf8(end < 0 ? field : field.subarray(0, end));
  };
  const oct = (h: Buffer, a: number, b: number) => {
    const value = h.toString('latin1', a, b).replace(/[\0 ]+$/, '').trimStart();
    if (!/^[0-7]+$/.test(value)) throw invalid('invalid-archive');
    return Number.parseInt(value, 8);
  };
  let at = 0;
  for (; at + block <= raw.length;) {
    const h = raw.subarray(at, at + block);
    if (zeros(h)) break;
    if ((h[156] !== 48 && h[156] !== 0) || h.toString('latin1', 257, 265) !== 'ustar\0' + '00' ||
        checksum(h) !== oct(h, 148, 156) || !zeros(h.subarray(157, 257))) throw invalid('invalid-archive');
    const prefix = readName(h, 345, 500), name = relativePath((prefix ? prefix + '/' : '') + readName(h, 0, 100));
    const size = oct(h, 124, 136), data = at + block, end = data + size + pad(size);
    if (size > MiB || end > raw.length || found.size > entryLimit || found.has(name) ||
        (!found.size && name !== 'manifest.json') || !zeros(raw.subarray(data + size, end))) throw invalid('invalid-archive');
    found.set(name, raw.subarray(data, data + size));
    at = end;
  }
  if (at + 2 * block > raw.length || raw.length % block || !zeros(raw.subarray(at)) || !found.has('manifest.json')) throw invalid('invalid-archive');
  const metadata = object(parseJsonBytes(found.get('manifest.json')!));
  found.delete('manifest.json');
  if (metadata.schemaVersion !== 1) throw invalid('invalid-archive');
  const entries = array(metadata.files).map((row): Entry => {
    const { root, path: p, size, sha256, mode, templated } = object(row);
    if (root !== 'agent' && root !== 'pi-lens') throw invalid('invalid-archive');
    const path = relativePath(str(p));
    if (excluded(path) || (root === 'pi-lens' && path !== 'config.json') || typeof mode !== 'number' ||
        !Number.isInteger(mode) || mode < 0 || mode > 0o777 || typeof templated !== 'boolean') throw invalid('invalid-archive');
    const key = `files/${root}/${path}`, bytes = found.get(key);
    if (!bytes || size !== bytes.length || sha256 !== digest(bytes)) throw invalid('archive-integrity');
    found.delete(key);
    return { root, path, bytes, mode, templated };
  });
  if (found.size || !entries.some(e => e.root === 'agent' && e.path === 'settings.json')) throw invalid('archive-integrity');
  validateNames(entries);
  return { metadata, entries };
}
function validateNames(entries: Entry[]) {
  const files = new Set<string>(), prefixes = new Map<string, string>();
  for (const entry of entries) {
    const path = member(entry), parts = path.split('/'), key = portableKey(path);
    if (files.has(key)) throw invalid('archive-path-conflict');
    files.add(key);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/'), k = portableKey(p);
      if (prefixes.has(k) && prefixes.get(k) !== p) throw invalid('archive-path-conflict');
      prefixes.set(k, p);
    }
  }
  for (const path of files) {
    const parts = path.split('/');
    if (parts.some((_, i) => files.has(parts.slice(0, i).join('/')))) throw invalid('archive-path-conflict');
  }
}
