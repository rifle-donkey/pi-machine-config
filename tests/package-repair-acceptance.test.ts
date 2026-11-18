/** Independent acceptance tests for the approved N1–N5 fixture-only repair. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { parseAttempt, parseLedger, type PackageExit } from '../src/package-attempt.ts';
import type { PackageDecl, Platform } from '../src/schema.ts';
import { applyRestore, inspectRestore, resolveRestore, rollbackRestore, runPackageAttempts,
  type LockedPackages, type PackageRunOptions } from '../src/transaction.ts';
import { fileId, type PackageExecutor, type PackageSpawnSpec, type PidProbe, type TxDeps } from '../src/transaction-fs.ts';

const PLAN = `sha256:${'a'.repeat(64)}`, TOKEN = `sha256:${'b'.repeat(64)}`, OTHER = `sha256:${'c'.repeat(64)}`;
const BOOT = '11111111-2222-4333-8444-555555555555';
const PID = 4_100_001, START = 34_567, INSTALL = 120_000, STOP = 150_000;
const GOOD: PackageExit = { code: 0, signal: null, stdoutBytes: 17, stderrBytes: 2, timedOut: false, overflow: false };
const TIMED_OUT: PackageExit = { ...GOOD, code: null, signal: 'SIGTERM', timedOut: true };
const SOURCES: PackageDecl[] = ['npm:qa-one', { source: 'npm:qa-two', autoload: false, skills: ['+skills/a'] }];

function fixture(t: TestContext, lens = false) {
  const forbidden = () => assert.fail('real process API is out of scope');
  const spies = [t.mock.method(process, 'kill', forbidden),
    ...(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
      .map(name => t.mock.method(childProcess, name, forbidden))];
  syncBuiltinESMExports();
  t.after(() => {
    try { for (const spy of spies) assert.equal(spy.mock.callCount(), 0); }
    finally { for (const spy of spies) spy.mock.restore(); syncBuiltinESMExports(); }
  });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-n-repair-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.ok(!fs.existsSync(root)); });
  const home = path.join(root, 'home'), state = path.join(root, 'state');
  const agentParent = path.join(root, 'agent-parent'), lensParent = path.join(root, 'lens-parent');
  for (const dir of [home, agentParent, lensParent]) fs.mkdirSync(dir);
  const agent = path.join(agentParent, 'agent'), lensPath = lens ? path.join(lensParent, 'config.json') : null;
  const deps: TxDeps = { platform: process.platform, bootId: () => BOOT, hostname: () => 'fixture-host',
    uid: () => process.getuid!(), pid: () => 4_000_001, probePid: () => 'esrch', fault: () => {}, randomHex: n => randomBytes(n).toString('hex') };
  const common = { env: {}, guard: { home }, expectedTargets: { agent, lens: lensPath }, deps };
  const bytes = Buffer.from('{"fixture":true}\n');
  const { tx } = applyRestore({ planToken: PLAN, platform: process.platform as Platform, state, agentTarget: agent,
    lensTarget: lensPath, settings: { theme: 'dark' }, packages: SOURCES, protectedRoots: [], files: lens ? [
      { root: 'lens-config', path: 'config.json', class: 'external-config', bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
    ] : [] }, common);
  const opts: PackageRunOptions = { ...common, packageToken: TOKEN, protectedRoots: [], verifyLockedPackageIntent: () => TOKEN };
  const journal = path.join(state, 'journal.json'), gate = path.join(state, 'package-attempt.json');
  const lock = path.join(state, 'lock.json'), ledger = path.join(state, 'package-ledger.json');
  const config = [path.join(agent, 'settings.json'), ...(lensPath === null ? [] : [lensPath])];
  const before = [journal, ...config].map(p => fs.readFileSync(p));
  return { root, home, state, tx, opts, common, agentParent, lensParent, gate, lock, ledger, journal,
    unchanged: () => assert.deepEqual([journal, ...config].map(p => fs.readFileSync(p)), before),
    journalUnchanged: () => assert.deepEqual(fs.readFileSync(journal), before[0]) };
}
type Fixture = ReturnType<typeof fixture>;
const readGate = (f: Fixture) => parseAttempt(fs.readFileSync(f.gate));
const readLedger = (f: Fixture) => parseLedger(fs.readFileSync(f.ledger));
const lockId = (f: Fixture) => fileId(fs.lstatSync(f.lock, { bigint: true }));
const errorCode = (code: string) => (e: unknown) => e instanceof ToolError && e.code === code;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Changing observed time does not dispatch timers. Tests decide which happens first. */
function fakeClock(t: TestContext) {
  let now = START, next = 0;
  const pending = new Map<number, { at: number; fire: () => void }>();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', ((fire: () => void, ms: number) => {
    const id = ++next;
    pending.set(id, { at: now + ms, fire });
    return id;
  }) as unknown as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', (id: number) => { pending.delete(id); });
  t.after(() => assert.equal(pending.size, 0, 'no pending service timers'));
  return { now: () => now, set: (time: number) => { now = time; }, due: () => [...pending.values()].map(x => x.at),
    fireDue() { for (const [id, timer] of pending) if (timer.at <= now) { pending.delete(id); timer.fire(); } } };
}

