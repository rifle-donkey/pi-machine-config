/* Bounded, no-link file access and portable path rules for scan/deploy. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { invalid } from './errors.ts';

export const MiB = 1024 * 1024;
export function relativePath(p: string): string {
  if (!p || p.length > 255 || /[\\\x00-\x1f\x7f:]/u.test(p) || p.split('/').some(s => !s || s === '.' || s === '..')) throw invalid('invalid-path');
  return p;
}
export function excluded(p: string): boolean {
  return p.split('/').some(s => /^(?:\.git|node_modules|\.env.*|\.npmrc|\.netrc|id_.*|.*credentials?.*|secrets?(?:[._-].*)?|auth(?:[._-].*)?|trust(?:[._-].*)?|mcp(?:[._-].*)?|ingka_pat|models-store\.json|pi-herdr\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|\.pi-env-.*|\._.*)$|\.(?:pem|key|p12|pfx|jks|keystore|log(?:\.\d+)?|jsonl|lockb?|lck|pid|sock|sqlite3?|db|bak[^/]*)$/i.test(s)) ||
    /^(?:install|bin|npm|sessions(?:\.bak-.*)?|web-search-cache|pi-web-access)(?:\/|$)/i.test(p);
}
export const portableKey = (p: string) => p.normalize('NFC').toLowerCase();
export function stat(path: string) {
  try { return fs.lstatSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
}
export function directory(path: string, create = false): boolean {
  const { root, parts } = { root: sep, parts: resolve(path).split(sep).filter(Boolean) };
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    const s = stat(cursor);
    if (s && !s.isDirectory()) throw invalid('unsafe-directory');
    if (!s && !create) return false;
    if (!s) fs.mkdirSync(cursor, { mode: 0o700 });
  }
  return true;
}
export function file(path: string, limit = MiB): { bytes: Buffer; mode: number } | undefined {
  if (!directory(dirname(path))) return;
  const before = stat(path);
  if (!before) return;
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw invalid('unsafe-file');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.dev !== before.dev || s.ino !== before.ino || s.size > limit) throw invalid('unsafe-file');
    const bytes = Buffer.alloc(s.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) throw invalid('changed-file');
      offset += n;
    }
    const end = fs.fstatSync(fd);
    if (end.size !== s.size || end.mtimeMs !== s.mtimeMs || end.ctimeMs !== s.ctimeMs) throw invalid('changed-file');
    return { bytes, mode: s.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
export function roots() {
  const rawHome = process.env.HOME;
  const rawAgent = process.env.PI_CODING_AGENT_DIR;
  if (!rawHome || !isAbsolute(rawHome) || (rawAgent !== undefined && !isAbsolute(rawAgent))) throw invalid('invalid-root');
  const home = resolve(rawHome), agent = resolve(rawAgent ?? join(home, '.pi', 'agent')), lens = join(home, '.pi-lens');
  const backup = join(home, '.pi-env-backup');
  const within = (a: string, b: string) => a === b || a.startsWith(b + sep);
  if (within(home, agent) || within(agent, lens) || within(lens, agent) || within(agent, backup) || within(backup, agent)) throw invalid('overlapping-roots');
  directory(home); directory(agent); directory(lens);
  return { home, agent, lens, backup };
}
