/**
 * Low-level filesystem and OS primitives for the restore transaction engine
 * (`transaction.ts`): owned-file identities, exclusive private creation,
 * no-replace hardlink publication, directory sync, atomic private JSON
 * replacement, lock records with stale-owner proof, and the bounded boot
 * identity probe.
 *
 * Identities are recorded as decimal strings of bigint `dev`, `ino`,
 * `ctimeNs` and `birthtimeNs`. An owned file needs a nonzero birthtime;
 * directories omit ctime, which changes with every entry they gain or lose.
 *
 * Every mutating primitive first calls `deps.fault(point)`, an internal test
 * seam that lets fixture tests inject a failure (or a concurrent action) at
 * an exact boundary. Production callers never set it: there is no command-line
 * option or environment variable for it. Any non-`ToolError` exception,
 * injected or real, becomes the primitive's fixed failure code, so no
 * exception text or path ever reaches a result.
 *
 * Node exposes no unlink-by-descriptor, so removal verifies the lstat
 * identity immediately before `unlink`; a same-user process racing that
 * window is outside the threat model.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError, failure } from './errors.ts';

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;

// ---------------------------------------------------------------- OS dependencies

/** Result of `kill(pid, 0)`: alive, no such process, not permitted, or anything else. */
export type PidProbe = 'alive' | 'esrch' | 'eperm' | 'unknown';

/**
 * Operating-system dependencies. `systemDeps()` supplies the real ones;
 * fixture tests replace individual members through the engine's internal
 * `deps` option, which no command-line path sets.
 */
