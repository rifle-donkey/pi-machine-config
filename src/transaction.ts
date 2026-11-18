/**
 * Fresh-restore filesystem transaction engine. The apply command reaches it
 * only through restoreFromPlan's ready-plan and locked-token gate. The raw
 * packet API remains a trusted-caller interface, not an authorization boundary.
 * State commands supply expectedTargets to bind the journal before target access.
 *
 * Caller contract (later CLI integration): build a `RestorePacket` only from
 * a complete, verified bundle and plan whose status is `ready`, after the
 * operator's `--approve-activation` token has been recomputed and matched;
 * `incomplete` and `conflict` plans never produce a packet. The engine
 * independently revalidates everything it writes (allowlisted settings,
 * unversioned registry package declarations, closed file classes and
 * destinations, content rules, rendered digests, sizes), enforces the
 * filesystem boundaries (live-path guard, absent targets with existing
 * parents, case/NFC aliases, disjoint state/targets/protected roots) and the
 * one-transaction protocol below. It never invokes Pi, a package manager or
 * the network; the only subprocess is the bounded macOS boot identity probe.
 *
 * Apply protocol (one state directory binds exactly one restore):
 * 1. Validate the complete packet and the worst-case size of every journal
 *    this transaction can ever write (<= 1 MiB) before any filesystem write.
 * 2. Exclusively create the private state directory (0700), sync its parent,
 *    exclusively create the state lock, run any trusted locked-intent verifier,
 *    then write the first journal. A verifier mismatch creates no target output.
 * 3. Under the lock, recheck absent targets; journal root intent; exclusively
 *    mkdir the agent root (EEXIST is `not-created`, never ownership); sync its
 *    parent; journal the root identity. Create the reserved target lock
 *    `.pi-machine-config-lock` the same way, then the managed descendant
 *    directories (intent, mkdir, identities).
 * 4. Per output: journal `staging`; exclusively create a dot-prefixed,
 *    suffix-free stage (`.pi-machine-config-stage-<hex>`) in the destination
 *    directory, write a private copy of the bytes, fsync; sync the directory;
 *    journal `prepared` with the stage identity; hardlink stage to the
 *    destination (no replace; EEXIST journals `not-created` and stops); sync;
 *    journal `published`; unlink the stage after an identity check; sync;
 *    re-read the destination and journal `applied` with its final identity.
 * 5. Release the target lock, journal `applied`, release the state lock.
 * Journal updates are exclusive temporary file + fsync + rename + directory
 * fsync. A failed step stops the transaction: no payload follows a failed
 * journal or sync; locks this process holds are released when their identity
 * is still proven, and everything else is left for explicit recovery.
 *
 * Identities are dev/ino/ctimeNs/nonzero birthtimeNs decimal strings. A link
 * count of 2 is accepted only for the journaled stage/destination pair with
 * matching bytes; ctime may differ only for a `prepared` pair (the accounted
 * link transition). Any other gap (for example a crash after unlinking the
 * stage but before `applied` was journaled, or after the root mkdir but before
 * its identity was journaled) is classified `conflict`: the files are
 * preserved, never adopted from bytes alone.
 *
 * Recovery classes (`inspectRestore`) and the explicit actions
 * `resolveRestore` accepts for them:
 * | Class | Meaning | Action |
 * | `gate-stale`/`lock-stale` | lock owner proven gone | `release-gate`/`release-lock` |
 * | `gate-held`/`lock-held` | live, foreign or unprovable owner | none |
 * | `unfinished` | interrupted; only untouched, staged, unpublished or not-created outputs | `abandon` |
 * | `published-unfinished` | a proven stage/destination pair | `finalize` (then `rollback` if wanted) |
 * | `unfinalized` | every output applied, final status not journaled | `finalize` |
 * | `applied`/`partial` | outputs proven unchanged | `rollback` |
 * | `rollback-pending` | rollback interrupted | `rollback` |
 * | `conflict` | changed, missing or unproven output or root | `record-conflict` |
 * | `rolled-back`/`closed`/`preserved` | terminal | none |
 * | `corrupt` | unreadable, unsafe or inconsistent state, or unresolved package attempt | none (manual) |
 * Ordinary state operations treat `package-attempt.json` as metadata-only
 * exclusion before journal/target reads or stale-lock probes. They never open
 * or remove it. Recognizable package-kind locks and unresolved ledgers also
 * exclude recovery without PID/boot stale release. Corrupt results have
 * unobserved lock fields, not proof that locks are absent.
 *
 * `runPackageAttempts` is a trusted fixture-only async service. The production
 * executor is null and refuses before filesystem access. Its unexported exact
 * file identities authorize only its own analysis, never ordinary recovery.
 * It persists an audit sequence before work/spawn and completion before gate
 * removal. After non-lock writes start, failures retain surviving exclusion;
 * only proven stop, unchanged configuration and durable cleanup permit normal
 * lock release. Final lock-unlink/sync failure has the reviewed point-in-time
 * completion exception. No CLI, executable approval or missing-only production
 * selection is implemented. Diagnostic labels never authorize process cleanup.
 * Reason `journal-missing` means the failure preceded the first journal write,
 * so no target was created (root creation always follows a durable intent).
 * A `rollback-pending` transaction whose remaining outputs are absent is
 * completed by the same `rollback` action.
 * Rollback treats all outputs of the transaction as one dependency group: it
 * preflights every applied output and removes nothing if any member is
 * changed. It unlinks only proven unchanged files after a durable intent,
 * never directories, packages or runtime files, and a repeated rollback never
 * touches replacements. Locks record transaction, PID, UID, hostname and
 * boot identity; stale proof is described at `judgeLock`.
 *
 * Not claimed: resistance to a same-user process that forges state or races
 * pathnames, macOS F_FULLFSYNC power-loss durability, or remote filesystems.
 * The `deps` option (OS probes and the `fault` hook) and `guard` are internal
 * test seams; no command-line option or environment variable sets them.
 *
 * Fault points (in order of use): state-mkdir, state-parent-sync,
 * lock-create(-sync), lock-dirsync, journal-write(-sync), journal-rename,
 * journal-dirsync, root-mkdir, root-parent-sync, target-lock-create(-sync),
 * target-lock-dirsync, dir-mkdir, dir-sync, stage-create(-sync),
 * stage-dirsync, link, link-dirsync, unstage, unstage-dirsync,
 * target-lock-release(-sync), lock-release(-sync), rollback-unlink,
 * rollback-dirsync, abandon-unlink, abandon-dirsync, gate-create(-sync),
 * gate-dirsync, stale-unlink, stale-dirsync, gate-release(-sync).
 * Package-only points: pkglock-create(-sync), pkglock-dirsync,
 * work-root-mkdir, work-root-sync, ledger-write(-sync), ledger-rename,
 * ledger-dirsync, work-mkdir, work-file(-sync), work-dirsync,
 * attempt-create(-sync), attempt-dirsync, attempt-write(-sync),
 * attempt-rename, attempt-rename-dirsync, attempt-unlink,
 * attempt-unlink-dirsync, pkglock-release(-sync). Replacement points repeat
 * for each phase; a pre-operation fault event is not successful durability.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTokenSyntax } from './approval.ts';
import { renderSettings } from './settings-output.ts';
import {
  ATTEMPT_KIND, LEDGER_KIND, LEDGER_LIMIT, MAX_ATTEMPTS, MAX_RUNS,
  attemptBytes, checkAdvance, ledgerBytes, outcomeForExit, parseAttempt, parseLedger,
  type AttemptRecord, type PackageLedger, type PackageOwner, type PackageExit,
} from './package-attempt.ts';
import { ToolError, failure, invalid } from './errors.ts';
import {
  absentTarget,
  existingDir,
  fold,
  guardLiveLexical,
  hasSiblingAlias,
  liveLocations,
  overlaps,
  requireAbsolute,
  type AbsentTarget,
  type GuardContext,
} from './fsafe.ts';
import { canonicalJson, isObject, parseJsonBytes, prettyJson, type JsonObject, type JsonValue } from './json.ts';
import {
  LIMITS,
  MIB,
  TOOL_ID,
  checkContent,
  checkPlacement,
  checkProhibited,
  packageDecl,
  packageIdentity,
  relPath,
  settingValue,
  sha256Hex,
  type FileClass,
  type FileRoot,
  type PackageDecl,
  type Platform,
} from './schema.ts';
import {
  TX_RE,
  bootIdOf,
  createExclusive,
  dirId,
  fileId,
  guarded,
  judgeLock,
  linkNoReplace,
  hostnameOf,
  lockBytes,
  lstatOrNull,
  makeLock,
  mkdirExclusive,
  parseLock,
  parseLockRecord,
  readProven,
  replaceFile,
  replacePrivate,
  resolveDeps,
  sameDir,
  sameFile,
  syncDir,
  unlinkProven,
  type DirId,
  type FileId,
  type LockRecord,
  type LockRole,
  type TxDeps,
} from './transaction-fs.ts';

// ---------------------------------------------------------------- public types

/** One rendered file of a validated, approved plan. */
export interface PacketFile {
  root: FileRoot;
  /** Approved relative path (`config.json` for the lens target). */
  path: string;
  class: FileClass;
  /** Rendered bytes; copied before validation, so later caller mutation has no effect. */
  bytes: Uint8Array;
  /** Rendered SHA-256 (64 lowercase hex) that the activation plan token covered. */
  sha256: string;
}

/** A complete restore the caller has already validated and the operator has approved. */
export interface RestorePacket {
  /** The matched activation plan token, recorded in the journal. */
  planToken: string;
  /** Must equal the running platform. */
  platform: Platform;
  /** New private state directory: absent, parent existing. */
  state: string;
  /** New agent directory: absent, parent existing. */
  agentTarget: string;
  /** New lens configuration file, exactly when a `lens-config` file is present. */
  lensTarget: string | null;
  /** Merged allowlisted settings (never `packages`). */
  settings: JsonObject;
  /** Ordered unversioned registry declarations, written as settings `packages`. */
  packages: PackageDecl[];
  files: PacketFile[];
  /** Existing roots (bundle, overlay) the state and targets must stay apart from. The tool checkout is always added. */
  protectedRoots: string[];
}

export interface RestoreTargets {
  agent: string;
  lens: string | null;
}

export interface TxOptions {
  env?: Record<string, string | undefined>;
  /** Internal test seam for the live-path guard; see `GuardContext`. */
  guard?: GuardContext;
  /** Internal test seam for OS probes and fault injection; never set by a command. */
  deps?: Partial<TxDeps>;
  /** Trusted integration verifier: recompute the plan token under the state lock, before journal/target writes. */
  verifyLockedIntent?: () => string;
  /** Existing-transaction context supplied by the CLI; checked before any target access. */
  expectedTargets?: RestoreTargets;
}

export interface ApplyResult {
  tx: string;
  status: 'applied';
  outputs: number;
  directories: number;
  warnings: string[];
}

export const TX_CLASSES = [
  'corrupt',
  'gate-held',
  'gate-stale',
  'lock-held',
  'lock-stale',
  'conflict',
  'rollback-pending',
  'published-unfinished',
  'unfinished',
  'unfinalized',
  'applied',
  'partial',
  'rolled-back',
  'closed',
  'preserved',
] as const;
export type TxClass = (typeof TX_CLASSES)[number];

export const TX_ACTIONS = ['release-gate', 'release-lock', 'abandon', 'finalize', 'rollback', 'record-conflict'] as const;
export type TxAction = (typeof TX_ACTIONS)[number];

export type LockState = 'absent' | 'held' | 'stale' | 'unproven';

export interface InspectItem {
  kind: 'root' | 'output';
  root?: FileRoot;
  path?: string;
  class?: OutputClass;
  phase: string;
  observed: string;
  note?: string;
}

export interface InspectResult {
  tx: string | null;
  status: string | null;
  class: TxClass;
  actions: TxAction[];
  /** Fixed code explaining `corrupt`, `*-held` or `conflict`. */
  reason: string | null;
  locks: { state: LockState; target: LockState; gate: LockState };
  items: InspectItem[];
  warnings: string[];
}

export interface ResolveRequest {
  tx: string;
  expect: string;
  action: string;
}

export interface ResolveResult {
  tx: string;
  action: TxAction;
  class: TxClass;
  removed: number;
}

export interface RollbackResult {
  tx: string;
  status: 'rolled-back';
  removed: number;
}

// ---------------------------------------------------------------- journal model

