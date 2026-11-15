/**
 * Filesystem safety primitives: explicit-root canonicalization, live-path
 * guards, overlap checks, bounded no-follow reads and exclusive private writes.
 *
 * Supplied roots may have symlinked ancestors (they are canonicalized with
 * realpath and the identity of the supplied path is compared with the
 * canonical one), but the supplied path itself and every managed descendant
 * must not be a symlink. Reads walk each managed component with lstat, open
 * the final file with O_NOFOLLOW|O_NONBLOCK, check the descriptor identity
 * with fstat, read at most limit+1 bytes, then recheck every parent identity.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failure, invalid } from './errors.ts';

export interface Identity {
  dev: bigint;
  ino: bigint;
}

export interface DirRoot {
  /** Canonical absolute path. */
  path: string;
  id: Identity;
}

export interface AbsentTarget {
  /** Canonical absolute path: realpath(parent) + basename. */
  path: string;
  /** Whether the canonical parent exists and is a directory. */
  parentExists: boolean;
  /** Whether anything (including a dangling symlink) exists at the path. */
  exists: boolean;
}

export const MAX_DIR_ENTRIES = 4096;

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

function idOf(st: fs.BigIntStats): Identity {
  return { dev: st.dev, ino: st.ino };
}

function sameId(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function lstatOrNull(p: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null;
    throw failure('filesystem-error');
  }
}

/** Validate an operator-supplied absolute path argument and resolve `.`/`..` lexically. */
export function requireAbsolute(p: string, code: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) {
    throw invalid(code);
  }
  return path.resolve(p);
}

/** Conservative alias key: NFC plus lower case, so case/normalization aliases compare equal. */
export function fold(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function segments(p: string): string[] {
  return fold(p).split('/').filter((s) => s.length > 0);
}

/** True when one canonical path equals or contains the other (segment-wise, folded). */
export function overlaps(a: string, b: string): boolean {
  const sa = segments(a);
  const sb = segments(b);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Programmatic guard context. Production callers (the CLI) never set it, so
 * the guard uses the account home from `os.userInfo()` (never `$HOME`).
 * In-process tests may supply a temporary fixture home so the guard's own
 * canonicalization touches only fixture paths. It is not reachable from the
 * command line or the environment, and it narrows nothing else: the guard
 * still canonicalizes the given locations and `PI_CODING_AGENT_DIR`.
 */
export interface GuardContext {
  home: string;
}

/**
 * Live Pi locations the initial fixture-only slice must never read from or
 * write to: `<home>/.pi`, `<home>/.pi-lens` and `$PI_CODING_AGENT_DIR`, each
 * lexically and, when it exists, canonicalized with realpath so aliases are
 * refused too. The realpath calls query path metadata of these locations
 * (existence and symlink targets); they never open or read their contents.
 */
export function liveLocations(env: Record<string, string | undefined>, ctx?: GuardContext): string[] {
  const home = ctx === undefined ? os.userInfo().homedir : ctx.home;
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw failure('home-unavailable');
  const out = [path.join(home, '.pi'), path.join(home, '.pi-lens')];
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (typeof agentDir === 'string' && path.isAbsolute(agentDir)) out.push(path.resolve(agentDir));
  const canonical: string[] = [];
  for (const p of out) {
    try {
      canonical.push(fs.realpathSync.native(p));
    } catch {
      // Absent locations still guard their lexical path.
    }
  }
  return [...out, ...canonical];
}

/**
 * Refuse a path that overlaps a live Pi location. Callers apply it to the
 * lexical argument before any filesystem access and again to the canonical path.
 */
export function guardLiveLexical(p: string, live: string[]): void {
  for (const l of live) if (overlaps(p, l)) throw invalid('live-path-refused');
}

function canonicalExisting(p: string, kind: 'dir' | 'file', missingCode: string): DirRoot {
  const st = lstatOrNull(p);
  if (!st) throw invalid(missingCode);
  if (st.isSymbolicLink()) throw invalid('symlink-refused');
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw invalid(kind === 'dir' ? 'not-a-directory' : 'special-file-refused');
  let real: string;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    throw failure('filesystem-error');
  }
  const rst = lstatOrNull(real);
  if (!rst || !sameId(idOf(rst), idOf(st))) throw failure('root-changed');
  return { path: real, id: idOf(st) };
}

/** Canonicalize an existing supplied directory root. */
export function existingDir(p: string, missingCode: string): DirRoot {
  return canonicalExisting(p, 'dir', missingCode);
}

/** Canonicalize an existing supplied regular file. */
export function existingFile(p: string, missingCode: string): DirRoot {
  return canonicalExisting(p, 'file', missingCode);
}

/** Canonicalize a path that is expected to be absent; its parent may have symlinked ancestors. */
export function absentTarget(p: string): AbsentTarget {
  const base = path.basename(p);
  const parent = path.dirname(p);
  if (base === '' || base === '.' || base === '..' || parent === p) throw invalid('invalid-target');
  let realParent: string;
  try {
    realParent = fs.realpathSync.native(parent);
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return { path: p, parentExists: false, exists: false };
    throw failure('filesystem-error');
  }
  const pst = lstatOrNull(realParent);
  const full = path.join(realParent, base);
  if (!pst || !pst.isDirectory()) return { path: full, parentExists: false, exists: false };
  return { path: full, parentExists: true, exists: lstatOrNull(full) !== null };
}

/**
 * True when the canonical parent holds a differently spelled entry that is a
 * case/normalization alias of `base`. Reads at most MAX_DIR_ENTRIES names.
 */
export function hasSiblingAlias(parent: string, base: string): boolean {
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(parent);
  } catch {
    throw failure('filesystem-error');
  }
  const want = fold(base);
  let count = 0;
  try {
    for (;;) {
      const ent = dir.readSync();
      if (!ent) return false;
      if (++count > MAX_DIR_ENTRIES) throw failure('directory-too-large');
      if (ent.name !== base && fold(ent.name) === want) return true;
    }
  } finally {
    dir.closeSync();
  }
}

