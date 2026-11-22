/** Model automatic skill candidates in an approved payload tree, not actual discovery. */
import { invalid } from './errors.ts';
import { checkPlacement, checkProhibited, relPath, settingValue } from './schema.ts';
import { inspectSkillEntry } from './skill-metadata.ts';

type Input = { path: string; bytes: Uint8Array };
type Entry = { path: string } & ({ status: 'candidate' | 'shadowed' } |
  { status: 'unverified'; reason: 'entry-location' | 'metadata' | 'settings' });
type Report = { status: 'limit' } | { status: 'complete'; entries: Entry[];
  nameCheck: 'complete' | 'unverified'; collisions: string[][] };
const entryName = 'SKILL.md';
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const badInput = () => invalid('skill-discovery-input-invalid');

function checkNamespace(paths: Iterable<string>): void {
  const namespace = new Map<string, { path: string; directory: boolean }>();
  for (const path of paths) {
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix = i === 0 ? parts[i] : `${prefix}/${parts[i]}`;
      const folded = prefix.normalize('NFC').toLowerCase();
      const directory = i < parts.length - 1;
      const existing = namespace.get(folded);
      if (existing && (existing.path !== prefix || existing.directory !== directory)) throw badInput();
      if (!existing) namespace.set(folded, { path: prefix, directory });
    }
  }
}

export function analyzeSkillDiscovery(files: readonly Input[], skillsSetting?: unknown): Report {
  if (!Array.isArray(files)) throw badInput();
  if (files.length > 4096) return { status: 'limit' };
  const approved = new Map<string, Uint8Array>();
  let bytesTotal = 0;
  let settingsPresent = false;
  try {
    for (let i = 0; i < files.length; i++) {
      const file: Input = files[i];
      const path = relPath(file.path), bytes = file.bytes;
      checkProhibited('agent', path, 'skill-source');
      checkPlacement('agent', path, 'skill-source', 'common');
      if (approved.has(path) || !(bytes instanceof Uint8Array)) throw badInput();
      approved.set(path, bytes);
      bytesTotal += bytes.byteLength;
    }
    checkNamespace(approved.keys());
    if (skillsSetting !== undefined) {
      const settings = settingValue('skills', skillsSetting);
      settingsPresent = Array.isArray(settings) && settings.length > 0;
    }
  } catch { throw badInput(); }
  if (bytesTotal > 48 * 1024 * 1024) return { status: 'limit' };

  const entries: Entry[] = [];
  const byName = new Map<string, string[]>();
  for (const path of [...approved.keys()].sort(compare)) {
    const parts = path.split('/');
    if (parts.at(-1) !== entryName) continue;
    let shadowed = false;
    for (let depth = 2; depth < parts.length - 1; depth++) {
      if (approved.has(`${parts.slice(0, depth).join('/')}/${entryName}`)) {
        shadowed = true;
        break;
      }
    }
    if (shadowed) entries.push({ path, status: 'shadowed' });
    else if (parts.length !== 3) entries.push({ path, status: 'unverified', reason: 'entry-location' });
    else {
      const { effectiveName } = inspectSkillEntry(path, parts[1], approved.get(path)!);
      if (effectiveName === undefined) entries.push({ path, status: 'unverified', reason: 'metadata' });
      else if (settingsPresent) entries.push({ path, status: 'unverified', reason: 'settings' });
      else {
        entries.push({ path, status: 'candidate' });
        const group = byName.get(effectiveName);
        if (group) group.push(path);
        else byName.set(effectiveName, [path]);
      }
    }
  }
  const nameCheck = settingsPresent || entries.some(entry => entry.status === 'unverified') ? 'unverified' : 'complete';
  const collisions = [...byName.values()].filter(group => group.length > 1).sort((a, b) => compare(a[0], b[0]));
  return { status: 'complete', entries, nameCheck, collisions };
}
