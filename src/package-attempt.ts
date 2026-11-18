/**
 * Pure private package-attempt and audit-ledger schemas for the reviewed D1
 * service. These values are evidence, never process ownership or stop proof.
 * No filesystem, executor, lock bypass or public command is implemented here.
 * Readers must separately bind the ledger to its proven transaction, outputs
 * and declarations. Serializers validate before returning canonical bytes.
 */
import { failure } from './errors.ts';
import { canonicalJson, isObject, parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';
import { MIB, TOOL_ID, npmIdentity, type Platform } from './schema.ts';
import type { DirId, FileId } from './transaction-fs.ts';

export const ATTEMPT_LIMIT = 4096;
export const LEDGER_LIMIT = MIB;
export const MAX_ATTEMPTS = 1024;
export const MAX_RUNS = 32;
export const ATTEMPT_KIND = 'pi-machine-config/package-attempt';
export const LEDGER_KIND = 'pi-machine-config/package-ledger';
const PHASES = ['intent', 'spawned', 'stopped-proven', 'config-verified'] as const;
const OUTCOMES = ['installed', 'exit-nonzero', 'signal', 'timeout', 'output-limit'] as const;
const ID = /^(0|[1-9][0-9]{0,19})$/;
const TX = /^[0-9a-f]{32}$/;
const TOKEN = /^sha256:[0-9a-f]{64}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Phase = typeof PHASES[number];
type OutcomeCode = typeof OUTCOMES[number];
export interface PackageOwner {
  pid: number; uid: number; hostname: string; bootId: string; platform: Platform;
}
export interface PackageExitFacts {
  code: number | null;
  signal: 'SIGTERM' | 'SIGKILL' | 'other' | null;
  stdoutBytes: number;
  stderrBytes: number;
}
export interface PackageExit extends PackageExitFacts { timedOut: boolean; overflow: boolean }
export interface AttemptOutcome { code: OutcomeCode; exit: PackageExitFacts }
export interface AttemptRecord {
  schemaVersion: 1; kind: typeof ATTEMPT_KIND; tool: string;
  tx: string; planToken: string; packageToken: string;
  seq: number; run: number; index: number; source: string;
  owner: PackageOwner;
  work: { name: string; id: DirId };
  phase: Phase;
  child: { pid: number; pgid: number } | null;
  exit: PackageExit | null;
}
export interface PackageRun {
  run: number; state: 'open' | 'closed'; packageToken: string;
  lock: FileId; owner: PackageOwner;
}
export interface LedgerAttempt {
  seq: number; run: number; index: number; source: string;
  work: { name: string; id: DirId | null };
  outcome: AttemptOutcome | null;
}
export interface PackageLedger {
  schemaVersion: 1; kind: typeof LEDGER_KIND; tool: string;
  tx: string; planToken: string; workParent: DirId;
  nextSeq: number; runs: PackageRun[]; attempts: LedgerAttempt[];
}

function bad(): never { throw failure('package-attempt-invalid'); }
function obj(v: unknown, keys: readonly string[]): JsonObject {
  if (!isObject(v)) bad();
  const own = Object.keys(v);
  if (own.length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) bad();
  return v;
}
function fresh<T extends object>(value: T): T { return Object.assign(Object.create(null), value); }
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) bad();
  return v;
}
function text(v: unknown, re: RegExp): string {
  if (typeof v !== 'string' || !re.test(v)) bad();
  return v;
}
function choice<T extends string>(v: unknown, choices: readonly T[]): T {
  if (typeof v !== 'string' || !choices.includes(v as T)) bad();
  return v as T;
}
function identity(v: unknown, file: false): DirId;
function identity(v: unknown, file: true): FileId;
function identity(v: unknown, file: boolean): DirId | FileId {
  const o = obj(v, file ? ['dev', 'ino', 'birthtimeNs', 'ctimeNs'] : ['dev', 'ino', 'birthtimeNs']);
  const out = fresh({ dev: text(o.dev, ID), ino: text(o.ino, ID), birthtimeNs: text(o.birthtimeNs, ID) });
  if (out.birthtimeNs === '0') bad();
  return file ? fresh({ ...out, ctimeNs: text(o.ctimeNs, ID) }) : out;
}
function owner(v: unknown): PackageOwner {
  const o = obj(v, ['pid', 'uid', 'hostname', 'bootId', 'platform']);
  return fresh({ pid: integer(o.pid, 2), uid: integer(o.uid, 0),
    hostname: text(o.hostname, /^[\x21-\x7e]{1,255}$/), bootId: text(o.bootId, BOOT),
    platform: choice(o.platform, ['darwin', 'linux'] as const) });
}
function exitFacts(v: unknown, diagnostic: false): PackageExitFacts;
function exitFacts(v: unknown, diagnostic: true): PackageExit;
function exitFacts(v: unknown, diagnostic: boolean): PackageExitFacts | PackageExit {
  const keys = ['code', 'signal', 'stdoutBytes', 'stderrBytes'];
  const o = obj(v, diagnostic ? [...keys, 'timedOut', 'overflow'] : keys);
  const rawCode = o.code, rawSignal = o.signal;
  const code = rawCode === null ? null : integer(rawCode, 0, 255);
  const signal = rawSignal === null ? null : choice(rawSignal, ['SIGTERM', 'SIGKILL', 'other'] as const);
  if ((code === null) === (signal === null)) bad();
  const out = fresh({ code, signal, stdoutBytes: integer(o.stdoutBytes, 0, MIB + 1), stderrBytes: integer(o.stderrBytes, 0, MIB + 1) });
  if (!diagnostic) return out;
  const timedOut = o.timedOut, overflow = o.overflow;
  if (typeof timedOut !== 'boolean' || typeof overflow !== 'boolean') bad();
  return fresh({ ...out, timedOut, overflow });
}
function workName(v: unknown, seq: number): string {
  return text(v, new RegExp(`^w${seq}-[0-9a-f]{16}$`));
}
function source(v: unknown): string { return npmIdentity(v, false); }