export const JOURNAL_KIND = 'pi-machine-config/restore-journal';
const JOURNAL_NAME = 'journal.json';
const LOCK_NAME = 'lock.json';
const GATE_NAME = 'recovery-gate.json';
const ATTEMPT_NAME = 'package-attempt.json';
const LEDGER_NAME = 'package-ledger.json';
const WORK_NAME = 'package-work';
const PACKAGE_LOCK_KIND = 'pi-machine-config/package-lock';
const LEDGER_TMP_RE = /^package-ledger\.json\.tmp-[0-9a-f]{16}$/;
const TMP_RE = /^journal\.json\.tmp-[0-9a-f]{16}$/;
const TARGET_LOCK_NAME = '.pi-machine-config-lock';
const STAGE_PREFIX = '.pi-machine-config-stage-';
const STAGE_RE = /^\.pi-machine-config-stage-[0-9a-f]{32}$/;
const SETTINGS_PATH = 'settings.json';
const LOCK_LIMIT = 4096;
const MAX_STATE_ENTRIES = 64;
const MAX_RESOLUTIONS = 32;
const MAX_OUTPUTS = 4096;
const ID_RE = /^(0|[1-9][0-9]{0,19})$/;

type OutputClass = FileClass | 'settings';
const OUTPUT_CLASSES: readonly OutputClass[] = [
  'agent-context',
  'extension-source',
  'skill-source',
  'prompt',
  'theme',
  'tool-config',
  'external-config',
  'settings',
];
const STATUSES = ['applying', 'applied', 'partial', 'rollback-pending', 'rolled-back', 'closed', 'preserved'] as const;
type TxStatus = (typeof STATUSES)[number];
const ROOT_PHASES = ['pending', 'intent', 'created', 'not-created', 'conflict'] as const;
type RootPhase = (typeof ROOT_PHASES)[number];
const TLOCK_PHASES = ['pending', 'intent', 'held', 'released'] as const;
type TLockPhase = (typeof TLOCK_PHASES)[number];
const DIR_PHASES = ['pending', 'intent', 'created', 'not-created'] as const;
type DirPhase = (typeof DIR_PHASES)[number];
const OUTPUT_PHASES = [
  'pending',
  'staging',
  'prepared',
  'published',
  'applied',
  'not-created',
  'abandoned',
  'rollback-pending',
  'rolled-back',
  'conflict',
] as const;
type OutputPhase = (typeof OUTPUT_PHASES)[number];
const NOTES = [
  'destination-exists',
  'never-staged',
  'orphan-preserved',
  'stage-absent',
  'stage-removed',
  'already-absent',
  'removed',
  'parent-changed',
  'identity-unproven',
  'output-missing',
  'output-changed',
  'observe-failed',
  'root-unproven',
  'root-changed',
] as const;
type Note = (typeof NOTES)[number];

interface DirEntry {
  path: string;
  phase: DirPhase;
  id: DirId | null;
}

interface OutputEntry {
  root: FileRoot;
  path: string;
  class: OutputClass;
  bytes: number;
  sha256: string;
  stage: string;
  phase: OutputPhase;
  stageId: FileId | null;
  targetId: FileId | null;
  note: Note | null;
}

interface Resolution {
  action: TxAction;
  class: TxClass;
  locks: LockRecord[];
}

interface Journal {
  schemaVersion: 1;
  kind: string;
  tool: string;
  tx: string;
  planToken: string;
  platform: Platform;
  status: TxStatus;
  targets: { agent: string; agentParent: DirId; lens: string | null; lensParent: DirId | null };
  root: { phase: RootPhase; id: DirId | null };
  targetLock: { phase: TLockPhase; id: FileId | null };
  dirs: DirEntry[];
  outputs: OutputEntry[];
  resolutions: Resolution[];
}

function journalText(j: Journal): string {
  // SAFETY: Journal holds only strings, safe integers, null, arrays and plain objects.
  return `${canonicalJson(j as unknown as JsonValue)}\n`;
}

function journalBytes(j: Journal): Buffer {
  const b = Buffer.from(journalText(j), 'utf8');
  if (b.length > MIB) throw failure('journal-too-large');
  return b;
}

function longest<T extends string>(xs: readonly T[]): T {
  return xs.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * The largest journal this transaction can ever write: every identity at
 * maximum length, the longest phases and notes, and a full resolution log.
 */
function worstCaseJournal(j: Journal): Journal {
  const n = '9'.repeat(20);
  const fid: FileId = { dev: n, ino: n, ctimeNs: n, birthtimeNs: n };
  const did: DirId = { dev: n, ino: n, birthtimeNs: n };
  const lock: LockRecord = {
    role: 'target',
    tx: 'f'.repeat(32),
    pid: Number.MAX_SAFE_INTEGER,
    uid: Number.MAX_SAFE_INTEGER,
    hostname: '~'.repeat(255),
    bootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    platform: 'x'.repeat(32),
  };
  return {
    ...j,
    status: longest(STATUSES),
    root: { phase: longest(ROOT_PHASES), id: did },
    targetLock: { phase: longest(TLOCK_PHASES), id: fid },
    dirs: j.dirs.map((d) => ({ path: d.path, phase: longest(DIR_PHASES), id: did })),
    outputs: j.outputs.map((o) => ({ ...o, phase: longest(OUTPUT_PHASES), stageId: fid, targetId: fid, note: longest(NOTES) })),
    resolutions: Array.from({ length: MAX_RESOLUTIONS }, () => ({
      action: longest(TX_ACTIONS),
      class: longest(TX_CLASSES),
      locks: [lock, lock],
    })),
  };
}

// ---------------------------------------------------------------- journal parsing

function corrupt(): never {
  throw failure('state-corrupt');
}

function keysExactly(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(v)) corrupt();
  const o = v as Record<string, unknown>;
  const ks = Object.keys(o);
  if (ks.length !== keys.length || !keys.every((k) => ks.includes(k))) corrupt();
  return o;
}

function oneOf<T extends string>(v: unknown, xs: readonly T[]): T {
  if (typeof v !== 'string' || !(xs as readonly string[]).includes(v)) corrupt();
  return v as T;
}

function idString(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) corrupt();
  return v;
}

function parseFileId(v: unknown): FileId | null {
  if (v === null) return null;
  const o = keysExactly(v, ['dev', 'ino', 'ctimeNs', 'birthtimeNs']);
  return { dev: idString(o.dev), ino: idString(o.ino), ctimeNs: idString(o.ctimeNs), birthtimeNs: idString(o.birthtimeNs) };
}

function parseDirId(v: unknown): DirId | null {
  if (v === null) return null;
  const o = keysExactly(v, ['dev', 'ino', 'birthtimeNs']);
  return { dev: idString(o.dev), ino: idString(o.ino), birthtimeNs: idString(o.birthtimeNs) };
}

function absPath(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || v.includes('\0') || !path.isAbsolute(v) || path.resolve(v) !== v) {
    corrupt();
  }
  return v;
}

/** Closed (root, path, class) destinations; `settings.json` is the engine's own settings output. */
function checkDestination(root: FileRoot, p: string, cls: OutputClass): void {
  if (cls === 'settings') {
    if (root !== 'agent' || p !== SETTINGS_PATH) throw invalid('destination-not-allowed');
    return;
  }
  relPath(p);
  checkProhibited(root, p, cls);
  const layer = root === 'agent' && cls === 'tool-config' && p === 'sandbox.json' ? 'overlay' : 'common';
  checkPlacement(root, p, cls, layer);
}

const STATUS_PHASES: Record<TxStatus, readonly OutputPhase[]> = {
  applying: ['pending', 'staging', 'prepared', 'published', 'applied', 'not-created'],
  applied: ['applied'],
  partial: ['applied', 'abandoned', 'not-created'],
  'rollback-pending': ['rollback-pending', 'rolled-back', 'abandoned', 'not-created'],
  'rolled-back': ['rolled-back', 'abandoned', 'not-created'],
  closed: ['abandoned', 'not-created'],
  preserved: OUTPUT_PHASES,
};
const NEEDS_ROOT: ReadonlySet<OutputPhase> = new Set(['staging', 'prepared', 'published', 'applied', 'not-created', 'rollback-pending', 'rolled-back']);
const NEEDS_STAGE_ID: ReadonlySet<OutputPhase> = new Set(['prepared', 'not-created', 'published', 'applied', 'rollback-pending', 'rolled-back']);
const NEEDS_TARGET_ID: ReadonlySet<OutputPhase> = new Set(['published', 'applied', 'rollback-pending', 'rolled-back']);

function parseOutput(v: unknown): OutputEntry {
  const o = keysExactly(v, ['root', 'path', 'class', 'bytes', 'sha256', 'stage', 'phase', 'stageId', 'targetId', 'note']);
  const root = oneOf(o.root, ['agent', 'lens-config'] as const);
  const cls = oneOf(o.class, OUTPUT_CLASSES);
  if (typeof o.path !== 'string') corrupt();
  try {
    checkDestination(root, o.path, cls);
  } catch {
    corrupt();
  }
  if (typeof o.bytes !== 'number' || !Number.isSafeInteger(o.bytes) || o.bytes < 0 || o.bytes > MIB) corrupt();
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) corrupt();
  if (typeof o.stage !== 'string' || !STAGE_RE.test(o.stage)) corrupt();
  const phase = oneOf(o.phase, OUTPUT_PHASES);
  const stageId = parseFileId(o.stageId);
  const targetId = parseFileId(o.targetId);
  const note = o.note === null ? null : oneOf(o.note, NOTES);
  if (phase !== 'abandoned' && phase !== 'conflict') {
    if (NEEDS_STAGE_ID.has(phase) !== (stageId !== null)) corrupt();
    if (NEEDS_TARGET_ID.has(phase) !== (targetId !== null)) corrupt();
  }
  return { root, path: o.path, class: cls, bytes: o.bytes, sha256: o.sha256, stage: o.stage, phase, stageId, targetId, note };
}

/** Strictly parse and cross-check a journal; any defect is `state-corrupt`. */
function parseJournal(bytes: Uint8Array): Journal {
  let v: unknown;
  try {
    v = parseJsonBytes(bytes);
  } catch {
    corrupt();
  }
  const o = keysExactly(v, [
    'schemaVersion',
    'kind',
    'tool',
    'tx',
    'planToken',
    'platform',
    'status',
    'targets',
    'root',
    'targetLock',
    'dirs',
    'outputs',
    'resolutions',
  ]);
  if (o.schemaVersion !== 1 || o.kind !== JOURNAL_KIND) corrupt();
  if (typeof o.tool !== 'string' || !/^pi-machine-config@[0-9A-Za-z.+-]{1,64}$/.test(o.tool)) corrupt();
  if (typeof o.tx !== 'string' || !TX_RE.test(o.tx)) corrupt();
  if (!isTokenSyntax(o.planToken)) corrupt();
  const platform = oneOf(o.platform, ['darwin', 'linux'] as const);
  const status = oneOf(o.status, STATUSES);
  const t = keysExactly(o.targets, ['agent', 'agentParent', 'lens', 'lensParent']);
  const agentParent = parseDirId(t.agentParent);
  if (agentParent === null) corrupt();
  const targets = {
    agent: absPath(t.agent),
    agentParent,
    lens: t.lens === null ? null : absPath(t.lens),
    lensParent: parseDirId(t.lensParent),
  };
  if ((targets.lens === null) !== (targets.lensParent === null)) corrupt();
  if (targets.lens !== null && overlaps(targets.agent, targets.lens)) corrupt();
  const r = keysExactly(o.root, ['phase', 'id']);
  const root = { phase: oneOf(r.phase, ROOT_PHASES), id: parseDirId(r.id) };
  if ((root.phase === 'created') !== (root.id !== null) && root.phase !== 'conflict') corrupt();
  const tl = keysExactly(o.targetLock, ['phase', 'id']);
  const targetLock = { phase: oneOf(tl.phase, TLOCK_PHASES), id: parseFileId(tl.id) };
  if (targetLock.phase === 'held' && targetLock.id === null) corrupt();
  if (!Array.isArray(o.dirs) || o.dirs.length > MAX_OUTPUTS * LIMITS.pathDepth) corrupt();
  const dirs: DirEntry[] = o.dirs.map((d) => {
    const e = keysExactly(d, ['path', 'phase', 'id']);
    if (typeof e.path !== 'string') corrupt();
    try {
      relPath(e.path);
    } catch {
      corrupt();
    }
    const phase = oneOf(e.phase, DIR_PHASES);
    const id = parseDirId(e.id);
    if ((phase === 'created') !== (id !== null)) corrupt();
    return { path: e.path, phase, id };
  });
  if (new Set(dirs.map((d) => fold(d.path))).size !== dirs.length) corrupt();
  if (!Array.isArray(o.outputs) || o.outputs.length === 0 || o.outputs.length > MAX_OUTPUTS) corrupt();
  const outputs = o.outputs.map(parseOutput);
  if (new Set(outputs.map((x) => fold(`${x.root}:${x.path}`))).size !== outputs.length) corrupt();
  if (new Set(outputs.map((x) => x.stage)).size !== outputs.length) corrupt();
  const allowed = STATUS_PHASES[status];
  for (const x of outputs) {
    if (!allowed.includes(x.phase)) corrupt();
    if (NEEDS_ROOT.has(x.phase) && root.phase !== 'created' && root.phase !== 'conflict') corrupt();
    if (x.root === 'lens-config' && targets.lens === null) corrupt();
    if (x.root === 'agent') {
      const parts = x.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (!dirs.some((d) => d.path === parts.slice(0, i).join('/'))) corrupt();
      }
    }
  }
  if (root.phase === 'conflict' && status !== 'preserved') corrupt();
  if (!Array.isArray(o.resolutions) || o.resolutions.length > MAX_RESOLUTIONS) corrupt();
  const resolutions: Resolution[] = o.resolutions.map((x) => {
    const e = keysExactly(x, ['action', 'class', 'locks']);
    if (!Array.isArray(e.locks) || e.locks.length > 2) corrupt();
    const locks = e.locks.map((l) => parseLockRecord(l) ?? corrupt());
    return { action: oneOf(e.action, TX_ACTIONS), class: oneOf(e.class, TX_CLASSES), locks };
  });
  return {
    schemaVersion: 1,
    kind: JOURNAL_KIND,
    tool: o.tool,
    tx: o.tx,
    planToken: o.planToken,
    platform,
    status,
    targets,
    root,
    targetLock,
    dirs,
    outputs,
    resolutions,
  };
}

