/**
 * Strict JSON parsing and canonical serialization.
 *
 * The parser accepts RFC 8259 JSON only and additionally rejects, with fixed
 * error codes and no input excerpts:
 * - a leading UTF-8 byte order mark (`json-bom`); Pi's own readers do not
 *   accept one, so a BOM would make a restored file unreadable;
 * - duplicate object keys (`json-duplicate-key`);
 * - prototype-sensitive keys `__proto__`, `constructor`, `prototype`
 *   (`json-unsafe-key`);
 * - numbers that are not finite or are integers outside the safe range,
 *   because they cannot round-trip (`json-unsafe-number`);
 * - lone UTF-16 surrogates in strings (`json-invalid-string`);
 * - nesting deeper than `MAX_DEPTH` (`json-too-deep`).
 * Objects are created with a null prototype.
 */
import { invalid } from './errors.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const MAX_DEPTH = 64;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Decode bytes as strict UTF-8 (fatal on invalid sequences). */
export function decodeUtf8(bytes: Uint8Array, code = 'invalid-utf8'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid(code);
  }
}

/** Parse strict JSON from bytes. */
export function parseJsonBytes(bytes: Uint8Array): JsonValue {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw invalid('json-bom');
  }
  return parseJson(decodeUtf8(bytes));
}

/** Parse a strict JSON text. */
export function parseJson(text: string): JsonValue {
  if (text.charCodeAt(0) === 0xfeff) throw invalid('json-bom');
  let pos = 0;

  const fail = (): never => {
    throw invalid('json-syntax');
  };
  const skipWs = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };
  const parseString = (): string => {
    // Caller guarantees text[pos] === '"'.
    pos++;
    let out = '';
    for (;;) {
      if (pos >= text.length) fail();
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        pos++;
        break;
      }
      if (c < 0x20) fail();
      if (c === 0x5c) {
        const e = text[pos + 1];
        pos += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail();
        }
        continue;
      }
      out += text[pos];
      pos++;
    }
    if (!out.isWellFormed()) throw invalid('json-invalid-string');
    return out;
  };
  const parseValue = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) throw invalid('json-too-deep');
    skipWs();
    const ch = text[pos];
    if (ch === '{') {
      pos++;
      const obj: JsonObject = Object.create(null);
      const seen = new Set<string>();
      skipWs();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        skipWs();
        if (text[pos] !== '"') fail();
        const key = parseString();
        if (UNSAFE_KEYS.has(key)) throw invalid('json-unsafe-key');
        if (seen.has(key)) throw invalid('json-duplicate-key');
        seen.add(key);
        skipWs();
        if (text[pos] !== ':') fail();
        pos++;
        obj[key] = parseValue(depth + 1);
        skipWs();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return obj;
        }
        fail();
      }
    }
    if (ch === '[') {
      pos++;
      const arr: JsonValue[] = [];
      skipWs();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return arr;
        }
        fail();
      }
    }
    if (ch === '"') return parseString();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    NUMBER_RE.lastIndex = pos;
    const m = NUMBER_RE.exec(text);
    if (!m) return fail();
    pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) throw invalid('json-unsafe-number');
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw invalid('json-unsafe-number');
    return n;
  };

  const value = parseValue(0);
  skipWs();
  if (pos !== text.length) fail();
  return value;
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order, arrays in
 * original order, no whitespace. Only JSON values with safe numbers are
 * accepted; anything else is a programming error.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('canonicalJson: unsafe number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new TypeError('canonicalJson: unsupported value');
}

/** Pretty JSON with sorted keys, used for files the tool writes. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}
