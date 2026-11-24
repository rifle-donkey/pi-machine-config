/* Scan-time secret checks and reversible home substitution. */
import { invalid } from './errors.ts';
import { parseJsonBytes, type JsonValue } from './json.ts';

const token = '{{HOME}}';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const json = (path: string) => path.endsWith('.json');
export const jsonBytes = (value: JsonValue) => Buffer.from(JSON.stringify(value));
function mapStrings(value: JsonValue, map: (v: string) => string): JsonValue {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, map)]));
  return value;
}
export function captureBytes(path: string, bytes: Buffer, home: string, allow: boolean, prepared?: JsonValue) {
  let text: string;
  try { text = utf8.decode(bytes); } catch { if (json(path)) throw invalid('invalid-utf8'); return { bytes, templated: false }; }
  if (text.includes('\0') && !json(path)) return { bytes, templated: false };
  if (text.includes(token)) throw invalid('ambiguous-template');
  const value = json(path) ? prepared ?? parseJsonBytes(bytes) : undefined;
  const literal = (v: JsonValue): boolean => !!v && typeof v === 'object' && Object.entries(v).some(([k, field]) =>
    (/^(apiKey|token|password|secret)$/i.test(k) && typeof field === 'string' && field.length > 0) || literal(field));
  const hit = /(?:ghp_|github_pat_|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN|\bBearer\s+\S+|\b[A-Z0-9_]+_(?:KEY|TOKEN)=\S+)/.test(text) ||
    (value !== undefined && literal(value));
  if (hit && !allow) {
    // Only report the validated relative filename and fixed rule.
    process.stderr.write(`${JSON.stringify({ path, rule: 'secret-content' })}\n`);
    throw invalid('secret-content');
  }
  let templated = false;
  const pattern = new RegExp(`(^|[\\s=:\"'(<\\[,])${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\s\"'\\])>,;])`, 'g');
  const replace = (s: string) => {
    if (s.includes(token)) throw invalid('ambiguous-template');
    return s.replace(pattern, (_, left: string) => { templated = true; return left + token; });
  };
  if (value !== undefined) {
    const mapped = mapStrings(value, replace);
    return { bytes: templated || prepared !== undefined ? jsonBytes(mapped) : bytes, templated };
  }
  const rendered = replace(text);
  return { bytes: templated ? Buffer.from(rendered) : bytes, templated };
}
export function render(path: string, bytes: Buffer, home: string, templated: boolean): Buffer {
  if (json(path)) {
    const value = parseJsonBytes(bytes);
    return templated ? jsonBytes(mapStrings(value, s => s.replaceAll(token, () => home))) : bytes;
  }
  return templated ? Buffer.from(utf8.decode(bytes).replaceAll(token, () => home)) : bytes;
}