// ---------------------------------------------------------------- packet validation

interface ValidPacket {
  outputs: { entry: Omit<OutputEntry, 'stage'>; bytes: Buffer }[];
  dirs: string[];
  hasLens: boolean;
}

function copyBytes(v: unknown): Buffer {
  if (!(v instanceof Uint8Array)) throw invalid('packet-invalid');
  if (v.length > LIMITS.fileBytes) throw invalid('file-too-large');
  const b = Buffer.alloc(v.length);
  b.set(v);
  return b;
}

/** Revalidate the whole packet in memory; nothing touches the filesystem. */
function validatePacket(p: RestorePacket): ValidPacket {
  if (!isObject(p as unknown)) throw invalid('packet-invalid');
  if (!isTokenSyntax(p.planToken)) throw invalid('approval-token-invalid');
  if (p.platform !== 'darwin' && p.platform !== 'linux') throw invalid('packet-invalid');
  if (!isObject(p.settings) || !Array.isArray(p.packages) || !Array.isArray(p.files) || !Array.isArray(p.protectedRoots)) {
    throw invalid('packet-invalid');
  }
  if (p.files.length > MAX_OUTPUTS || p.packages.length > LIMITS.arrayItems || p.protectedRoots.length > 16) throw invalid('packet-invalid');

  const outputs: ValidPacket['outputs'] = [];
  const seen = new Map<string, string>();
  let total = 0;
  let hasLens = false;
  for (const f of p.files) {
    if (!isObject(f as unknown)) throw invalid('packet-invalid');
    if (f.root !== 'agent' && f.root !== 'lens-config') throw invalid('destination-not-allowed');
    if (typeof f.path !== 'string' || typeof f.class !== 'string' || !OUTPUT_CLASSES.includes(f.class) || f.class === ('settings' as string)) {
      throw invalid('destination-not-allowed');
    }
    checkDestination(f.root, f.path, f.class);
    const bytes = copyBytes(f.bytes);
    checkContent({ class: f.class, template: false }, bytes);
    const digest = sha256Hex(bytes);
    if (typeof f.sha256 !== 'string' || f.sha256 !== digest) throw invalid('packet-digest-mismatch');
    const key = `${f.root}:${f.path}`;
    const prev = seen.get(fold(key));
    if (prev !== undefined) throw invalid(prev === key ? 'file-duplicate' : 'path-alias');
    seen.set(fold(key), key);
    total += bytes.length;
    if (total > LIMITS.totalBytes) throw invalid('bundle-too-large');
    if (f.root === 'lens-config') hasLens = true;
    outputs.push({
      entry: { root: f.root, path: f.path, class: f.class, bytes: bytes.length, sha256: digest, phase: 'pending', stageId: null, targetId: null, note: null },
      bytes,
    });
  }

  const settings = Object.create(null) as JsonObject;
  for (const k of Object.keys(p.settings)) settings[k] = settingValue(k, p.settings[k]);
  const packages: PackageDecl[] = [];
  const ids = new Set<string>();
  for (const d of p.packages) {
    const decl = packageDecl(d, false);
    if (ids.has(packageIdentity(decl))) throw invalid('package-duplicate');
    ids.add(packageIdentity(decl));
    packages.push(decl);
  }
  const settingsBytes = renderSettings(settings, packages);
  if (settingsBytes !== null) {
    outputs.push({
      entry: { root: 'agent', path: SETTINGS_PATH, class: 'settings', bytes: settingsBytes.length, sha256: sha256Hex(settingsBytes), phase: 'pending', stageId: null, targetId: null, note: null },
      bytes: settingsBytes,
    });
  }
  if (outputs.length === 0) throw invalid('packet-empty');

  // Managed descendant directories; no file may also be (an alias of) a directory.
  const dirs: string[] = [];
  const dirKeys = new Map<string, string>();
  for (const { entry } of outputs) {
    if (entry.root !== 'agent') continue;
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      const prev = dirKeys.get(fold(d));
      if (prev === undefined) {
        dirKeys.set(fold(d), d);
        dirs.push(d);
      } else if (prev !== d) throw invalid('path-alias');
    }
  }
  for (const { entry } of outputs) if (entry.root === 'agent' && dirKeys.has(fold(entry.path))) throw invalid('path-conflict');
  dirs.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return { outputs, dirs, hasLens };
}

// ---------------------------------------------------------------- shared helpers

function toolRoot(): string | null {
  try {
    return fs.realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
  } catch {
    return null;
  }
}

function destOf(j: Journal, o: OutputEntry): string {
  if (o.root === 'lens-config') {
    if (j.targets.lens === null) throw failure('state-corrupt');
    return j.targets.lens;
  }
  return path.join(j.targets.agent, ...o.path.split('/'));
}

function stageOf(j: Journal, o: OutputEntry): string {
  return path.join(path.dirname(destOf(j, o)), o.stage);
}

function lstatQuiet(p: string): fs.BigIntStats | null | 'error' {
  try {
    return lstatOrNull(p);
  } catch {
    return 'error';
  }
}

/** Unknown attempt state is exclusion, never permission to inspect or signal its owner. */
function requireNoPackageAttempt(stateDir: string): void {
  if (lstatQuiet(path.join(stateDir, ATTEMPT_NAME)) !== null) throw failure('package-attempt-unresolved');
}

/** Resolve a target parent without trusting newly introduced ancestor aliases. */
function resolvedTargetParent(target: string, expected: DirId): string | null {
  try {
    const real = fs.realpathSync.native(path.dirname(target));
    const st = lstatQuiet(real);
    return st !== null && st !== 'error' && sameDir(st, expected) ? real : null;
  } catch {
    return null;
  }
}

function parentStillAt(target: string, expected: DirId): boolean {
  return resolvedTargetParent(target, expected) === path.dirname(target);
}

/** Recheck canonical locations before opening any target lock or output. */
function guardRecoveryTargets(j: Journal, live: string[]): void {
  const targets: [string, DirId][] = [[j.targets.agent, j.targets.agentParent]];
  if (j.targets.lens !== null && j.targets.lensParent !== null) targets.push([j.targets.lens, j.targets.lensParent]);
  for (const [target, expected] of targets) {
    const real = resolvedTargetParent(target, expected);
    if (real === null) throw failure('target-changed');
    guardPaths([path.join(real, path.basename(target))], live);
    if (real !== path.dirname(target)) throw failure('target-changed');
  }
}

/** The destination directory chain still has its recorded locations and identities. */
function chainOk(j: Journal, o: OutputEntry): boolean {
  if (o.root === 'lens-config') {
    if (j.targets.lens === null || j.targets.lensParent === null) return false;
    return parentStillAt(j.targets.lens, j.targets.lensParent);
  }
  if (!parentStillAt(j.targets.agent, j.targets.agentParent)) return false;
  if (j.root.phase !== 'created' || j.root.id === null) return false;
  const rst = lstatQuiet(j.targets.agent);
  if (rst === null || rst === 'error' || !sameDir(rst, j.root.id)) return false;
  const parts = o.path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const d = j.dirs.find((x) => x.path === parts.slice(0, i).join('/'));
    if (!d || d.phase !== 'created' || d.id === null) return false;
    const st = lstatQuiet(path.join(j.targets.agent, ...parts.slice(0, i)));
    if (st === null || st === 'error' || !sameDir(st, d.id)) return false;
  }
  return true;
}

function digestOk(o: OutputEntry, r: { st: fs.BigIntStats; bytes: Buffer }): boolean {
  return r.st.size === BigInt(o.bytes) && r.bytes.length === o.bytes && sha256Hex(r.bytes) === o.sha256 && r.st.birthtimeNs !== 0n;
}

/** Journaled stage and destination are one inode with link count 2 and the recorded bytes. */
function pairProven(j: Journal, o: OutputEntry, publishedId: FileId | null): boolean {
  if (o.stageId === null) return false;
  const s = readProven(stageOf(j, o), 2n, o.bytes);
  const d = readProven(destOf(j, o), 2n, o.bytes);
  if (!s || !d || s.st.dev !== d.st.dev || s.st.ino !== d.st.ino) return false;
  if (!sameFile(d.st, o.stageId, true) || !digestOk(o, d)) return false;
  return publishedId === null || sameFile(d.st, publishedId);
}

/** Destination alone, exactly the journaled final identity and bytes. */
function finalProven(j: Journal, o: OutputEntry): boolean {
  if (o.targetId === null) return false;
  const d = readProven(destOf(j, o), 1n, o.bytes);
  return d !== null && sameFile(d.st, o.targetId) && digestOk(o, d);
}

/** Unpublished stage alone, exactly the journaled `prepared` identity and bytes. */
function stageProven(j: Journal, o: OutputEntry): boolean {
  if (o.stageId === null) return false;
  const s = readProven(stageOf(j, o), 1n, o.bytes);
  return s !== null && sameFile(s.st, o.stageId) && digestOk(o, s);
}

interface Ctx {
  deps: TxDeps;
  stateDir: string;
  j: Journal;
}

function save(ctx: Ctx): void {
  replaceFile(ctx.deps, ctx.stateDir, JOURNAL_NAME, journalBytes(ctx.j));
}

function bestEffort(fn: () => void): void {
  try {
    fn();
  } catch {
    // The original failure is reported; this cleanup is optional.
  }
}

function asToolError(e: unknown, code: string): ToolError {
  return e instanceof ToolError ? e : failure(code);
}

function guardPaths(paths: (string | null)[], live: string[]): void {
  for (const p of paths) if (p !== null) guardLiveLexical(p, live);
}

function parentId(p: string, code: string, needBirthtime: boolean): DirId {
  const st = guarded('filesystem-error', () => lstatOrNull(path.dirname(p)));
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw failure(code);
  if (needBirthtime && st.birthtimeNs === 0n) throw failure('birthtime-unsupported');
  return dirId(st);
}

function requireAbsent(t: AbsentTarget, kind: 'state' | 'target'): void {
  if (!t.parentExists) throw failure(`${kind}-parent-missing`);
  if (t.exists) throw failure(`${kind}-exists`);
  if (hasSiblingAlias(path.dirname(t.path), path.basename(t.path))) throw failure(`${kind}-alias-exists`);
}

function dropFile(deps: TxDeps, point: string, file: string, id: FileId): void {
  const r = unlinkProven(deps, point, 'lock-release-failed', file, (st) => sameFile(st, id));
  if (r === 'mismatch') throw failure('lock-changed');
  syncDir(deps, `${point}-sync`, 'lock-release-failed', path.dirname(file));
}

// ---------------------------------------------------------------- apply

interface ApplyCtx extends Ctx {
  lockId: FileId | null;
  targetLockId: FileId | null;
  bootId: string | null;
}