function driver(f: Fixture, options: {
  result?: (exit: Promise<PackageExit>) => ReturnType<PackageExecutor>;
  group?: (call: number) => PidProbe;
  spawn?: () => void;
  fault?: TxDeps['fault'];
} = {}) {
  const requests: PackageSpawnSpec[] = [], exits: ReturnType<typeof deferred<PackageExit>>[] = [], groups: number[] = [];
  const secondSpawn = deferred<void>();
  f.opts.deps = { ...f.common.deps, fault: options.fault ?? (() => {}),
    packageExecutor: spec => {
      requests.push(structuredClone(spec));
      const exit = deferred<PackageExit>(); exits.push(exit);
      options.spawn?.();
      if (exits.length === 2) secondSpawn.resolve();
      return options.result?.(exit.promise) ?? { pid: PID, exit: exit.promise };
    },
    probeGroup: pgid => { groups.push(pgid); return options.group?.(groups.length) ?? (groups.length % 2 ? 'alive' : 'esrch'); },
  };
  const run = runPackageAttempts(f.state, f.tx, f.opts);
  // Observe early failures even if a synchronous fixture assertion fails before awaiting run.
  void run.catch(() => {});
  return { requests, exits, groups, run, waitForSecond: () => Promise.race([secondSpawn.promise,
    run.then(() => assert.fail('run ended before second attempt'))]) };
}
function assertSpec(spec: PackageSpawnSpec, start: number) {
  // Structural view lets this acceptance suite type-check against the pre-repair base.
  const deadlines: Partial<PackageSpawnSpec & { installDeadline: number; stopDeadline: number }> = spec;
  assert.equal(spec.timeoutMs, INSTALL);
  assert.equal(deadlines.installDeadline, start + INSTALL);
  assert.equal(deadlines.stopDeadline, start + STOP);
}
function retained(f: Fixture, id: ReturnType<typeof lockId>, phase: 'intent' | 'spawned' | 'stopped-proven') {
  assert.deepEqual(lockId(f), id);
  assert.equal(readGate(f).phase, phase);
  const ledger = readLedger(f);
  assert.equal(ledger.runs[0].state, 'open');
  assert.equal(ledger.attempts.length, 1, 'no retry or second declaration');
  assert.equal(ledger.attempts[0].outcome, null);
  f.journalUnchanged();
}
function excluded(f: Fixture) {
  // The raw state API can check exclusion without rebinding the possibly missing target parent.
  const opts = { ...f.common, expectedTargets: undefined, deps: { ...f.common.deps,
    bootId: () => '99999999-2222-4333-8444-555555555555', probePid: () => assert.fail('not a stale PID lock') } };
  const files = [f.lock, f.gate, f.ledger, f.journal];
  const before = files.map(p => fs.readFileSync(p));
  const inspection = inspectRestore(f.state, opts);
  assert.equal(inspection.reason, 'package-attempt-unresolved'); assert.deepEqual(inspection.actions, []);
  assert.throws(() => rollbackRestore(f.state, f.tx, opts), errorCode('state-corrupt'));
  assert.throws(() => resolveRestore(f.state, { tx: f.tx, expect: 'lock-stale', action: 'release-lock' }, opts),
    errorCode('state-corrupt'));
  assert.deepEqual(files.map(p => fs.readFileSync(p)), before);
}
function closed(f: Fixture) {
  assert.equal(fs.existsSync(f.gate), false); assert.equal(fs.existsSync(f.lock), false);
  assert.equal(inspectRestore(f.state, f.common).class, 'applied');
  f.unchanged();
  const ledger = readLedger(f); assert.equal(ledger.runs[0].state, 'closed'); return ledger;
}

