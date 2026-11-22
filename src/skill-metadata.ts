/** Diagnose a conservative subset of Pi skill entry metadata from approved bytes only. */
import { invalid } from './errors.ts';
import { decodeUtf8 } from './json.ts';
import { checkPlacement, checkProhibited, relPath } from './schema.ts';

const MiB = 1024 * 1024;
const entryName = 'SKILL.md';
const nulls = new Set(['null', 'Null', 'NULL']);
const truths = new Set(['true', 'True', 'TRUE']);
const falses = new Set(['false', 'False', 'FALSE']);

type Input = { path: string; bytes: Uint8Array };
type Rejection = { status: 'missing'; reason: 'entry-missing' | 'frontmatter-missing' | 'description-missing' } |
  { status: 'unsupported'; reason: 'entry-location' | 'limit' | 'decode' | 'bom' | 'delimiter' | 'syntax' } |
  { status: 'invalid'; reason: 'frontmatter-invalid' | 'description-invalid' | 'manual-only-invalid' | 'name-invalid' };
type Entry = { path: string } & (Rejection | {
  status: 'recognized'; manualOnly: boolean; nameSource: 'directory' | 'frontmatter';
  nameValid: boolean; nameMatchesDirectory: boolean; descriptionTooLong: boolean;
});
type Report = { status: 'limit' } | { status: 'complete'; entries: Entry[] };
type Scalar = { raw: string; value: string | boolean | null };

function trimAsciiSpace(value: string): string {
  let start = 0, end = value.length;
  while (start < end && value[start] === ' ') start++;
  while (end > start && value[end - 1] === ' ') end--;
  return value.slice(start, end);
}

function scalar(raw: string): Scalar | undefined {
  if (!raw || raw === '~' || nulls.has(raw)) return { raw, value: null };
  if (truths.has(raw)) return { raw, value: true };
  if (falses.has(raw)) return { raw, value: false };
  if (raw[0] === "'" || raw[0] === '"') {
    const content = raw.slice(1, -1);
    if (raw.length < 2 || !raw.endsWith(raw[0]) || content.includes(raw[0]) || content.includes('\\')) return;
    return { raw, value: content };
  }
  if (!/^[A-Za-z]/.test(raw) || /:\s|:$|\s#/.test(raw)) return;
  return { raw, value: raw };
}

/** Internal metadata core. Never serialize the effective name. */
export function inspectSkillEntry(path: string, directory: string, bytes: Uint8Array):
  { entry: Entry; effectiveName?: string } {
  const reject = (result: Rejection) => ({ entry: { path, ...result } });
  if (bytes.byteLength > MiB) return reject({ status: 'unsupported', reason: 'limit' });
  let text: string;
  try { text = decodeUtf8(bytes); }
  catch { return reject({ status: 'unsupported', reason: 'decode' }); }
  if (text.includes('\0')) return reject({ status: 'unsupported', reason: 'decode' });
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (text.startsWith('\uFEFF')) return reject({ status: 'unsupported', reason: 'bom' });
  text = text.replace(/\r\n?/g, '\n');
  const close = text.indexOf('\n---', 3);
  if (!text.startsWith('---') || close < 0) return reject({ status: 'missing', reason: 'frontmatter-missing' });
  if (!text.startsWith('---\n') || (close + 4 !== text.length && text[close + 4] !== '\n')) {
    return reject({ status: 'unsupported', reason: 'delimiter' });
  }
  const body = text.slice(4, close);
  if (!body) return reject({ status: 'missing', reason: 'frontmatter-missing' });
  if (Buffer.byteLength(body) > 64 * 1024) return reject({ status: 'unsupported', reason: 'limit' });
  const lines = body.split('\n');
  if (lines.length > 255 || lines.some(line => line.length > 4096)) return reject({ status: 'unsupported', reason: 'limit' });
  const values = new Map<string, Scalar>();
  let duplicate = false;
  const syntax = () => reject({ status: 'unsupported', reason: 'syntax' });
  for (const line of lines) {
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029\uFEFF\uFFFE\uFFFF]/.test(line)) return syntax();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63}):(.*)$/.exec(line);
    if (!match) return syntax();
    const [, key, rest] = match;
    if (nulls.has(key) || truths.has(key) || falses.has(key) || (rest && !rest.startsWith(' '))) return syntax();
    const parsed = scalar(trimAsciiSpace(rest));
    if (!parsed) return syntax();
    duplicate ||= values.has(key);
    values.set(key, parsed);
  }
  if (duplicate) return reject({ status: 'invalid', reason: 'frontmatter-invalid' });
  const description = values.get('description')?.value;
  if (typeof description === 'boolean') return reject({ status: 'invalid', reason: 'description-invalid' });
  if (!description?.trim()) return reject({ status: 'missing', reason: 'description-missing' });
  const manual = values.get('disable-model-invocation');
  if (manual && manual.raw !== 'true' && manual.raw !== 'false') return reject({ status: 'invalid', reason: 'manual-only-invalid' });
  const suppliedName = values.get('name')?.value;
  if (typeof suppliedName === 'boolean') return reject({ status: 'invalid', reason: 'name-invalid' });
  const name = suppliedName || directory;
  return { effectiveName: name, entry: { path, status: 'recognized', manualOnly: manual?.raw === 'true',
    nameSource: suppliedName ? 'frontmatter' : 'directory',
    nameValid: name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name),
    nameMatchesDirectory: name === directory, descriptionTooLong: description.length > 1024 } };
}

export function analyzeSkillEntries(files: readonly Input[]): Report {
  const badInput = () => invalid('skill-metadata-input-invalid');
  if (!Array.isArray(files)) throw badInput();
  if (files.length > 4096) return { status: 'limit' };
  const approved = new Map<string, Uint8Array>();
  let total = 0;
  try {
    for (const file of files as readonly Input[]) {
      const path = relPath(file.path), bytes = file.bytes;
      checkProhibited('agent', path, 'skill-source');
      checkPlacement('agent', path, 'skill-source', 'common');
      if (approved.has(path) || !(bytes instanceof Uint8Array)) throw badInput();
      approved.set(path, bytes);
      total += bytes.byteLength;
    }
  } catch { throw badInput(); }
  if (total > 48 * MiB) return { status: 'limit' };
  const groups = new Set<string>();
  const entries: Entry[] = [];
  for (const [path, bytes] of approved) {
    const parts = path.split('/');
    const directory = parts[1];
    groups.add(directory);
    if (parts.at(-1) !== entryName) continue;
    entries.push(parts.length === 3 ? inspectSkillEntry(path, directory, bytes).entry :
      { path, status: 'unsupported', reason: 'entry-location' });
  }
  for (const directory of groups) {
    const path = `skills/${directory}/${entryName}`;
    if (!approved.has(path)) entries.push({ path, status: 'missing', reason: 'entry-missing' });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: 'complete', entries };
}