/**
 * Exclusively create a new agent target (and optional lens file) from a
 * validated, approved packet, journaling every step in a new state
 * directory. Throws a `ToolError`; after a failure, `inspectRestore` reports
 * what remains and `resolveRestore` performs explicit recovery.
 */
export function applyRestore(packet: RestorePacket, opts: TxOptions = {}): ApplyResult {
  const deps = resolveDeps(opts.deps);
  const live = liveLocations(opts.env ?? process.env, opts.guard);
  if (!isObject(packet as unknown)) throw invalid('packet-invalid');
  const stateArg = requireAbsolute(packet.state, 'usage');
  const agentArg = requireAbsolute(packet.agentTarget, 'usage');
  const lensArg = packet.lensTarget === null ? null : requireAbsolute(packet.lensTarget, 'usage');
  guardPaths([stateArg, agentArg, lensArg], live);

  const v = validatePacket(packet);
  if (deps.platform !== packet.platform) throw invalid('platform-mismatch');
  if (v.hasLens && lensArg === null) throw invalid('lens-target-required');
  if (!v.hasLens && lensArg !== null) throw invalid('lens-target-unused');

  const state = absentTarget(stateArg);
  const agent = absentTarget(agentArg);
  const lens = lensArg === null ? null : absentTarget(lensArg);
  guardPaths([state.path, agent.path, lens?.path ?? null], live);
  const own = [state.path, agent.path, ...(lens ? [lens.path] : [])];
  for (let i = 0; i < own.length; i++) for (let k = i + 1; k < own.length; k++) if (overlaps(own[i], own[k])) throw invalid('roots-overlap');
  const protectedRoots = packet.protectedRoots.map((r) => existingDir(requireAbsolute(r, 'usage'), 'protected-root-missing').path);
  const tool = toolRoot();
  if (tool !== null) protectedRoots.push(tool);
  for (const p of own) for (const r of protectedRoots) if (overlaps(p, r)) throw invalid('roots-overlap');
  requireAbsent(state, 'state');
  requireAbsent(agent, 'target');
  if (lens) requireAbsent(lens, 'target');
  const stateParent = parentId(state.path, 'state-parent-missing', false);
  const agentParent = parentId(agent.path, 'target-parent-missing', true);
  const lensParent = lens ? parentId(lens.path, 'target-parent-missing', true) : null;

  const tx = deps.randomHex(16);
  if (!TX_RE.test(tx)) throw failure('random-failed');
  const stages = new Set<string>();
  const outputs: OutputEntry[] = v.outputs.map(({ entry }) => {
    const stage = `${STAGE_PREFIX}${deps.randomHex(16)}`;
    if (!STAGE_RE.test(stage) || stages.has(stage)) throw failure('random-failed');
    stages.add(stage);
    return { ...entry, stage };
  });
  const j: Journal = {
    schemaVersion: 1,
    kind: JOURNAL_KIND,
    tool: TOOL_ID,
    tx,
    planToken: packet.planToken,
    platform: packet.platform,
    status: 'applying',
    targets: { agent: agent.path, agentParent, lens: lens?.path ?? null, lensParent },
    root: { phase: 'pending', id: null },
    targetLock: { phase: 'pending', id: null },
    dirs: v.dirs.map((d) => ({ path: d, phase: 'pending', id: null })),
    outputs,
    resolutions: [],
  };
  // Every journal this transaction can write must fit before anything is created.
  if (Buffer.byteLength(journalText(worstCaseJournal(j)), 'utf8') > MIB) throw invalid('transaction-too-large');

  const bootId = bootIdOf(deps);
  const warnings = bootId === null ? ['boot-identity-unavailable'] : [];
  const ctx: ApplyCtx = { deps, stateDir: state.path, j, lockId: null, targetLockId: null, bootId };

  // ---- first filesystem writes
  if (mkdirExclusive(deps, 'state-mkdir', 'state-failed', state.path) === 'exists') throw failure('state-exists');
  syncDir(deps, 'state-parent-sync', 'state-failed', path.dirname(state.path));
  requireNoPackageAttempt(state.path);
  const lockSt = createExclusive(deps, 'lock-create', 'lock-failed', path.join(state.path, LOCK_NAME), lockBytes(makeLock(deps, 'state', tx, bootId)));
  if (lockSt === 'exists') throw failure('lock-held');
  ctx.lockId = fileId(lockSt);
  try {
    syncDir(deps, 'lock-dirsync', 'lock-failed', state.path);
    requireNoPackageAttempt(state.path);
    if (opts.verifyLockedIntent !== undefined && opts.verifyLockedIntent() !== j.planToken) {
      throw failure('activation-approval-mismatch');
    }
    requireNoPackageAttempt(state.path);
    save(ctx);
    // Under the lock: the targets and their parents are still as validated.
    requireAbsent(absentTarget(agent.path), 'target');
    if (lens) requireAbsent(absentTarget(lens.path), 'target');
    if (!sameDirAt(path.dirname(state.path), stateParent)) throw failure('target-changed');
    createRoot(ctx);
    createTargetLock(ctx);
    createDirs(ctx);
    for (let i = 0; i < j.outputs.length; i++) publish(ctx, j.outputs[i], v.outputs[i].bytes);
    if (ctx.targetLockId !== null) dropFile(deps, 'target-lock-release', path.join(j.targets.agent, TARGET_LOCK_NAME), ctx.targetLockId);
    ctx.targetLockId = null;
    j.targetLock.phase = 'released';
    j.status = 'applied';
    save(ctx);
    dropFile(deps, 'lock-release', path.join(state.path, LOCK_NAME), ctx.lockId);
    ctx.lockId = null;
  } catch (e) {
    const tl = ctx.targetLockId;
    if (tl !== null) bestEffort(() => dropFile(deps, 'target-lock-release', path.join(j.targets.agent, TARGET_LOCK_NAME), tl));
    const sl = ctx.lockId;
    if (sl !== null) bestEffort(() => dropFile(deps, 'lock-release', path.join(state.path, LOCK_NAME), sl));
    throw asToolError(e, 'apply-failed');
  }
  return { tx, status: 'applied', outputs: j.outputs.length, directories: j.dirs.length, warnings };
}

function sameDirAt(p: string, id: DirId): boolean {
  const st = lstatQuiet(p);
  return st !== null && st !== 'error' && sameDir(st, id);
}

function createRoot(ctx: ApplyCtx): void {
  const { deps, j } = ctx;
  if (!sameDirAt(path.dirname(j.targets.agent), j.targets.agentParent)) throw failure('target-changed');
  if (j.targets.lens !== null && j.targets.lensParent !== null && !sameDirAt(path.dirname(j.targets.lens), j.targets.lensParent)) {
    throw failure('target-changed');
  }
  j.root.phase = 'intent';
  save(ctx);
  const st = mkdirExclusive(deps, 'root-mkdir', 'root-failed', j.targets.agent);
  if (st === 'exists') {
    j.root.phase = 'not-created';
    save(ctx);
    throw failure('target-exists');
  }
  syncDir(deps, 'root-parent-sync', 'root-failed', path.dirname(j.targets.agent));
  if (st.birthtimeNs === 0n) throw failure('birthtime-unsupported');
  j.root = { phase: 'created', id: dirId(st) };
  save(ctx);
}

function createTargetLock(ctx: ApplyCtx): void {
  const { deps, j } = ctx;
  j.targetLock.phase = 'intent';
  save(ctx);
  const file = path.join(j.targets.agent, TARGET_LOCK_NAME);
  const st = createExclusive(deps, 'target-lock-create', 'lock-failed', file, lockBytes(makeLock(deps, 'target', j.tx, ctx.bootId)));
  if (st === 'exists') throw failure('target-conflict');
  ctx.targetLockId = fileId(st);
  syncDir(deps, 'target-lock-dirsync', 'lock-failed', j.targets.agent);
  j.targetLock = { phase: 'held', id: ctx.targetLockId };
  save(ctx);
}

function createDirs(ctx: ApplyCtx): void {
  const { deps, j } = ctx;
  if (j.dirs.length === 0) return;
  for (const d of j.dirs) d.phase = 'intent';
  save(ctx);
  const ids: DirId[] = [];
  for (const d of j.dirs) {
    const p = path.join(j.targets.agent, ...d.path.split('/'));
    const st = mkdirExclusive(deps, 'dir-mkdir', 'dir-failed', p);
    if (st === 'exists') {
      d.phase = 'not-created';
      save(ctx);
      throw failure('target-conflict');
    }
    syncDir(deps, 'dir-sync', 'dir-failed', path.dirname(p));
    if (st.birthtimeNs === 0n) throw failure('birthtime-unsupported');
    ids.push(dirId(st));
  }
  j.dirs.forEach((d, i) => {
    d.phase = 'created';
    d.id = ids[i];
  });
  save(ctx);
}

function publish(ctx: Ctx, o: OutputEntry, bytes: Buffer): void {
  const { deps, j } = ctx;
  const dest = destOf(j, o);
  const dir = path.dirname(dest);
  const stage = path.join(dir, o.stage);
  if (!chainOk(j, o)) throw failure('target-changed');
  o.phase = 'staging';
  save(ctx);
  const st = createExclusive(deps, 'stage-create', 'stage-failed', stage, bytes);
  if (st === 'exists') throw failure('stage-failed');
  if (st.birthtimeNs === 0n) throw failure('birthtime-unsupported');
  syncDir(deps, 'stage-dirsync', 'stage-failed', dir);
  o.phase = 'prepared';
  o.stageId = fileId(st);
  save(ctx);
  if (!chainOk(j, o)) throw failure('target-changed');
  if (linkNoReplace(deps, 'link', 'publish-failed', stage, dest) === 'exists') {
    o.phase = 'not-created';
    o.note = 'destination-exists';
    save(ctx);
    throw failure('target-conflict');
  }
  syncDir(deps, 'link-dirsync', 'publish-failed', dir);
  const d = guarded('publish-failed', () => lstatOrNull(dest));
  if (!d || !d.isFile() || d.nlink !== 2n || !sameFile(d, o.stageId, true)) throw failure('publish-failed');
  o.phase = 'published';
  o.targetId = fileId(d);
  save(ctx);
  unstage(ctx, o);
}

/** From a journaled `published` pair: unlink the stage, re-read the destination, journal `applied`. */
function unstage(ctx: Ctx, o: OutputEntry): void {
  const { deps, j } = ctx;
  const pub = o.targetId;
  if (pub === null) throw failure('state-corrupt');
  const dest = destOf(j, o);
  const r = unlinkProven(deps, 'unstage', 'cleanup-failed', stageOf(j, o), (st) => st.nlink === 2n && sameFile(st, pub));
  if (r !== 'removed') throw failure('cleanup-failed');
  syncDir(deps, 'unstage-dirsync', 'cleanup-failed', path.dirname(dest));
  const f = readProven(dest, 1n, o.bytes);
  if (!f || !sameFile(f.st, pub, true) || !digestOk(o, f)) throw failure('publish-failed');
  o.phase = 'applied';
  o.targetId = fileId(f.st);
  o.note = null;
  save(ctx);
}

// ---------------------------------------------------------------- state analysis

type Obs =
  | 'untouched'
  | 'staging'
  | 'unpublished'
  | 'not-created'
  | 'pair-proven'
  | 'applied'
  | 'rollback-ready'
  | 'rollback-absent'
  | 'terminal'
  | 'uncertain'
  | 'ok';

interface ObsResult {
  obs: Obs;
  reason: Note | null;
}

interface LockObs {
  state: LockState;
  reason: string | null;
  record: LockRecord | null;
  id: FileId | null;
  file: string;
}

interface PackageCapability {
  readonly state: DirId;
  readonly lock: FileId;
  ledger: FileId | null;
  attempt: FileId | null;
}

interface Analysis {
  packageLedger?: { value: PackageLedger; id: FileId };
  stateDir: string;
  j: Journal | null;
  cls: TxClass;
  actions: TxAction[];
  reason: string | null;
  gate: LockObs;
  stateLock: LockObs;
  targetLock: LockObs;
  root: ObsResult;
  outputs: { o: OutputEntry; r: ObsResult }[];
}

const UNCERTAIN = (reason: Note): ObsResult => ({ obs: 'uncertain', reason });
const OBS = (obs: Obs): ObsResult => ({ obs, reason: null });