const bounded = { timeout: 5000 };

test('N1: observe the native exit promise before reading an invalid PID', bounded, async t => {
  const f = fixture(t);
  const exit = deferred<PackageExit>();
  const then = t.mock.method(exit.promise, 'then');
  let observersAtPid: number | undefined;
  const d = driver(f, { result: () => ({ exit: exit.promise, get pid() {
    observersAtPid = then.mock.calls.filter(c => typeof c.arguments[1] === 'function').length;
    return 1;
  } }) });
  const id = lockId(f);
  // Attach the test's own observer only after the service had to observe the promise.
  // This makes the negative baseline safe without allowing the sentry to satisfy the assertion.
  const sentinel = new Error('fixture exit rejection');
  const handled = assert.rejects(exit.promise, error => error === sentinel);
  exit.reject(sentinel);
  await handled;
  await assert.rejects(d.run, errorCode('package-spawn-unresolved'));
  assert.deepEqual(d.groups, []);
  retained(f, id, 'intent'); excluded(f); f.unchanged();
  assert.ok(observersAtPid !== undefined && observersAtPid > 0);
});

test('N2: absolute deadlines start just before each executor call, not at run entry', bounded, async t => {
  const f = fixture(t), clock = fakeClock(t);
  const starts = [START + 6_000, START + STOP + 50_000];
  let index = 0;
  const d = driver(f, { fault: point => { if (point === 'attempt-dirsync') clock.set(starts[index++]); },
    spawn: () => clock.set(clock.now() + 5_000) });
  const firstDue = clock.due();
  d.exits[0].resolve(GOOD);
  await d.waitForSecond();
  const secondDue = clock.due();
  clock.set(starts[1] + STOP - 1); d.exits[1].resolve(GOOD);
  assert.deepEqual(await d.run, { tx: f.tx, status: 'completed', attempted: 2, installed: 2, failed: null });
  assertSpec(d.requests[0], starts[0]); assertSpec(d.requests[1], starts[1]);
  assert.deepEqual(firstDue, [starts[0] + STOP], 'executor overhead is part of the same time budget');
  assert.deepEqual(secondDue, [starts[1] + STOP], 'only the second attempt timer is pending');
  assert.deepEqual(d.groups, [PID, PID, PID, PID]);
  assert.deepEqual(closed(f).attempts.map(a => a.outcome?.code), ['installed', 'installed']);
});

for (const [name, offset, facts] of [
  ['early installer timeout', INSTALL - 1, TIMED_OUT],
  ['confirmed installer timeout during cleanup window', INSTALL + 7_000, TIMED_OUT],
  ['non-timeout exit observed just before stop deadline', STOP - 1, { ...GOOD, code: 7 }],
] as const) test(`N2: ${name}`, bounded, async t => {
  const f = fixture(t), clock = fakeClock(t), d = driver(f);
  clock.set(START + offset); clock.fireDue(); d.exits[0].resolve(facts);
  const reason = facts.timedOut ? 'timeout' : 'exit-nonzero';
  assert.deepEqual(await d.run, { tx: f.tx, status: 'install-failed', attempted: 1, installed: 0, failed: { index: 0, reason } });
  assert.deepEqual(d.groups, [PID, PID]); assert.equal(d.requests.length, 1);
  assert.deepEqual(closed(f).attempts.map(a => a.outcome?.code), [reason]);
});