export interface TxDeps {
  /** `process.platform`; the engine supports `darwin` and `linux`. */
  platform: string;
  /** Validated lowercase per-boot UUID, or null when unavailable. */
  bootId(): string | null;
  hostname(): string;
  uid(): number;
  pid(): number;
  probePid(pid: number): PidProbe;
  /** Lowercase hex from `bytes` random bytes. */
  randomHex(bytes: number): string;
  /** Internal test seam called before each mutating step. Throwing simulates a failure there. */
  fault(point: string): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate a boot identity probe result: one UUID, optional trailing newline, any case. */
export function parseBootId(raw: string): string | null {
  const s = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const lower = s.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

/** Linux: read at most 64 bytes of `/proc/sys/kernel/random/boot_id`. */
function linuxBootId(): string | null {
  let fd: number;
  try {
    fd = fs.openSync('/proc/sys/kernel/random/boot_id', O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    return parseBootId(buf.subarray(0, n).toString('latin1'));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * macOS: fixed-argv `/usr/sbin/sysctl -n kern.bootsessionuuid`, no shell, empty
 * environment, 2-second timeout, 256-byte output cap, stderr discarded.
 * Never falls back to `kern.boottime` or any clock.
 */
function darwinBootId(): string | null {
  try {
    const r = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      env: {},
      shell: false,
      timeout: 2000,
      killSignal: 'SIGKILL',
      maxBuffer: 256,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (r.error !== undefined || r.status !== 0 || !Buffer.isBuffer(r.stdout)) return null;
    return parseBootId(r.stdout.toString('latin1'));
  } catch {
    return null;
  }
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

export function systemDeps(): TxDeps {
  return {
    platform: process.platform,
    bootId: () => (process.platform === 'linux' ? linuxBootId() : process.platform === 'darwin' ? darwinBootId() : null),
    hostname: () => os.hostname(),
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    pid: () => process.pid,
    probePid: (pid: number): PidProbe => {
      // pid <= 1 would address a process group or init; never probe those.
      if (!Number.isSafeInteger(pid) || pid <= 1) return 'unknown';
      try {
        process.kill(pid, 0);
        return 'alive';
      } catch (e) {
        const c = errCode(e);
        return c === 'ESRCH' ? 'esrch' : c === 'EPERM' ? 'eperm' : 'unknown';
      }
    },
    randomHex: (bytes: number) => crypto.randomBytes(bytes).toString('hex'),
    fault: () => {},
  };
}

export function resolveDeps(over?: Partial<TxDeps>): TxDeps {
  return { ...systemDeps(), ...(over ?? {}) };
}

// ---------------------------------------------------------------- identities

export interface FileId {
  dev: string;
  ino: string;
  ctimeNs: string;
  birthtimeNs: string;
}

export interface DirId {
  dev: string;
  ino: string;
  birthtimeNs: string;
}

export function fileId(st: fs.BigIntStats): FileId {
  return { dev: st.dev.toString(), ino: st.ino.toString(), ctimeNs: st.ctimeNs.toString(), birthtimeNs: st.birthtimeNs.toString() };
}

export function dirId(st: fs.BigIntStats): DirId {
  return { dev: st.dev.toString(), ino: st.ino.toString(), birthtimeNs: st.birthtimeNs.toString() };
}

/** Same inode and birthtime; ctime too unless `ignoreCtime`. */
export function sameFile(st: fs.BigIntStats, id: FileId, ignoreCtime = false): boolean {
  return (
    st.dev.toString() === id.dev &&
    st.ino.toString() === id.ino &&
    st.birthtimeNs.toString() === id.birthtimeNs &&
    (ignoreCtime || st.ctimeNs.toString() === id.ctimeNs)
  );
}

export function sameDir(st: fs.BigIntStats, id: DirId): boolean {
  return st.isDirectory() && st.dev.toString() === id.dev && st.ino.toString() === id.ino && st.birthtimeNs.toString() === id.birthtimeNs;
}

/** lstat; null when absent. Other errors are `filesystem-error`. */
export function lstatOrNull(p: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return null;
    throw failure('filesystem-error');
  }
}

/** Run `fn`; any exception that is not a `ToolError` becomes `failure(code)`. */
export function guarded<T>(code: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw failure(code);
  }
}

// ---------------------------------------------------------------- reads

/**
 * Read a regular file without following symlinks when its lstat identity,
 * link count and size match expectations. Returns null for any mismatch,
 * absence or error: the caller treats that as unproven, never as permission.
 */
export function readProven(p: string, nlink: bigint, maxBytes: number): { st: fs.BigIntStats; bytes: Buffer } | null {
  let st: fs.BigIntStats | null;
  try {
    st = lstatOrNull(p);
  } catch {
    return null;
  }
  if (!st || !st.isFile() || st.nlink !== nlink || st.size > BigInt(maxBytes)) return null;
  let fd: number;
  try {
    fd = fs.openSync(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const fst = fs.fstatSync(fd, { bigint: true });
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino || fst.nlink !== nlink) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return null;
    }
    const again = lstatOrNull(p);
    if (!again || again.dev !== st.dev || again.ino !== st.ino || again.ctimeNs !== st.ctimeNs || again.nlink !== nlink) return null;
    return { st, bytes: Buffer.from(buf.subarray(0, total)) };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- writes

/**
 * Exclusively create a private (0600) file, write `bytes` and fsync it.
 * Fault points `<point>` (before open) and `<point>-sync` (after writing,
 * before fsync). Returns the descriptor's stats, or `exists` on EEXIST.
 */
export function createExclusive(deps: TxDeps, point: string, code: string, p: string, bytes: Uint8Array): fs.BigIntStats | 'exists' {
  return guarded(code, () => {
    deps.fault(point);
    let fd: number;
    try {
      fd = fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (e) {
      if (errCode(e) === 'EEXIST') return 'exists';
      throw e;
    }
    try {
      fs.fchmodSync(fd, 0o600);
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      deps.fault(`${point}-sync`);
      fs.fsyncSync(fd);
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n || st.size !== BigInt(bytes.length)) throw failure(code);
      return st;
    } finally {
      fs.closeSync(fd);
    }
  });
}

/** Create one private (0700) directory; never parents. Returns its lstat, or `exists`. */
export function mkdirExclusive(deps: TxDeps, point: string, code: string, p: string): fs.BigIntStats | 'exists' {
  return guarded(code, () => {
    deps.fault(point);
    try {
      fs.mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if (errCode(e) === 'EEXIST') return 'exists';
      throw e;
    }
    const st = lstatOrNull(p);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw failure(code);
    if ((st.mode & 0o777n) !== 0o700n) {
      fs.chmodSync(p, 0o700);
      const again = lstatOrNull(p);
      if (!again || !again.isDirectory() || again.ino !== st.ino) throw failure(code);
      return again;
    }
    return st;
  });
}

/** fsync a directory so entry creation/removal is durable as far as Node allows (no F_FULLFSYNC). */
export function syncDir(deps: TxDeps, point: string, code: string, p: string): void {
  guarded(code, () => {
    deps.fault(point);
    const fd = fs.openSync(p, O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
}

/** No-replace publication: hardlink `from` to `to`. Returns `exists` on EEXIST. */
export function linkNoReplace(deps: TxDeps, point: string, code: string, from: string, to: string): 'linked' | 'exists' {
  return guarded(code, () => {
    deps.fault(point);
    try {
      fs.linkSync(from, to);
    } catch (e) {
      if (errCode(e) === 'EEXIST') return 'exists';
      throw e;
    }
    return 'linked';
  });
}

/**
 * Unlink `p` only if its current lstat satisfies `proof`. Returns `absent`
 * when nothing is there and `mismatch` (nothing removed) when the proof fails.
 */
export function unlinkProven(
  deps: TxDeps,
  point: string,
  code: string,
  p: string,
  proof: (st: fs.BigIntStats) => boolean,
): 'removed' | 'absent' | 'mismatch' {
  return guarded(code, () => {
    const st = lstatOrNull(p);
    if (!st) return 'absent';
    if (st.isSymbolicLink() || !st.isFile() || !proof(st)) return 'mismatch';
    deps.fault(point);
    fs.unlinkSync(p);
    return 'removed';
  });
}

/**
 * Replace a private state file atomically: exclusive temporary file in the
 * same directory, fsync, rename over `name`, fsync the directory. Fault
 * points `journal-write`, `journal-write-sync`, `journal-rename`,
 * `journal-dirsync`; every failure is `journal-failed`.
 */
export function replaceFile(deps: TxDeps, dir: string, name: string, bytes: Uint8Array): void {
  const code = 'journal-failed';
  const tmpName = `${name}.tmp-${deps.randomHex(8)}`;
  if (!/^[a-z.]+\.tmp-[0-9a-f]{16}$/.test(tmpName)) throw failure(code);
  const tmp = path.join(dir, tmpName);
  const st = createExclusive(deps, 'journal-write', code, tmp, bytes);
  if (st === 'exists') throw failure(code);
  guarded(code, () => {
    deps.fault('journal-rename');
    fs.renameSync(tmp, path.join(dir, name));
  });
  syncDir(deps, 'journal-dirsync', code, dir);
}

// ---------------------------------------------------------------- lock records

export const LOCK_KIND = 'pi-machine-config/lock';
export type LockRole = 'state' | 'target' | 'gate';

export interface LockRecord {
  role: LockRole;
  tx: string;
  pid: number;
  uid: number;
  hostname: string | null;
  bootId: string | null;
  platform: string;
}

const HOST_RE = /^[\x21-\x7e]{1,255}$/;
export const TX_RE = /^[0-9a-f]{32}$/;

/** Validated hostname, or null when it cannot serve as owner proof. */
export function hostnameOf(deps: TxDeps): string | null {
  try {
    const h = deps.hostname();
    return typeof h === 'string' && HOST_RE.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** Validated boot identity, or null. Probe failures are never fatal. */
export function bootIdOf(deps: TxDeps): string | null {
  try {
    const b = deps.bootId();
    return typeof b === 'string' && UUID_RE.test(b) ? b : null;
  } catch {
    return null;
  }
}

export function makeLock(deps: TxDeps, role: LockRole, tx: string, bootId: string | null): LockRecord {
  return { role, tx, pid: deps.pid(), uid: deps.uid(), hostname: hostnameOf(deps), bootId, platform: deps.platform };
}

export function lockBytes(r: LockRecord): Buffer {
  // Fixed key order; values are validated scalars.
  const doc = { schemaVersion: 1, kind: LOCK_KIND, role: r.role, tx: r.tx, pid: r.pid, uid: r.uid, hostname: r.hostname, bootId: r.bootId, platform: r.platform };
  return Buffer.from(`${JSON.stringify(doc)}\n`, 'utf8');
}

function plainRecord(v: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  // SAFETY: a non-null, non-array object; only own enumerable keys are inspected below.
  const o = v as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return null;
  return o;
}

const RECORD_KEYS = ['role', 'tx', 'pid', 'uid', 'hostname', 'bootId', 'platform'] as const;

/** Strictly validate a parsed lock document (with its kind and schema version); null when invalid. */
export function parseLock(v: unknown): LockRecord | null {
  const o = plainRecord(v, ['schemaVersion', 'kind', ...RECORD_KEYS]);
  if (o === null || o.schemaVersion !== 1 || o.kind !== LOCK_KIND) return null;
  const rec = Object.create(null) as Record<string, unknown>;
  for (const k of RECORD_KEYS) rec[k] = o[k];
  return parseLockRecord(rec);
}

/** Strictly validate a bare lock record (as archived in a journal); null when invalid. */
export function parseLockRecord(v: unknown): LockRecord | null {
  const o = plainRecord(v, RECORD_KEYS);
  if (o === null) return null;
  if (o.role !== 'state' && o.role !== 'target' && o.role !== 'gate') return null;
  if (typeof o.tx !== 'string' || !TX_RE.test(o.tx)) return null;
  if (typeof o.pid !== 'number' || !Number.isSafeInteger(o.pid) || o.pid < 1) return null;
  if (typeof o.uid !== 'number' || !Number.isSafeInteger(o.uid) || o.uid < -1) return null;
  if (o.hostname !== null && (typeof o.hostname !== 'string' || !HOST_RE.test(o.hostname))) return null;
  if (o.bootId !== null && (typeof o.bootId !== 'string' || !UUID_RE.test(o.bootId))) return null;
  if (typeof o.platform !== 'string' || !/^[a-z0-9]{1,32}$/.test(o.platform)) return null;
  return { role: o.role, tx: o.tx, pid: o.pid, uid: o.uid, hostname: o.hostname, bootId: o.bootId, platform: o.platform };
}

export type LockVerdict = { stale: true } | { stale: false; reason: string };

/**
 * Stale-owner proof. Stale only on the same host and UID with either a
 * different valid boot identity, or the same boot identity and
 * `kill(pid, 0)` = ESRCH. Unavailable boot identity, a changed or
 * unavailable hostname, another UID, a live PID, EPERM or any other probe
 * result is not proof. Wall-clock time is never consulted.
 */
export function judgeLock(r: LockRecord, deps: TxDeps, bootNow: string | null): LockVerdict {
  const host = hostnameOf(deps);
  if (r.hostname === null || host === null) return { stale: false, reason: 'hostname-unavailable' };
  if (r.hostname !== host) return { stale: false, reason: 'other-host' };
  if (r.uid !== deps.uid() || r.uid < 0) return { stale: false, reason: 'other-user' };
  if (r.bootId === null || bootNow === null) return { stale: false, reason: 'boot-identity-unavailable' };
  if (r.bootId !== bootNow) return { stale: true };
  const probe = deps.probePid(r.pid);
  if (probe === 'esrch') return { stale: true };
  return { stale: false, reason: probe === 'alive' ? 'owner-alive' : 'owner-unprovable' };
}