function observeOutput(j: Journal, o: OutputEntry): ObsResult {
  switch (o.phase) {
    case 'pending':
      return OBS('untouched');
    case 'staging':
      return OBS('staging');
    case 'abandoned':
    case 'rolled-back':
    case 'conflict':
      return OBS('terminal');
    case 'not-created':
      return OBS('not-created');
    default:
      break;
  }
  if (!chainOk(j, o)) return UNCERTAIN('parent-changed');
  const d = lstatQuiet(destOf(j, o));
  if (d === 'error') return UNCERTAIN('observe-failed');
  switch (o.phase) {
    case 'prepared':
      if (d === null) return OBS('unpublished');
      return pairProven(j, o, null) ? OBS('pair-proven') : UNCERTAIN('identity-unproven');
    case 'published':
      return pairProven(j, o, o.targetId) ? OBS('pair-proven') : UNCERTAIN('identity-unproven');
    case 'applied':
      if (d === null) return UNCERTAIN('output-missing');
      return finalProven(j, o) ? OBS('applied') : UNCERTAIN('output-changed');
    case 'rollback-pending':
      if (d === null) return OBS('rollback-absent');
      return finalProven(j, o) ? OBS('rollback-ready') : UNCERTAIN('output-changed');
    default:
      return UNCERTAIN('identity-unproven');
  }
}

function observeRoot(j: Journal): ObsResult {
  switch (j.root.phase) {
    case 'pending':
      return OBS('untouched');
    case 'not-created':
    case 'conflict':
      return OBS('terminal');
    case 'intent': {
      if (!sameDirAt(path.dirname(j.targets.agent), j.targets.agentParent)) return UNCERTAIN('parent-changed');
      const st = lstatQuiet(j.targets.agent);
      if (st === null) return OBS('not-created');
      return UNCERTAIN('root-unproven');
    }
    default:
      return j.root.id !== null && sameDirAt(j.targets.agent, j.root.id) ? OBS('ok') : UNCERTAIN('root-changed');
  }
}

function privateFileOk(st: fs.BigIntStats, uid: number): boolean {
  return st.isFile() && !st.isSymbolicLink() && st.nlink === 1n && Number(st.uid) === uid && (st.mode & 0o777n) === 0o600n;
}

function observeLock(
  file: string,
  role: LockRole,
  tx: string,
  deps: TxDeps,
  bootNow: () => string | null,
  own: FileId | null,
  proven: FileId | null | 'any',
): LockObs {
  const base = { record: null, id: null, file };
  const st = lstatQuiet(file);
  if (st === null) return { ...base, state: 'absent', reason: null };
  if (st === 'error') return { ...base, state: 'unproven', reason: 'lock-unreadable' };
  if (own !== null && sameFile(st, own)) return { ...base, state: 'absent', reason: null };
  if (proven !== 'any' && (proven === null || !sameFile(st, proven))) return { ...base, state: 'unproven', reason: 'lock-unproven' };
  if (!privateFileOk(st, deps.uid())) return { ...base, state: 'unproven', reason: 'lock-unsafe' };
  const r = readProven(file, 1n, LOCK_LIMIT);
  if (!r || r.st.ctimeNs !== st.ctimeNs || r.st.ino !== st.ino) return { ...base, state: 'unproven', reason: 'lock-unreadable' };
  let rec: LockRecord | null = null;
  try {
    rec = parseLock(parseJsonBytes(r.bytes));
  } catch {
    rec = null;
  }
  if (rec === null || rec.role !== role || rec.tx !== tx) return { ...base, state: 'unproven', reason: 'lock-invalid' };
  const verdict = judgeLock(rec, deps, bootNow());
  const id = fileId(st);
  return verdict.stale ? { record: rec, id, file, state: 'stale', reason: null } : { record: rec, id, file, state: 'held', reason: verdict.reason };
}

function corruptAnalysis(stateDir: string, reason: string): Analysis {
  const none: LockObs = { state: 'absent', reason: null, record: null, id: null, file: '' };
  return { stateDir, j: null, cls: 'corrupt', actions: [], reason, gate: none, stateLock: none, targetLock: none, root: OBS('terminal'), outputs: [] };
}

/**
 * Read-only analysis of a state directory. `ownLock`/`ownGate` let the
 * process that currently holds the writer lock or recovery gate ignore it.
 */
function analyze(stateDir: string, deps: TxDeps, live: string[], own: { lock?: FileId; gate?: FileId; pkg?: PackageCapability } = {}, expected?: RestoreTargets): Analysis {
  const uid = deps.uid();
  const dst = lstatQuiet(stateDir);
  if (dst === null || dst === 'error' || !dst.isDirectory() || Number(dst.uid) !== uid || (dst.mode & 0o077n) !== 0n) {
    return corruptAnalysis(stateDir, 'state-unsafe');
  }
  // Keep the reserved name outside the allowlist too: a later appearance must
  // still fail closed even if the metadata probe just observed absence.
  const attemptStat = lstatQuiet(path.join(stateDir, ATTEMPT_NAME));
  if (attemptStat !== null && (!own.pkg || own.pkg.attempt === null || attemptStat === 'error' ||
      !privateFileOk(attemptStat, uid) || !sameFile(attemptStat, own.pkg.attempt))) {
    return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  }
  if (own.pkg && (attemptStat === null && own.pkg.attempt !== null || !sameDir(dst, own.pkg.state))) {
    return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  }
  // Recognizable package locks never reach ordinary stale-owner judging. A
  // damaged/unreadable lock still fails the existing unproven-lock path.
  const packageLock = readProven(path.join(stateDir, LOCK_NAME), 1n, LOCK_LIMIT);
  let isPackageLock = false;
  if (packageLock) {
    try {
      const value = parseJsonBytes(packageLock.bytes);
      isPackageLock = isObject(value) && value.kind === PACKAGE_LOCK_KIND;
    } catch { /* Ordinary malformed locks retain their existing classification. */ }
  }
  if (isPackageLock && (!own.pkg || !packageLock || !privateFileOk(packageLock.st, uid) || !sameFile(packageLock.st, own.pkg.lock))) {
    return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  }
  if (own.pkg && (!isPackageLock || !packageLock || !sameFile(packageLock.st, own.pkg.lock))) {
    return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  }
  let names: string[];
  try {
    const dir = fs.opendirSync(stateDir);
    names = [];
    try {
      for (;;) {
        const e = dir.readSync();
        if (!e) break;
        if (names.length >= MAX_STATE_ENTRIES) return corruptAnalysis(stateDir, 'state-unexpected-entry');
        names.push(e.name);
      }
    } finally {
      dir.closeSync();
    }
  } catch {
    return corruptAnalysis(stateDir, 'state-unsafe');
  }
  for (const n of names) {
    if (n === ATTEMPT_NAME && own.pkg?.attempt !== null && own.pkg?.attempt !== undefined) continue;
    if (n !== JOURNAL_NAME && n !== LOCK_NAME && n !== GATE_NAME && n !== LEDGER_NAME && n !== WORK_NAME && !TMP_RE.test(n) && !LEDGER_TMP_RE.test(n)) return corruptAnalysis(stateDir, 'state-unexpected-entry');
  }
  let packageLedger: Analysis['packageLedger'];
  if (names.includes(LEDGER_NAME)) {
    const r = readProven(path.join(stateDir, LEDGER_NAME), 1n, LEDGER_LIMIT);
    if (!r || !privateFileOk(r.st, uid) || own.pkg?.ledger && !sameFile(r.st, own.pkg.ledger)) return corruptAnalysis(stateDir, 'package-attempt-unresolved');
    try { packageLedger = { value: parseLedger(r.bytes), id: fileId(r.st) }; }
    catch { return corruptAnalysis(stateDir, 'package-attempt-unresolved'); }
    const work = lstatQuiet(path.join(stateDir, WORK_NAME));
    if (!work || work === 'error' || work.isSymbolicLink() || !sameDir(work, packageLedger.value.workParent) ||
        Number(work.uid) !== uid || (work.mode & 0o077n) !== 0n) return corruptAnalysis(stateDir, 'package-attempt-unresolved');
    const open = packageLedger.value.runs.find(r => r.state === 'open');
    if (open && (!own.pkg || own.pkg.ledger === null || canonicalJson(open.lock) !== canonicalJson(own.pkg.lock))) return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  } else if (names.includes(WORK_NAME) || names.some(n => LEDGER_TMP_RE.test(n)) || own.pkg?.ledger) {
    return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  }
  const jfile = path.join(stateDir, JOURNAL_NAME);
  const jst = lstatQuiet(jfile);
  if (jst === null) return corruptAnalysis(stateDir, 'journal-missing');
  if (jst === 'error' || !privateFileOk(jst, uid)) return corruptAnalysis(stateDir, 'state-unsafe');
  const jr = readProven(jfile, 1n, MIB);
  if (!jr) return corruptAnalysis(stateDir, 'journal-invalid');
  let j: Journal;
  try {
    j = parseJournal(jr.bytes);
  } catch {
    return corruptAnalysis(stateDir, 'journal-invalid');
  }
  if (packageLedger && (packageLedger.value.tx !== j.tx || packageLedger.value.planToken !== j.planToken)) return corruptAnalysis(stateDir, 'package-attempt-unresolved');
  for (const name of names.filter(n => LEDGER_TMP_RE.test(n))) {
    const r = readProven(path.join(stateDir, name), 1n, LEDGER_LIMIT);
    if (!r || !privateFileOk(r.st, uid)) return corruptAnalysis(stateDir, 'package-attempt-unresolved');
    try {
      const candidate = parseLedger(r.bytes);
      if (candidate.tx !== j.tx || candidate.planToken !== j.planToken) return corruptAnalysis(stateDir, 'package-attempt-unresolved');
    } catch { return corruptAnalysis(stateDir, 'package-attempt-unresolved'); }
  }
  guardPaths([j.targets.agent, j.targets.lens], live);
  if (expected !== undefined && (expected.agent !== j.targets.agent || expected.lens !== j.targets.lens)) {
    throw failure('target-context-mismatch');
  }
  guardRecoveryTargets(j, live);

  let boot: string | null | undefined;
  const bootNow = (): string | null => {
    if (boot === undefined) boot = bootIdOf(deps);
    return boot;
  };
  const gate = observeLock(path.join(stateDir, GATE_NAME), 'gate', j.tx, deps, bootNow, own.gate ?? null, 'any');
  const stateLock = observeLock(path.join(stateDir, LOCK_NAME), 'state', j.tx, deps, bootNow, own.pkg?.lock ?? own.lock ?? null, 'any');
  const tlFile = path.join(j.targets.agent, TARGET_LOCK_NAME);
  const rootOk = j.root.phase === 'created' && j.root.id !== null && sameDirAt(j.targets.agent, j.root.id);
  let targetLock: LockObs = { state: 'absent', reason: null, record: null, id: null, file: tlFile };
  if (rootOk) {
    const proven = j.targetLock.phase === 'held' || j.targetLock.phase === 'released' ? j.targetLock.id : null;
    targetLock = observeLock(tlFile, 'target', j.tx, deps, bootNow, null, proven);
  }

  const root = TERMINAL.has(j.status) ? OBS('terminal') : observeRoot(j);
  const outputs = j.outputs.map((o) => ({ o, r: TERMINAL.has(j.status) ? OBS('terminal') : observeOutput(j, o) }));
  const a: Analysis = { stateDir, j, cls: 'corrupt', actions: [], reason: null, gate, stateLock, targetLock, root, outputs };
  if (packageLedger) a.packageLedger = packageLedger;
  classify(a, j);
  return a;
}

const TERMINAL: ReadonlySet<TxStatus> = new Set(['rolled-back', 'closed', 'preserved']);

function classify(a: Analysis, j: Journal): void {
  const set = (cls: TxClass, actions: TxAction[], reason: string | null = null): void => {
    a.cls = cls;
    a.actions = actions;
    a.reason = reason;
  };
  if (a.gate.state === 'stale') return set('gate-stale', ['release-gate']);
  if (a.gate.state !== 'absent') return set('gate-held', [], a.gate.reason);
  // An unproven target lock (identity never journaled) is reported but cannot block: it is not ours to judge.
  const locks = [a.stateLock, ...(a.targetLock.state === 'unproven' && a.targetLock.reason === 'lock-unproven' ? [] : [a.targetLock])];
  const blocking = locks.find((l) => l.state === 'held' || l.state === 'unproven');
  if (blocking) return set('lock-held', [], blocking.reason);
  if (locks.some((l) => l.state === 'stale')) return set('lock-stale', ['release-lock']);
  if (TERMINAL.has(j.status)) return set(j.status as TxClass, []);
  const uncertain = [a.root, ...a.outputs.map((x) => x.r)].find((r) => r.obs === 'uncertain');
  if (uncertain) return set('conflict', ['record-conflict'], uncertain.reason);
  if (j.status === 'rollback-pending') return set('rollback-pending', ['rollback']);
  if (a.outputs.some((x) => x.r.obs === 'pair-proven')) return set('published-unfinished', ['finalize']);
  if (j.status === 'applying') {
    const open = new Set<Obs>(['untouched', 'staging', 'unpublished', 'not-created']);
    if (open.has(a.root.obs) || a.outputs.some((x) => open.has(x.r.obs))) return set('unfinished', ['abandon']);
    return set('unfinalized', ['finalize']);
  }
  if (j.status === 'applied') return set('applied', ['rollback']);
  if (j.status === 'partial') return set('partial', ['rollback']);
  return set('corrupt', [], 'journal-invalid');
}