test('N2: backstop fires at 150s with no exit; later timeout facts cannot reopen the run', bounded, async t => {
  const f = fixture(t), clock = fakeClock(t), d = driver(f);
  const id = lockId(f);
  const initialDue = clock.due();
  clock.set(START + STOP - 1); clock.fireDue();
  const pendingAtBoundary = clock.due();
  clock.set(START + STOP); clock.fireDue();
  await assert.rejects(d.run, errorCode('package-stop-unproven'));
  assert.deepEqual(initialDue, [START + STOP]); assert.deepEqual(pendingAtBoundary, [START + STOP]);
  const before = fs.readFileSync(f.gate);
  d.exits[0].resolve(TIMED_OUT); await d.exits[0].promise;
  assert.deepEqual(fs.readFileSync(f.gate), before);
  assert.deepEqual(d.groups, [PID]); assert.equal(d.requests.length, 1);
  retained(f, id, 'spawned'); excluded(f); f.unchanged();
});

for (const [name, pre, post, probes] of [
  ['exit sampled at the stop deadline before timer dispatch', STOP, undefined, 1],
  ['exit sampled after the stop deadline before timer dispatch', STOP + 1, undefined, 1],
  ['absence observed at the stop deadline', STOP - 1, STOP, 2],
  ['absence observed after the stop deadline', STOP - 1, STOP + 1, 2],
  ['non-finite clock before the stop probe', NaN, undefined, 1],
  ['non-finite clock after the stop probe', STOP - 1, Infinity, 2],
  ['clock regresses below start', -1, undefined, 1],
  ['clock regresses across the stop probe, still above start', STOP - 1, STOP - 2, 2],
] as const) test(`N2: reject ${name}`, bounded, async t => {
  const f = fixture(t), clock = fakeClock(t);
  const d = driver(f, { group: call => {
    if (call === 1) return 'alive';
    if (post !== undefined) clock.set(START + post);
    return 'esrch';
  } });
  const id = lockId(f);
  clock.set(START + pre); d.exits[0].resolve(TIMED_OUT);
  await assert.rejects(d.run, errorCode('package-stop-unproven'));
  assert.equal(d.groups.length, probes); assert.equal(d.requests.length, 1);
  retained(f, id, 'spawned'); f.unchanged();
});

for (const observation of ['alive', 'eperm', 'unknown', 'throw'] as const)
  test(`N2: installer timeout does not replace independent group proof (${observation})`, bounded, async t => {
    const f = fixture(t), clock = fakeClock(t);
    const d = driver(f, { group: call => {
      if (call === 1) return 'alive';
      if (observation === 'throw') throw new Error('fixture group failure');
      return observation;
    } });
    const id = lockId(f);
    clock.set(START + INSTALL + 1); d.exits[0].resolve(TIMED_OUT);
    await assert.rejects(d.run, errorCode('package-stop-unproven'));
    assert.deepEqual(d.groups, [PID, PID], 'one initial and one post-exit probe; no polling');
    retained(f, id, 'spawned'); f.unchanged();
  });

test('N2: rejected exit cancels the backstop and retains exclusion', bounded, async t => {
  const f = fixture(t); fakeClock(t);
  const d = driver(f), id = lockId(f);
  d.exits[0].reject(new Error('fixture exit unavailable'));
  await assert.rejects(d.run, errorCode('package-stop-unproven'));
  assert.deepEqual(d.groups, [PID]); retained(f, id, 'spawned'); f.unchanged();
});

test('N2: timely group absence cannot replace valid exit facts', bounded, async t => {
  const f = fixture(t); fakeClock(t);
  const d = driver(f), id = lockId(f);
  // Code and signal are each valid values, but cannot both describe one leader exit.
  d.exits[0].resolve({ ...TIMED_OUT, code: 0 });
  await assert.rejects(d.run, ToolError);
  retained(f, id, 'spawned'); f.unchanged();
});

test('N2: durable writes after timely proof have no stop-proof deadline', bounded, async t => {
  const f = fixture(t), clock = fakeClock(t);
  let afterProof = false;
  const d = driver(f, { fault: point => {
    if (point === 'attempt-rename-dirsync' && readGate(f).phase === 'stopped-proven') {
      clock.set(START + STOP + 100_000); afterProof = true;
    }
  } });
  clock.set(START + STOP - 1); d.exits[0].resolve(TIMED_OUT);
  assert.equal((await d.run).failed?.reason, 'timeout'); assert.ok(afterProof);
  assert.deepEqual(d.groups, [PID, PID]); closed(f);
});

