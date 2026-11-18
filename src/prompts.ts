/**
 * Pure Pi 1.5.2 exact local-prompt reference subset, reused by plan and later
 * doctor work. Never reads directories, evaluates templates or loads Pi/YAML.
 * This checks a newly supported positive setting, not file-only prompt parity.
 */
import type { MergedFile } from './bundle.ts';
import { decodeUtf8 } from './json.ts';
import { LIMITS } from './schema.ts';

const PROMPT_PATH = /^prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** Native newline/BOM inspection only; published bytes remain unchanged. */
function plainPrompt(bytes: Uint8Array): boolean {
  if (bytes.length > LIMITS.fileBytes) return false;
  let text = decodeUtf8(bytes);
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  // Repeated BOMs are outside this conservative subset, even though native
  // strips only one and may then treat the second as ordinary body text.
  if (text.startsWith('\uFEFF') || text.includes('\0')) return false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return !(text.startsWith('---') && text.indexOf('\n---', 3) !== -1);
}

/** Only nonempty positive exact selections; negative-only settings use existing rules. */
export function promptReferencesReady(entries: readonly string[], files: readonly MergedFile[], hasPackages: boolean): boolean {
  if (hasPackages || entries.length === 0 || entries.length > LIMITS.arrayItems) return false;
  const known = new Set<string>();
  // All approved prompt files auto-load in a fresh target, not just the
  // positively named ones. Unsupported siblings must not be ignored here.
  for (const f of files) if (f.record.class === 'prompt') {
    if (f.record.root !== 'agent' || !PROMPT_PATH.test(f.record.path) || !plainPrompt(f.bytes)) return false;
    known.add(f.record.path);
  }
  return entries.every((entry) => {
    const p = entry.startsWith('+') ? entry.slice(1) : entry;
    return p.length <= LIMITS.stringLength && PROMPT_PATH.test(p) && known.has(p);
  });
}