function publicLock(l: LockObs): LockState {
  return l.state;
}

function inspectResult(a: Analysis, warnings: string[]): InspectResult {
  const j = a.j;
  const items: InspectItem[] = [];
  if (j) {
    items.push({ kind: 'root', phase: j.root.phase, observed: a.root.reason ?? a.root.obs });
    for (const { o, r } of a.outputs) {
      const item: InspectItem = { kind: 'output', root: o.root, path: o.path, class: o.class, phase: o.phase, observed: r.reason ?? r.obs };
      if (o.note !== null) item.note = o.note;
      items.push(item);
    }
  }
  return {
    tx: j?.tx ?? null,
    status: j?.status ?? null,
    class: a.cls,
    actions: [...a.actions],
    reason: a.reason,
    locks: { state: publicLock(a.stateLock), target: publicLock(a.targetLock), gate: publicLock(a.gate) },
    items,
    warnings,
  };
}

function bindTargets(value: RestoreTargets | undefined, live: string[]): RestoreTargets | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value as unknown) || Object.keys(value).length !== 2 || typeof value.agent !== 'string' || (value.lens !== null && typeof value.lens !== 'string')) {
    throw invalid('target-context-invalid');
  }
  const agentArg = requireAbsolute(value.agent, 'usage');
  const lensArg = value.lens === null ? null : requireAbsolute(value.lens, 'usage');
  guardPaths([agentArg, lensArg], live);
  const agent = absentTarget(agentArg).path;
  const lens = lensArg === null ? null : absentTarget(lensArg).path;
  guardPaths([agent, lens], live);
  return { agent, lens };
}

function openState(state: string, opts: TxOptions): { deps: TxDeps; live: string[]; dir: string; expected: RestoreTargets | undefined } {
  const deps = resolveDeps(opts.deps);
  const live = liveLocations(opts.env ?? process.env, opts.guard);
  const expected = bindTargets(opts.expectedTargets, live);
  const arg = requireAbsolute(state, 'usage');
  guardLiveLexical(arg, live);
  const root = existingDir(arg, 'state-missing');
  guardLiveLexical(root.path, live);
  return { deps, live, dir: root.path, expected };
}

/** Read-only classification of one transaction; never breaks locks or changes files. */
export function inspectRestore(state: string, opts: TxOptions = {}): InspectResult {
  const { deps, live, dir, expected } = openState(state, opts);
  const a = analyze(dir, deps, live, {}, expected);
  const locksPresent = [a.gate, a.stateLock, a.targetLock].some((l) => l.record !== null);
  const warnings = locksPresent && bootIdOf(deps) === null ? ['boot-identity-unavailable'] : [];
  return inspectResult(a, warnings);
}

/** Private proven applied-state descriptors. Never serialize this snapshot as public output. */
export interface AppliedRestoreSnapshot {
  readonly tx: string;
  readonly planToken: string;
  readonly platform: Platform;
  readonly targets: Readonly<RestoreTargets>;
  readonly outputs: readonly Readonly<{ root: FileRoot; path: string; class: OutputClass; sha256: string; bytes: number }>[];
}

/** Read-only trusted service; caller must explicitly bind both target roots. */
export function readAppliedRestore(state: string, tx: string, opts: TxOptions & { expectedTargets: RestoreTargets }): AppliedRestoreSnapshot {
  if (opts.expectedTargets === undefined) throw invalid('target-context-required');
  const { deps, live, dir, expected } = openState(state, opts);
  if (typeof tx !== 'string' || !TX_RE.test(tx)) throw invalid('tx-invalid');
  const a = analyze(dir, deps, live, {}, expected);
  if (a.j === null) throw failure('state-corrupt');
  if (a.j.tx !== tx) throw failure('tx-mismatch');
  if (a.cls !== 'applied') throw failure('restore-not-applied');
  return Object.freeze({
    tx: a.j.tx, planToken: a.j.planToken, platform: a.j.platform,
    targets: Object.freeze({ agent: a.j.targets.agent, lens: a.j.targets.lens }),
    outputs: Object.freeze(a.j.outputs.map((o) => Object.freeze({
      root: o.root, path: o.path, class: o.class, sha256: o.sha256, bytes: o.bytes,
    }))),
  });
}

// ---------------------------------------------------------------- actions

function acquireWriter(dir: string, deps: TxDeps, tx: string): FileId {
  requireNoPackageAttempt(dir);
  if (lstatQuiet(path.join(dir, GATE_NAME)) !== null) throw failure('gate-held');
  const st = createExclusive(deps, 'lock-create', 'lock-failed', path.join(dir, LOCK_NAME), lockBytes(makeLock(deps, 'state', tx, bootIdOf(deps))));
  if (st === 'exists') throw failure('lock-held');
  const id = fileId(st);
  try {
    syncDir(deps, 'lock-dirsync', 'lock-failed', dir);
  } catch (e) {
    bestEffort(() => dropFile(deps, 'lock-release', path.join(dir, LOCK_NAME), id));
    throw e;
  }
  return id;
}

/** Run `fn` under the writer lock against a fresh analysis that must still match `want`. */
function underWriter<T>(dir: string, deps: TxDeps, live: string[], tx: string, fn: (a: Analysis, ctx: Ctx) => T, expected?: RestoreTargets): T {
  const id = acquireWriter(dir, deps, tx);
  let out: T;
  try {
    const a = analyze(dir, deps, live, { lock: id }, expected);
    if (a.j === null) throw failure('state-corrupt');
    if (a.j.tx !== tx) throw failure('tx-mismatch');
    out = fn(a, { deps, stateDir: dir, j: a.j });
  } catch (e) {
    bestEffort(() => dropFile(deps, 'lock-release', path.join(dir, LOCK_NAME), id));
    throw asToolError(e, 'resolve-failed');
  }
  dropFile(deps, 'lock-release', path.join(dir, LOCK_NAME), id);
  return out;
}

function doAbandon(ctx: Ctx, a: Analysis): number {
  const { deps, j } = ctx;
  let removed = 0;
  for (const { o, r } of a.outputs) {
    if (r.obs === 'untouched') {
      o.phase = 'abandoned';
      o.note = 'never-staged';
    } else if (r.obs === 'staging') {
      const st = chainOk(j, o) ? lstatQuiet(stageOf(j, o)) : 'error';
      o.phase = 'abandoned';
      o.note = st === null ? 'stage-absent' : 'orphan-preserved';
    } else if (r.obs === 'unpublished' || r.obs === 'not-created') {
      const stage = stageOf(j, o);
      const sid = o.stageId;
      let note: Note = 'orphan-preserved';
      if (chainOk(j, o) && sid !== null) {
        if (lstatQuiet(stage) === null) note = 'stage-absent';
        else if (stageProven(j, o)) {
          const res = unlinkProven(deps, 'abandon-unlink', 'cleanup-failed', stage, (st) => st.nlink === 1n && sameFile(st, sid));
          if (res === 'removed') {
            syncDir(deps, 'abandon-dirsync', 'cleanup-failed', path.dirname(stage));
            removed++;
            note = 'stage-removed';
          } else if (res === 'absent') note = 'stage-absent';
        }
      }
      if (r.obs === 'unpublished') o.phase = 'abandoned';
      o.note = note;
    }
  }
  if (a.root.obs === 'not-created') j.root.phase = 'not-created';
  j.status = j.outputs.some((o) => o.phase === 'applied') ? 'partial' : 'closed';
  save(ctx);
  return removed;
}

function doFinalize(ctx: Ctx, a: Analysis): number {
  const { j } = ctx;
  if (a.cls === 'published-unfinished') {
    for (const { o, r } of a.outputs) {
      if (r.obs !== 'pair-proven') continue;
      if (o.phase === 'prepared') {
        // Durable checkpoint of the current pair identity before cleanup.
        const d = guarded('publish-failed', () => lstatOrNull(destOf(j, o)));
        if (!d || d.nlink !== 2n || o.stageId === null || !sameFile(d, o.stageId, true)) throw failure('publish-failed');
        o.phase = 'published';
        o.targetId = fileId(d);
        save(ctx);
      }
      unstage(ctx, o);
    }
    return 0;
  }
  if (j.targetLock.phase === 'held' && a.targetLock.state === 'absent') j.targetLock.phase = 'released';
  j.status = 'applied';
  save(ctx);
  return 0;
}

function doRollback(ctx: Ctx, a: Analysis): number {
  const { deps, j } = ctx;
  if (j.status !== 'rollback-pending') {
    if (a.outputs.some(({ o, r }) => o.phase === 'applied' && r.obs !== 'applied')) throw failure('rollback-conflict');
    for (const o of j.outputs) if (o.phase === 'applied') o.phase = 'rollback-pending';
    j.status = 'rollback-pending';
    save(ctx);
  }
  let removed = 0;
  for (const o of j.outputs) {
    if (o.phase !== 'rollback-pending') continue;
    const r = observeOutput(j, o);
    const tid = o.targetId;
    if (r.obs === 'rollback-absent') {
      // An earlier unlink may have succeeded while its directory sync failed.
      syncDir(deps, 'rollback-dirsync', 'rollback-failed', path.dirname(destOf(j, o)));
      o.note = 'already-absent';
    } else if (r.obs === 'rollback-ready' && tid !== null) {
      const dest = destOf(j, o);
      const res = unlinkProven(deps, 'rollback-unlink', 'rollback-failed', dest, (st) => st.nlink === 1n && sameFile(st, tid));
      if (res !== 'removed') throw failure('rollback-conflict');
      syncDir(deps, 'rollback-dirsync', 'rollback-failed', path.dirname(dest));
      removed++;
      o.note = 'removed';
    } else {
      throw failure('rollback-conflict');
    }
    o.phase = 'rolled-back';
    save(ctx);
  }
  j.status = 'rolled-back';
  save(ctx);
  return removed;
}

function doRecordConflict(ctx: Ctx, a: Analysis): number {
  const { j } = ctx;
  for (const { o, r } of a.outputs) {
    if (r.obs === 'uncertain') {
      o.phase = 'conflict';
      o.note = r.reason;
    }
  }
  if (a.root.obs === 'uncertain') j.root.phase = 'conflict';
  j.status = 'preserved';
  save(ctx);
  return 0;
}

const ROLLBACK_CLASSES: ReadonlySet<TxClass> = new Set(['applied', 'partial', 'rollback-pending']);

/**
 * Remove the configuration files this transaction created and that are still
 * provably unchanged, as one group: if any member is changed, nothing is
 * removed (`rollback-conflict`). Directories, the agent root, packages and
 * runtime files stay. Repeating it after completion removes nothing.
 */
export function rollbackRestore(state: string, tx: string, opts: TxOptions = {}): RollbackResult {
  const { deps, live, dir, expected } = openState(state, opts);
  if (typeof tx !== 'string' || !TX_RE.test(tx)) throw invalid('tx-invalid');
  const pre = analyze(dir, deps, live, {}, expected);
  if (pre.j === null) throw failure('state-corrupt');
  if (pre.j.tx !== tx) throw failure('tx-mismatch');
  if (pre.cls === 'rolled-back') return { tx, status: 'rolled-back', removed: 0 };
  if (pre.cls === 'lock-held' || pre.cls === 'lock-stale') throw failure('lock-held');
  if (pre.cls === 'gate-held' || pre.cls === 'gate-stale') throw failure('gate-held');
  if (pre.cls === 'conflict') throw failure('rollback-conflict');
  if (!ROLLBACK_CLASSES.has(pre.cls)) throw failure('rollback-unavailable');
  const removed = underWriter(dir, deps, live, tx, (a, ctx) => {
    if (a.cls === 'conflict') throw failure('rollback-conflict');
    if (!ROLLBACK_CLASSES.has(a.cls)) throw failure('rollback-unavailable');
    return doRollback(ctx, a);
  }, expected);
  return { tx, status: 'rolled-back', removed };
}