/**
 * Read a regular file at `rel` (forward-slash relative path, already
 * validated) under a canonical root, refusing symlinks, special files,
 * hard-linked files, identity changes and files larger than `limit` bytes.
 */
export function readUnder(root: DirRoot, rel: string, limit: number): Buffer {
  const parts = rel.split('/');
  const chain: { p: string; id: Identity }[] = [{ p: root.path, id: root.id }];
  const rootNow = lstatOrNull(root.path);
  if (!rootNow || !rootNow.isDirectory() || !sameId(idOf(rootNow), root.id)) throw failure('root-changed');
  let cur = root.path;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    const st = lstatOrNull(cur);
    if (!st) throw invalid('source-missing');
    if (st.isSymbolicLink()) throw invalid('symlink-refused');
    if (!st.isDirectory()) throw invalid('special-file-refused');
    chain.push({ p: cur, id: idOf(st) });
  }
  const file = path.join(cur, parts[parts.length - 1]);
  const st = lstatOrNull(file);
  if (!st) throw invalid('source-missing');
  if (st.isSymbolicLink()) throw invalid('symlink-refused');
  if (!st.isFile()) throw invalid('special-file-refused');
  if (st.nlink !== 1n) throw invalid('hardlink-refused');
  if (st.size > BigInt(limit)) throw invalid('file-too-large');
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (errCode(e) === 'ELOOP') throw invalid('symlink-refused');
    if (errCode(e) === 'ENOENT') throw failure('source-changed');
    throw failure('filesystem-error');
  }
  let data: Buffer;
  try {
    const fst = fs.fstatSync(fd, { bigint: true });
    if (!fst.isFile() || !sameId(idOf(fst), idOf(st))) throw failure('source-changed');
    if (fst.nlink !== 1n) throw invalid('hardlink-refused');
    const buf = Buffer.alloc(limit + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > limit) throw invalid('file-too-large');
    }
    data = Buffer.from(buf.subarray(0, total));
  } finally {
    fs.closeSync(fd);
  }
  for (const link of chain) {
    const again = lstatOrNull(link.p);
    if (!again || !again.isDirectory() || !sameId(idOf(again), link.id)) throw failure('source-changed');
  }
  return data;
}

/** Read a supplied regular file root (canonical path from existingFile). */
export function readFileRoot(file: DirRoot, limit: number): Buffer {
  const parent = existingDir(path.dirname(file.path), 'source-missing');
  const data = readUnder(parent, path.basename(file.path), limit);
  const again = lstatOrNull(file.path);
  if (!again || !sameId(idOf(again), file.id)) throw failure('source-changed');
  return data;
}

/** Create one private (0700) directory; it must not exist. Parents are never created. */
export function mkdirPrivate(p: string): void {
  try {
    fs.mkdirSync(p, { mode: 0o700 });
  } catch (e) {
    if (errCode(e) === 'EEXIST') throw failure('output-exists');
    throw failure('write-failed');
  }
  const st = lstatOrNull(p);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw failure('write-failed');
}

/** Exclusively create a private (0600) file with the given bytes and fsync it. */
export function writeExclusive(p: string, bytes: Uint8Array): void {
  let fd: number;
  try {
    fd = fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  } catch (e) {
    if (errCode(e) === 'EEXIST') throw failure('output-exists');
    throw failure('write-failed');
  }
  try {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
  } catch {
    throw failure('write-failed');
  } finally {
    fs.closeSync(fd);
  }
}

/** fsync a directory so newly created entries are durable (best effort as Node allows). */
export function fsyncDir(p: string): void {
  let fd: number;
  try {
    fd = fs.openSync(p, O_RDONLY);
  } catch {
    throw failure('write-failed');
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    throw failure('write-failed');
  } finally {
    fs.closeSync(fd);
  }
}