function attemptValue(v: unknown): AttemptRecord {
  const o = obj(v, ['schemaVersion', 'kind', 'tool', 'tx', 'planToken', 'packageToken', 'seq', 'run', 'index', 'source', 'owner', 'work', 'phase', 'child', 'exit']);
  if (o.schemaVersion !== 1 || o.kind !== ATTEMPT_KIND || o.tool !== TOOL_ID) bad();
  const seq = integer(o.seq, 0, MAX_ATTEMPTS - 1);
  const w = obj(o.work, ['name', 'id']);
  const phase = choice(o.phase, PHASES);
  let child: AttemptRecord['child'] = null;
  if (o.child !== null) {
    const c = obj(o.child, ['pid', 'pgid']);
    const pid = integer(c.pid, 2);
    if (c.pgid !== pid) bad();
    child = fresh({ pid, pgid: pid });
  }
  const exit = o.exit === null ? null : exitFacts(o.exit, true);
  if (phase === 'intent' ? child !== null || exit !== null : phase === 'spawned' ? child === null || exit !== null : child === null || exit === null) bad();
  return fresh({ schemaVersion: 1, kind: ATTEMPT_KIND, tool: TOOL_ID,
    tx: text(o.tx, TX), planToken: text(o.planToken, TOKEN), packageToken: text(o.packageToken, TOKEN),
    seq, run: integer(o.run, 0, MAX_RUNS - 1), index: integer(o.index, 0, 4095), source: source(o.source),
    owner: owner(o.owner), work: fresh({ name: workName(w.name, seq), id: identity(w.id, false) }), phase, child, exit });
}
function outcome(v: unknown): AttemptOutcome {
  const o = obj(v, ['code', 'exit']);
  const code = choice(o.code, OUTCOMES);
  const exit = exitFacts(o.exit, false);
  if (code === 'installed' && (exit.code !== 0 || exit.signal !== null)) bad();
  if (code === 'exit-nonzero' && (exit.code === null || exit.code === 0)) bad();
  if (code === 'signal' && exit.signal === null) bad();
  return fresh({ code, exit });
}
function ledgerValue(v: unknown): PackageLedger {
  const o = obj(v, ['schemaVersion', 'kind', 'tool', 'tx', 'planToken', 'workParent', 'nextSeq', 'runs', 'attempts']);
  if (o.schemaVersion !== 1 || o.kind !== LEDGER_KIND || o.tool !== TOOL_ID) bad();
  if (!Array.isArray(o.runs) || !Array.isArray(o.attempts) || o.runs.length > MAX_RUNS || o.attempts.length > MAX_ATTEMPTS) bad();
  const runs = Array.from(o.runs, (v, i): PackageRun => {
    const r = obj(v, ['run', 'state', 'packageToken', 'lock', 'owner']);
    if (r.run !== i) bad();
    const state = choice(r.state, ['open', 'closed'] as const);
    if (state === 'open' && i !== (o.runs as JsonValue[]).length - 1) bad();
    return fresh({ run: i, state, packageToken: text(r.packageToken, TOKEN), lock: identity(r.lock, true), owner: owner(r.owner) });
  });
  let previousRun = -1;
  let previousIndex = -1;
  let sources = new Set<string>();
  const attempts = Array.from(o.attempts, (v, i): LedgerAttempt => {
    const a = obj(v, ['seq', 'run', 'index', 'source', 'work', 'outcome']);
    if (a.seq !== i) bad();
    const run = integer(a.run, 0, runs.length - 1);
    if (run < previousRun) bad();
    if (run !== previousRun) { previousIndex = -1; sources = new Set(); }
    const index = integer(a.index, 0, 4095);
    const src = source(a.source);
    if (index <= previousIndex || sources.has(src)) bad();
    sources.add(src); previousRun = run; previousIndex = index;
    const w = obj(a.work, ['name', 'id']);
    const id = w.id === null ? null : identity(w.id, false);
    const result = a.outcome === null ? null : outcome(a.outcome);
    if (result === null ? i !== (o.attempts as JsonValue[]).length - 1 || runs[run].state !== 'open' : id === null) bad();
    return fresh({ seq: i, run, index, source: src, work: fresh({ name: workName(w.name, i), id }), outcome: result });
  });
  if (integer(o.nextSeq, 0, MAX_ATTEMPTS) !== attempts.length) bad();
  return fresh({ schemaVersion: 1, kind: LEDGER_KIND, tool: TOOL_ID,
    tx: text(o.tx, TX), planToken: text(o.planToken, TOKEN), workParent: identity(o.workParent, false),
    nextSeq: attempts.length, runs, attempts });
}