function releaseGate(dir: string, deps: TxDeps, live: string[], expected?: RestoreTargets): number {
  const a = analyze(dir, deps, live, {}, expected);
  if (a.cls !== 'gate-stale' || a.gate.id === null) throw failure('expect-mismatch');
  const gid = a.gate.id;
  const r = unlinkProven(deps, 'stale-unlink', 'lock-release-failed', a.gate.file, (st) => sameFile(st, gid));
  if (r !== 'removed') throw failure('lock-changed');
  syncDir(deps, 'stale-dirsync', 'lock-release-failed', dir);
  return 1;
}

function releaseLocks(dir: string, deps: TxDeps, live: string[], tx: string, expected?: RestoreTargets): number {
  const gateFile = path.join(dir, GATE_NAME);
  const gst = createExclusive(deps, 'gate-create', 'gate-failed', gateFile, lockBytes(makeLock(deps, 'gate', tx, bootIdOf(deps))));
  if (gst === 'exists') throw failure('gate-held');
  const gid = fileId(gst);
  let removed = 0;
  try {
    syncDir(deps, 'gate-dirsync', 'gate-failed', dir);
    const a = analyze(dir, deps, live, { gate: gid }, expected);
    if (a.j === null) throw failure('state-corrupt');
    if (a.cls !== 'lock-stale') throw failure('expect-mismatch');
    if (a.j.resolutions.length >= MAX_RESOLUTIONS) throw failure('resolution-limit');
    const stale = [a.targetLock, a.stateLock].filter((l) => l.state === 'stale');
    const records = stale.map((l) => l.record).filter((r): r is LockRecord => r !== null);
    const ctx: Ctx = { deps, stateDir: dir, j: a.j };
    a.j.resolutions.push({ action: 'release-lock', class: 'lock-stale', locks: records });
    save(ctx);
    for (const l of stale) {
      const lid = l.id;
      if (lid === null) throw failure('lock-changed');
      const r = unlinkProven(deps, 'stale-unlink', 'lock-release-failed', l.file, (st) => sameFile(st, lid));
      if (r === 'mismatch') throw failure('lock-changed');
      syncDir(deps, 'stale-dirsync', 'lock-release-failed', path.dirname(l.file));
      if (r === 'removed') removed++;
    }
  } catch (e) {
    bestEffort(() => dropFile(deps, 'gate-release', gateFile, gid));
    throw asToolError(e, 'resolve-failed');
  }
  dropFile(deps, 'gate-release', gateFile, gid);
  return removed;
}

/**
 * Explicit recovery: performs `action` only when the transaction ID matches,
 * the current classification equals `expect`, and the action is allowed for
 * it. Stale locks are released under the recovery gate; every other action
 * runs under the writer lock against a fresh classification.
 */
export function resolveRestore(state: string, req: ResolveRequest, opts: TxOptions = {}): ResolveResult {
  const { deps, live, dir, expected } = openState(state, opts);
  if (!isObject(req as unknown) || typeof req.tx !== 'string' || !TX_RE.test(req.tx)) throw invalid('tx-invalid');
  if (!(TX_CLASSES as readonly string[]).includes(req.expect)) throw invalid('expect-invalid');
  if (!(TX_ACTIONS as readonly string[]).includes(req.action)) throw invalid('action-invalid');
  const expect = req.expect as TxClass;
  const action = req.action as TxAction;
  const pre = analyze(dir, deps, live, {}, expected);
  if (pre.j === null) throw failure('state-corrupt');
  if (pre.j.tx !== req.tx) throw failure('tx-mismatch');
  if (pre.cls !== expect) throw failure('expect-mismatch');
  if (!pre.actions.includes(action)) throw invalid('action-not-allowed');
  const tx = req.tx;
  let removed: number;
  if (action === 'release-gate') removed = releaseGate(dir, deps, live, expected);
  else if (action === 'release-lock') removed = releaseLocks(dir, deps, live, tx, expected);
  else {
    removed = underWriter(dir, deps, live, tx, (a, ctx) => {
      if (a.cls !== expect) throw failure('expect-mismatch');
      if (!a.actions.includes(action)) throw failure('expect-mismatch');
      if (ctx.j.resolutions.length >= MAX_RESOLUTIONS) throw failure('resolution-limit');
      ctx.j.resolutions.push({ action, class: expect, locks: [] });
      switch (action) {
        case 'abandon':
          return doAbandon(ctx, a);
        case 'finalize':
          return doFinalize(ctx, a);
        case 'rollback':
          return doRollback(ctx, a);
        default:
          return doRecordConflict(ctx, a);
      }
    }, expected);
  }
  return { tx, action, class: expect, removed };
}

// ---------------------------------------------------------------- trusted fixture package service

export interface LockedPackages {
  readonly tx: string;
  readonly planToken: string;
  readonly packages: readonly PackageDecl[];
}
export interface PackageRunOptions extends TxOptions {
  expectedTargets: RestoreTargets;
  packageToken: string;
  verifyLockedPackageIntent(value: LockedPackages): string;
  protectedRoots: readonly string[];
}
export interface PackageRunResult {
  tx: string;
  status: 'completed' | 'install-failed';
  attempted: number;
  installed: number;
  failed: null | { index: number; reason: 'exit-nonzero' | 'signal' | 'timeout' | 'output-limit' };
}

function packageDirAt(file: string, uid: number, expected?: DirId): DirId {
  const st = lstatQuiet(file);
  if (!st || st === 'error' || st.isSymbolicLink() || !st.isDirectory() || st.birthtimeNs <= 0n ||
      Number(st.uid) !== uid || (st.mode & 0o077n) !== 0n || expected && !sameDir(st, expected)) throw failure('package-work-changed');
  return dirId(st);
}
function restoredPackages(j: Journal): PackageDecl[] {
  const output = j.outputs.find(o => o.class === 'settings');
  if (!output) return [];
  const r = readProven(destOf(j, output), 1n, output.bytes);
  if (!r || output.targetId === null || !sameFile(r.st, output.targetId) || !digestOk(output, r)) throw failure('package-config-drift');
  try {
    const settings = parseJsonBytes(r.bytes);
    if (!isObject(settings)) throw failure('package-config-drift');
    if (!Object.hasOwn(settings, 'packages')) return [];
    if (!Array.isArray(settings.packages)) throw failure('package-config-drift');
    return settings.packages.map(p => packageDecl(p, false));
  } catch { throw failure('package-config-drift'); }
}
function frozenPackages(packages: readonly PackageDecl[]): readonly PackageDecl[] {
  return Object.freeze(packages.map(p => {
    const copy = packageDecl(p, false);
    if (typeof copy !== 'string') {
      for (const key of ['extensions', 'skills', 'prompts', 'themes'] as const) if (copy[key]) Object.freeze(copy[key]);
      Object.freeze(copy);
    }
    return copy;
  }));
}
function verifyPackageConsent(opts: PackageRunOptions, j: Journal, packages: readonly PackageDecl[]): void {
  let token: unknown;
  try { token = opts.verifyLockedPackageIntent(Object.freeze({ tx: j.tx, planToken: j.planToken, packages: frozenPackages(packages) })); }
  catch { throw failure('package-approval-mismatch'); }
  if (token !== opts.packageToken) throw failure('package-approval-mismatch');
}
function verifyPackageHistory(ledger: PackageLedger, packages: readonly PackageDecl[]): void {
  let run = -1;
  let failed = false;
  for (const a of ledger.attempts) {
    if (a.run !== run) { run = a.run; failed = false; }
    if (failed || a.index >= packages.length || a.source !== packageIdentity(packages[a.index])) throw failure('package-history-unverified');
    failed = a.outcome !== null && a.outcome.code !== 'installed';
  }
}