test('N3: snapshot consent token and verifier once; keep receiver and original audit headers', bounded, async t => {
  const f = fixture(t); fakeClock(t);
  let token = TOKEN, tokenReads = 0, verifierReads = 0, originalCalls = 0, alternateCalls = 0;
  const original = function (this: PackageRunOptions, locked: LockedPackages) {
    assert.equal(this, f.opts); originalCalls++;
    assert.deepEqual(structuredClone(locked), { tx: f.tx, planToken: PLAN, packages: SOURCES });
    assert.equal(fs.existsSync(f.lock), true);
    return TOKEN;
  };
  let verifier = original;
  Object.defineProperties(f.opts, { packageToken: { get() { tokenReads++; return token; } },
    verifyLockedPackageIntent: { get() { verifierReads++; return verifier; } } });
  const d = driver(f);
  assert.equal(readGate(f).packageToken, TOKEN);
  const beforeExit = originalCalls;
  token = OTHER; verifier = () => { alternateCalls++; return OTHER; };
  d.exits[0].resolve(GOOD);
  await d.waitForSecond();
  const secondToken = readGate(f).packageToken; d.exits[1].resolve(GOOD);
  assert.equal((await d.run).status, 'completed');
  assert.equal(secondToken, TOKEN);
  assert.ok(originalCalls > beforeExit, 'original verifier rechecks consent after awaiting');
  assert.deepEqual([tokenReads, verifierReads, alternateCalls], [1, 1, 0]);
  assert.deepEqual(closed(f).runs.map(r => r.packageToken), [TOKEN]);
});

test('N3: original verifier recomputes consent rather than caching a successful result', bounded, async t => {
  const f = fixture(t); fakeClock(t);
  let current = TOKEN, replacementCalls = 0;
  f.opts.verifyLockedPackageIntent = () => current;
  const d = driver(f), id = lockId(f);
  current = OTHER; f.opts.verifyLockedPackageIntent = () => { replacementCalls++; return TOKEN; };
  d.exits[0].resolve({ ...GOOD, code: 5 });
  await assert.rejects(d.run, errorCode('package-approval-mismatch'));
  assert.equal(replacementCalls, 0); assert.equal(d.requests.length, 1);
  retained(f, id, 'stopped-proven'); excluded(f); f.unchanged();
});

test('N4: use one executor PID and exit promise snapshot for group probes and spawned record', bounded, async t => {
  const f = fixture(t); fakeClock(t);
  let pidReads = 0, exitReads = 0;
  const alternate = Promise.resolve({ ...GOOD, code: 7 });
  const d = driver(f, { result: exit => ({ get pid() { return pidReads++ === 0 ? PID : PID + 1; },
    get exit() { return exitReads++ === 0 ? exit : alternate; } }) });
  const actual = { ...readGate(f).child };
  d.exits[0].resolve({ ...GOOD, code: 5 });
  assert.equal((await d.run).failed?.reason, 'exit-nonzero');
  assert.deepEqual(actual, { pid: PID, pgid: PID }); assert.deepEqual(d.groups, [PID, PID]);
  assert.deepEqual([pidReads, exitReads], [1, 1]);
  assert.equal(closed(f).attempts[0].outcome?.exit.code, 5);
});