function canonicalData<T extends object>(v: T): string {
  // SAFETY: internal callers supply only validator-built JSON records or copies
  // with fields replaced by null; no undefined, bigint or executable values remain.
  return canonicalJson(v as unknown as JsonObject);
}
function bytesOf<T extends object>(v: T): Buffer { return Buffer.from(`${canonicalData(v)}\n`, 'utf8'); }
function parseBound<T>(bytes: Uint8Array, limit: number, code: string, validate: (v: unknown) => T): T {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length > limit) bad();
    return validate(parseJsonBytes(bytes));
  } catch { throw failure(code); }
}
function serializeBound<T extends object>(v: T, limit: number, code: string, validate: (v: unknown) => T): Buffer {
  try {
    const bytes = bytesOf(validate(v));
    if (bytes.length > limit) bad();
    return bytes;
  } catch { throw failure(code); }
}
export function parseAttempt(bytes: Uint8Array): AttemptRecord {
  return parseBound(bytes, ATTEMPT_LIMIT, 'package-attempt-invalid', attemptValue);
}
export function attemptBytes(record: AttemptRecord): Buffer {
  return serializeBound(record, ATTEMPT_LIMIT, 'package-attempt-invalid', attemptValue);
}
export function parseLedger(bytes: Uint8Array): PackageLedger {
  return parseBound(bytes, LEDGER_LIMIT, 'package-ledger-invalid', ledgerValue);
}
export function ledgerBytes(ledger: PackageLedger): Buffer {
  return serializeBound(ledger, LEDGER_LIMIT, 'package-ledger-invalid', ledgerValue);
}

/** Validate exactly one forward step; no byte/identity mutation authorizes process work. */
export function checkAdvance(prev: AttemptRecord, next: AttemptRecord): void {
  try {
    const p = parseAttempt(attemptBytes(prev));
    const n = parseAttempt(attemptBytes(next));
    if (PHASES.indexOf(n.phase) !== PHASES.indexOf(p.phase) + 1) bad();
    const stable = (r: AttemptRecord) => ({ ...r, phase: null, child: null, exit: null });
    if (canonicalData(stable(p)) !== canonicalData(stable(n))) bad();
    if (p.child !== null && (n.child === null || canonicalData(p.child) !== canonicalData(n.child))) bad();
    if (p.exit !== null && (n.exit === null || canonicalData(p.exit) !== canonicalData(n.exit))) bad();
  } catch { throw failure('package-attempt-transition'); }
}

/**
 * Diagnostic label only; never proof of process stop, safe cleanup or stream
 * budget enforcement. The trusted executor/service must enforce those gates.
 */
export function outcomeForExit(exit: PackageExit): AttemptOutcome {
  try {
    const e = exitFacts(exit, true);
    const code: OutcomeCode = e.overflow ? 'output-limit' : e.timedOut ? 'timeout' : e.signal !== null ? 'signal' : e.code !== 0 ? 'exit-nonzero' : 'installed';
    return outcome({ code, exit: { code: e.code, signal: e.signal, stdoutBytes: e.stdoutBytes, stderrBytes: e.stderrBytes } });
  } catch { throw failure('package-attempt-invalid'); }
}