/** Await facts only. Timeout never proves that a child or group stopped. */
async function packageExitBefore(exit: Promise<PackageExit>, started: number): Promise<PackageExit> {
  const remaining = 120000 - (performance.now() - started);
  if (remaining <= 0) throw failure('package-stop-unproven');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([exit, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(failure('package-stop-unproven')), remaining);
    })]);
  } catch { throw failure('package-stop-unproven'); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Trusted fixture-only D1 service. Production has no executor and refuses
 * before filesystem access. No CLI or environment path supplies the test seam.
 * All spawning/group facts here are injected fixtures, not real-install proof.
 * Package locks are purpose-specific and never stale-released by recovery.
 */
export async function runPackageAttempts(state: string, tx: string, opts: PackageRunOptions): Promise<PackageRunResult> {
  const executor = opts?.deps?.packageExecutor;
  if (typeof executor !== 'function') throw failure('package-executor-unavailable');
  if (!opts.expectedTargets) throw invalid('target-context-required');
  if (typeof tx !== 'string' || !TX_RE.test(tx)) throw invalid('tx-invalid');
  if (!isTokenSyntax(opts.packageToken)) throw invalid('package-approval-token-invalid');
  if (typeof opts.verifyLockedPackageIntent !== 'function' || !Array.isArray(opts.protectedRoots)) throw invalid('package-options-invalid');
  const { deps, live, dir, expected } = openState(state, opts);
  let uid: number;
  try { uid = deps.uid(); } catch { throw failure('package-owner-unavailable'); }
  const stateId = packageDirAt(dir, uid);
  let owner: PackageOwner;
  try {
    const hostname = hostnameOf(deps), bootId = bootIdOf(deps), pid = deps.pid();
    if (!hostname || !bootId || !Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(uid) || uid < 0 ||
        deps.platform !== 'darwin' && deps.platform !== 'linux' || typeof deps.probeGroup !== 'function') throw failure('package-owner-unavailable');
    owner = { pid, uid, hostname, bootId, platform: deps.platform };
  } catch { throw failure('package-owner-unavailable'); }
  const protectedRoots = opts.protectedRoots.map(p => {
    const arg = requireAbsolute(p, 'usage'); guardLiveLexical(arg, live);
    return existingDir(arg, 'protected-root-missing').path;
  });
  const tool = toolRoot(); if (tool !== null) protectedRoots.push(tool);
  for (const root of protectedRoots) for (const own of [dir, expected!.agent, ...(expected!.lens ? [expected!.lens] : [])]) {
    if (overlaps(root, own)) throw invalid('roots-overlap');
  }
  if (overlaps(dir, expected!.agent) || expected!.lens && overlaps(dir, expected!.lens)) throw invalid('roots-overlap');
  requireNoPackageAttempt(dir);
  if (lstatQuiet(path.join(dir, GATE_NAME)) !== null) throw failure('gate-held');
  const lockFile = path.join(dir, LOCK_NAME);
  const lockContent = Buffer.from(`${canonicalJson({ schemaVersion: 1, kind: PACKAGE_LOCK_KIND, role: 'state', tx, ...owner })}\n`);
  // No cleanup adopts a lock whose exclusive-create primitive did not return.
  let lockStat: fs.BigIntStats | 'exists';
  try { lockStat = createExclusive(deps, 'pkglock-create', 'package-lock-failed', lockFile, lockContent); }
  catch { throw failure('package-lock-failed'); }
  if (lockStat === 'exists') throw failure('lock-held');
  if (!privateFileOk(lockStat, uid) || lockStat.birthtimeNs <= 0n) throw failure('package-lock-failed');
  const cap: PackageCapability = { state: stateId, lock: fileId(lockStat), ledger: null, attempt: null };
  let retain = false;
  const workRoot = path.join(dir, WORK_NAME);
  let workParent: DirId | null = null;
  let active: { dir: string; id: DirId; dirs: Map<string, DirId>; configs: Map<string, FileId> } | null = null;
  // Recheck live file capabilities too: directory identity alone does not
  // retain writer authority after an await or a fixture-injected replacement.
  const checkDirs = (): void => {
    packageDirAt(dir, uid, stateId);
    const held = lstatQuiet(lockFile);
    if (!held || held === 'error' || !privateFileOk(held, uid) || !sameFile(held, cap.lock)) throw failure('package-attempt-unresolved');
    if (cap.ledger !== null) {
      const st = lstatQuiet(path.join(dir, LEDGER_NAME));
      if (!st || st === 'error' || !privateFileOk(st, uid) || !sameFile(st, cap.ledger)) throw failure('package-attempt-unresolved');
    }
    const attempt = lstatQuiet(path.join(dir, ATTEMPT_NAME));
    if (cap.attempt === null ? attempt !== null : !attempt || attempt === 'error' || !privateFileOk(attempt, uid) || !sameFile(attempt, cap.attempt)) throw failure('package-attempt-unresolved');
    if (workParent) packageDirAt(workRoot, uid, workParent);
    if (active) {
      packageDirAt(active.dir, uid, active.id);
      for (const [name, id] of active.dirs) packageDirAt(path.join(active.dir, name), uid, id);
      for (const [name, id] of active.configs) {
        const r = readProven(path.join(active.dir, name), 1n, 0);
        if (!r || !privateFileOk(r.st, uid) || !sameFile(r.st, id) || r.bytes.length !== 0) throw failure('package-work-changed');
      }
    }
  };
  const release = (): void => {
    checkDirs();
    const removed = unlinkProven(deps, 'pkglock-release', 'package-lock-release-failed', lockFile, st => privateFileOk(st, uid) && sameFile(st, cap.lock));
    if (removed !== 'removed') throw failure('package-lock-release-failed');
    syncDir(deps, 'pkglock-release-sync', 'package-lock-release-failed', dir);
    packageDirAt(dir, uid, stateId);
  };
  const observeGroup = (pgid: number): 'alive' | 'esrch' | 'eperm' | 'unknown' => {
    try { return deps.probeGroup?.(pgid) ?? 'unknown'; } catch { return 'unknown'; }
  };
  try {
    syncDir(deps, 'pkglock-dirsync', 'package-lock-failed', dir);
    const proof = readProven(lockFile, 1n, LOCK_LIMIT);
    if (!proof || !sameFile(proof.st, cap.lock) || !proof.bytes.equals(lockContent)) throw failure('package-lock-failed');
    let initial = analyze(dir, deps, live, { pkg: cap }, expected);
    if (initial.j === null || initial.j.tx !== tx) throw failure('state-corrupt');
    if (initial.cls !== 'applied' || initial.j.platform !== owner.platform) throw failure('restore-not-applied');
    const j = initial.j;
    const jr = readProven(path.join(dir, JOURNAL_NAME), 1n, MIB);
    if (!jr || canonicalJson(parseJournal(jr.bytes)) !== canonicalJson(j)) throw failure('state-corrupt');
    const journalId = fileId(jr.st), journalDigest = sha256Hex(jr.bytes);
    const packages = restoredPackages(j);
    verifyPackageConsent(opts, j, packages);
    const old = initial.packageLedger;
    if (old) { verifyPackageHistory(old.value, packages); cap.ledger = old.id; workParent = old.value.workParent; }
    const checkCurrent = (): void => {
      checkDirs();
      const a = analyze(dir, deps, live, { pkg: cap }, expected);
      if (a.j === null || a.j.tx !== tx || a.cls !== 'applied') throw failure('package-config-drift');
      const r = readProven(path.join(dir, JOURNAL_NAME), 1n, MIB);
      if (!r || !sameFile(r.st, journalId) || sha256Hex(r.bytes) !== journalDigest) throw failure('package-config-drift');
      verifyPackageConsent(opts, a.j, packages);
    };
    if (packages.length === 0) { checkCurrent(); release(); return { tx, status: 'completed', attempted: 0, installed: 0, failed: null }; }
    const count = old?.value.nextSeq ?? 0, run = old?.value.runs.length ?? 0;
    if (run >= MAX_RUNS || count + packages.length > MAX_ATTEMPTS) throw failure('package-attempt-limit');
    if (old) {
      const known = new Map(old.value.attempts.map(a => [a.work.name, a.work.id]));
      const directory = fs.opendirSync(workRoot);
      let entries = 0;
      try {
        for (;;) {
          const e = directory.readSync(); if (!e) break;
          if (++entries > MAX_ATTEMPTS || !known.has(e.name)) throw failure('package-work-changed');
          const id = known.get(e.name); if (!id) throw failure('package-work-changed');
          packageDirAt(path.join(workRoot, e.name), uid, id);
        }
      } finally { directory.closeSync(); }
      if (entries !== known.size) throw failure('package-work-changed');
    }
    const wide: DirId = { dev: '9'.repeat(20), ino: '9'.repeat(20), birthtimeNs: '9'.repeat(20) };
    const header = { run, state: 'open' as const, packageToken: opts.packageToken, lock: cap.lock, owner };
    const base: PackageLedger = old?.value ?? { schemaVersion: 1, kind: LEDGER_KIND, tool: TOOL_ID, tx, planToken: j.planToken,
      workParent: wide, nextSeq: 0, runs: [], attempts: [] };
    // Preflight every future terminal representation before non-lock writes.
    ledgerBytes({ ...base, workParent: wide, nextSeq: count + packages.length, runs: [...base.runs, header],
      attempts: [...base.attempts, ...packages.map((p, index) => ({ seq: count + index, run, index, source: packageIdentity(p),
        work: { name: `w${count + index}-${'f'.repeat(16)}`, id: wide },
        outcome: { code: 'output-limit' as const, exit: { code: null, signal: 'SIGKILL' as const, stdoutBytes: MIB + 1, stderrBytes: MIB + 1 } } }))] });
    for (let index = 0; index < packages.length; index++) attemptBytes({ schemaVersion: 1, kind: ATTEMPT_KIND, tool: TOOL_ID, tx,
      planToken: j.planToken, packageToken: opts.packageToken, seq: count + index, run, index, source: packageIdentity(packages[index]), owner,
      work: { name: `w${count + index}-${'f'.repeat(16)}`, id: wide }, phase: 'config-verified',
      child: { pid: Number.MAX_SAFE_INTEGER, pgid: Number.MAX_SAFE_INTEGER },
      exit: { code: null, signal: 'SIGKILL', stdoutBytes: MIB + 1, stderrBytes: MIB + 1, timedOut: false, overflow: false } });
    retain = true;
    if (!workParent) {
      if (mkdirExclusive(deps, 'work-root-mkdir', 'package-work-changed', workRoot) === 'exists') throw failure('package-work-changed');
      syncDir(deps, 'work-root-sync', 'package-work-changed', dir);
      workParent = packageDirAt(workRoot, uid);
    }
    let ledger: PackageLedger = parseLedger(ledgerBytes({ ...base, workParent, runs: [...base.runs, header] }));
    const saveLedger = (): void => {
      checkDirs();
      cap.ledger = replacePrivate(deps, dir, 'ledger', cap.ledger, ledgerBytes(ledger));
    };
    saveLedger();
    let attempted = 0, installed = 0;
    let failed: PackageRunResult['failed'] = null;
    for (let index = 0; index < packages.length; index++) {
      checkCurrent();
      const seq = ledger.nextSeq, suffix = deps.randomHex(8);
      if (!/^[0-9a-f]{16}$/.test(suffix)) throw failure('random-failed');
      const name = `w${seq}-${suffix}`, source = packageIdentity(packages[index]);
      ledger.attempts.push({ seq, run, index, source, work: { name, id: null }, outcome: null });
      ledger.nextSeq++;
      saveLedger();
      const wd = path.join(workRoot, name);
      if (mkdirExclusive(deps, 'work-mkdir', 'package-work-changed', wd) === 'exists') throw failure('package-work-changed');
      active = { dir: wd, id: packageDirAt(wd, uid), dirs: new Map(), configs: new Map() };
      for (const name of ['cwd', 'tmp', 'cache']) {
        const sub = path.join(wd, name);
        if (mkdirExclusive(deps, 'work-mkdir', 'package-work-changed', sub) === 'exists') throw failure('package-work-changed');
        active.dirs.set(name, packageDirAt(sub, uid));
        syncDir(deps, 'work-dirsync', 'package-work-changed', wd);
      }
      for (const name of ['userconfig', 'globalconfig']) {
        const st = createExclusive(deps, 'work-file', 'package-work-changed', path.join(wd, name), Buffer.alloc(0));
        if (st === 'exists' || !privateFileOk(st, uid) || st.birthtimeNs <= 0n) throw failure('package-work-changed');
        active.configs.set(name, fileId(st));
      }
      syncDir(deps, 'work-dirsync', 'package-work-changed', wd);
      syncDir(deps, 'work-dirsync', 'package-work-changed', workRoot);
      checkCurrent();
      let record: AttemptRecord = { schemaVersion: 1, kind: ATTEMPT_KIND, tool: TOOL_ID, tx, planToken: j.planToken, packageToken: opts.packageToken,
        seq, run, index, source, owner, work: { name, id: active.id }, phase: 'intent', child: null, exit: null };
      const content = attemptBytes(record);
      const st = createExclusive(deps, 'attempt-create', 'package-attempt-write-failed', path.join(dir, ATTEMPT_NAME), content);
      if (st === 'exists' || !privateFileOk(st, uid) || st.birthtimeNs <= 0n) throw failure('package-attempt-unresolved');
      syncDir(deps, 'attempt-dirsync', 'package-attempt-write-failed', dir);
      const intent = readProven(path.join(dir, ATTEMPT_NAME), 1n, content.length);
      if (!intent || !sameFile(intent.st, fileId(st)) || !intent.bytes.equals(content)) throw failure('package-attempt-unresolved');
      cap.attempt = fileId(intent.st);
      const advance = (next: AttemptRecord): void => {
        checkDirs(); checkAdvance(record, next);
        const id = replacePrivate(deps, dir, 'attempt', cap.attempt, attemptBytes(next));
        cap.attempt = id; record = parseAttempt(attemptBytes(next));
      };
      checkCurrent();
      const started = performance.now();
      let spawned: ReturnType<NonNullable<TxDeps['packageExecutor']>>;
      try {
        spawned = executor({ source, agentDir: j.targets.agent, timeoutMs: 120000,
          work: { cwd: path.join(wd, 'cwd'), tmp: path.join(wd, 'tmp'), cache: path.join(wd, 'cache'),
            userconfig: path.join(wd, 'userconfig'), globalconfig: path.join(wd, 'globalconfig') } });
        if (!spawned || !Number.isSafeInteger(spawned.pid) || spawned.pid <= 1 || !(spawned.exit instanceof Promise)) throw failure('package-spawn-unresolved');
      } catch { throw failure('package-spawn-unresolved'); }
      // Observe rejections immediately, including failures before spawned publication.
      void spawned.exit.catch(() => {});
      if (observeGroup(spawned.pid) !== 'alive') throw failure('package-spawn-unresolved');
      try { advance({ ...record, phase: 'spawned', child: { pid: spawned.pid, pgid: spawned.pid } }); }
      catch {
        await packageExitBefore(spawned.exit, started);
        throw failure('package-attempt-write-failed');
      }
      attempted++;
      const facts = await packageExitBefore(spawned.exit, started);
      checkDirs();
      if (observeGroup(spawned.pid) !== 'esrch') throw failure('package-stop-unproven');
      advance({ ...record, phase: 'stopped-proven', exit: facts });
      checkCurrent();
      advance({ ...record, phase: 'config-verified' });
      const e = record.exit!;
      // Raw flags are diagnostic: the service independently enforces each cap.
      const outcome = outcomeForExit({ ...e, overflow: e.overflow || e.stdoutBytes > MIB || e.stderrBytes > MIB });
      ledger.attempts[seq] = { seq, run, index, source, work: { name, id: active.id }, outcome };
      saveLedger();
      checkCurrent();
      const removed = unlinkProven(deps, 'attempt-unlink', 'package-attempt-retained', path.join(dir, ATTEMPT_NAME), s => cap.attempt !== null && privateFileOk(s, uid) && sameFile(s, cap.attempt));
      if (removed !== 'removed') throw failure('package-attempt-retained');
      syncDir(deps, 'attempt-unlink-dirsync', 'package-attempt-retained', dir);
      cap.attempt = null;
      if (outcome.code === 'installed') installed++;
      else { failed = { index, reason: outcome.code }; break; }
      active = null;
    }
    checkCurrent();
    ledger.runs[run].state = 'closed';
    saveLedger();
    release();
    return { tx, status: failed === null ? 'completed' : 'install-failed', attempted, installed, failed };
  } catch (e) {
    if (!retain) bestEffort(release);
    // No injected exception payload, including a custom ToolError, is output.
    const safe = new Set(['state-corrupt', 'restore-not-applied', 'package-approval-mismatch', 'package-attempt-limit', 'package-history-unverified',
      'package-work-changed', 'package-lock-failed', 'package-lock-release-failed', 'package-attempt-unresolved', 'package-config-drift',
      'package-ledger-write-failed', 'package-attempt-write-failed', 'package-attempt-retained', 'package-stop-unproven', 'package-spawn-unresolved',
      'package-attempt-invalid', 'package-ledger-invalid', 'package-attempt-transition', 'filesystem-error', 'random-failed', 'target-context-mismatch']);
    if (e instanceof ToolError && safe.has(e.code)) throw failure(e.code);
    throw failure('package-restore-failed');
  }
}