test('N4: one validated exit snapshot drives both attempt phases and ledger outcome', bounded, async t => {
  const f = fixture(t); fakeClock(t);
  const records: ReturnType<typeof readGate>[] = [];
  const d = driver(f, { fault: point => {
    if (point === 'attempt-rename-dirsync') records.push(readGate(f));
  } });
  let timeFlagReads = 0, byteReads = 0;
  const changing: PackageExit = { ...TIMED_OUT, get timedOut() { return ++timeFlagReads === 1; },
    get stdoutBytes() { return ++byteReads === 1 ? TIMED_OUT.stdoutBytes : 23; } };
  d.exits[0].resolve(changing);
  assert.equal((await d.run).failed?.reason, 'timeout');
  const terminal = records.filter(r => r.exit !== null);
  assert.deepEqual(terminal.map(r => r.phase), ['stopped-proven', 'config-verified']);
  assert.deepEqual(terminal.map(r => ({ ...r.exit })), [TIMED_OUT, TIMED_OUT]);
  const { timedOut: _timedOut, overflow: _overflow, ...exit } = TIMED_OUT;
  const actual = closed(f).attempts[0].outcome;
  assert.deepEqual(actual && { code: actual.code, exit: { ...actual.exit } }, { code: 'timeout', exit });
  assert.deepEqual([timeFlagReads, byteReads], [1, 1]);
});

function moveParent(parent: string, to: string, kind: 'absent' | 'identity' | 'canonical') {
  fs.renameSync(parent, to);
  if (kind === 'identity') fs.mkdirSync(parent);
  if (kind === 'canonical') fs.symlinkSync(to, parent);
}
for (const target of ['agent', 'lens'] as const) for (const kind of ['absent', 'identity', 'canonical'] as const)
  test(`N5: ${target} recorded parent ${kind} retains exclusion as package-config-drift`, bounded, async t => {
    const f = fixture(t, true); fakeClock(t);
    const d = driver(f), id = lockId(f);
    const parent = target === 'agent' ? f.agentParent : f.lensParent;
    moveParent(parent, path.join(f.root, 'relocated-parent'), kind);
    d.exits[0].resolve(TIMED_OUT); // Proven stop does not override config verification.
    await assert.rejects(d.run, errorCode('package-config-drift'));
    assert.deepEqual(d.groups, [PID, PID]); assert.equal(d.requests.length, 1);
    retained(f, id, 'stopped-proven'); excluded(f);
  });

for (const errno of ['EACCES', 'EIO'] as const)
  test(`N5: ${errno} on resolving a recorded parent is not evidence of drift`, bounded, async t => {
    const f = fixture(t, true); fakeClock(t);
    const d = driver(f), id = lockId(f);
    const resolve = fs.realpathSync.native;
    const spy = t.mock.method(fs.realpathSync, 'native', (p: Parameters<typeof resolve>[0], ...args: unknown[]) => {
      if (p === f.lensParent) throw Object.assign(new Error('fixture metadata failure'), { code: errno });
      return Reflect.apply(resolve, fs, [p, ...args]);
    });
    try {
      d.exits[0].resolve(GOOD);
      await assert.rejects(d.run, errorCode('package-restore-failed'));
      assert.ok(spy.mock.calls.some(c => c.arguments[0] === f.lensParent), 'fault reached');
    } finally { spy.mock.restore(); }
    retained(f, id, 'stopped-proven'); f.unchanged();
  });

test('N5: a protected canonical location still refuses, not as package-config-drift', bounded, async t => {
  const f = fixture(t), protectedParent = path.join(f.home, '.pi');
  fakeClock(t);
  const d = driver(f), id = lockId(f);
  // Only this synthetic fixture path is protected; no actual live location is accessed.
  moveParent(f.agentParent, protectedParent, 'canonical'); d.exits[0].resolve(GOOD);
  await assert.rejects(d.run, errorCode('package-restore-failed'));
  retained(f, id, 'stopped-proven'); excluded(f);
});

test('N5: before admission and in ordinary recovery, target-changed is not reclassified', bounded, async t => {
  const f = fixture(t, true);
  moveParent(f.lensParent, path.join(f.root, 'relocated-parent'), 'identity');
  assert.throws(() => inspectRestore(f.state, f.common), errorCode('target-changed'));
  assert.throws(() => rollbackRestore(f.state, f.tx, f.common), errorCode('target-changed'));
  assert.throws(() => resolveRestore(f.state, { tx: f.tx, expect: 'applied', action: 'rollback' }, f.common), errorCode('target-changed'));
  const d = driver(f);
  await assert.rejects(d.run, errorCode('package-restore-failed'));
  assert.deepEqual(d.requests, []);
  assert.deepEqual(fs.readdirSync(f.state), ['journal.json']); f.journalUnchanged();
});
