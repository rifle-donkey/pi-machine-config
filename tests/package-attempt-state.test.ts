/** Pure package state schemas: boundaries, immutable transitions and maximum serialized sizes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTEMPT_KIND, ATTEMPT_LIMIT, LEDGER_KIND, LEDGER_LIMIT, MAX_ATTEMPTS, MAX_RUNS,
  attemptBytes, checkAdvance, ledgerBytes, outcomeForExit, parseAttempt, parseLedger,
  type AttemptRecord, type PackageLedger, type PackageOwner, type PackageExit,
} from '../src/package-attempt.ts';
import { ToolError } from '../src/errors.ts';
import { TOOL_ID, MIB } from '../src/schema.ts';

const id = { dev: '1', ino: '2', birthtimeNs: '3' };
const lock = { ...id, ctimeNs: '4' };
const token = `sha256:${'a'.repeat(64)}`;
const owner: PackageOwner = {
  pid: 2, uid: 0, hostname: 'fixture', bootId: '11111111-2222-4333-8444-555555555555', platform: 'linux',
};
const exit: PackageExit = { code: 0, signal: null, stdoutBytes: 0, stderrBytes: 0, timedOut: false, overflow: false };
function attempt(): AttemptRecord {
  return { schemaVersion: 1, kind: ATTEMPT_KIND, tool: TOOL_ID, tx: 'a'.repeat(32),
    planToken: token, packageToken: token, seq: 0, run: 0, index: 0, source: 'npm:fixture',
    owner: { ...owner }, work: { name: `w0-${'a'.repeat(16)}`, id: { ...id } },
    phase: 'intent', child: null, exit: null };
}
function ledger(): PackageLedger {
  return { schemaVersion: 1, kind: LEDGER_KIND, tool: TOOL_ID, tx: 'a'.repeat(32), planToken: token,
    workParent: { ...id }, nextSeq: 0, runs: [], attempts: [] };
}
const rejection = (code: string) => (error: unknown) => error instanceof ToolError && error.exit === 1 && error.code === code && error.message === code;

function plain(v: unknown): unknown {
  return JSON.stringify(v);
}

test('attempt round-trip is canonical, fresh and null-prototype', () => {
  const a = attempt();
  const before = plain(a);
  const bytes = attemptBytes(a);
  assert.equal(bytes.at(-1), 10);
  const parsed = parseAttempt(bytes);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.getPrototypeOf(parsed.owner), null);
  assert.equal(Object.getPrototypeOf(parsed.work.id), null);
  assert.deepEqual(attemptBytes(parsed), bytes);
  assert.equal(plain(a), before);
  parsed.owner.hostname = 'changed';
  assert.equal(a.owner.hostname, 'fixture');
});

test('attempt transitions permit exactly one phase and preserve introduced evidence', () => {
  const a = attempt();
  const b: AttemptRecord = { ...a, phase: 'spawned', child: { pid: 3, pgid: 3 } };
  const c: AttemptRecord = { ...b, phase: 'stopped-proven', exit: { ...exit } };
  const d: AttemptRecord = { ...c, phase: 'config-verified' };
  checkAdvance(a, b); checkAdvance(b, c); checkAdvance(c, d);
  for (const [p, n] of [[a, a], [a, c], [c, b], [d, d], [b, { ...c, child: { pid: 4, pgid: 4 } }],
    [c, { ...d, exit: { ...exit, stdoutBytes: 1 } }], [a, { ...b, packageToken: `sha256:${'b'.repeat(64)}` }]]) {
    assert.throws(() => checkAdvance(p, n), rejection('package-attempt-transition'));
  }
});

test('strict parse errors and record shapes never disclose input', () => {
  for (const text of ['{"private-sentinel":1,"private-sentinel":2}', '{"__proto__":0}', '\ufeff{}', '{"n":9007199254740992}']) {
    assert.throws(() => parseAttempt(Buffer.from(text)), rejection('package-attempt-invalid'));
    assert.throws(() => parseLedger(Buffer.from(text)), rejection('package-ledger-invalid'));
  }
  for (const change of [
    { phase: 'spawned' }, { child: { pid: 3, pgid: 4 } }, { run: 32 }, { seq: 1024 },
    { index: 4096 }, { source: 'npm:fixture@1' }, { extra: 'private-sentinel' },
    { work: { name: '../private-sentinel', id } }, { owner: { ...owner, bootId: null } },
  ]) {
    assert.throws(() => parseAttempt(Buffer.from(JSON.stringify({ ...attempt(), ...change }))), rejection('package-attempt-invalid'));
  }
  assert.throws(() => parseAttempt(Buffer.alloc(ATTEMPT_LIMIT + 1, 32)), rejection('package-attempt-invalid'));
  assert.throws(() => parseLedger(Buffer.alloc(LEDGER_LIMIT + 1, 32)), rejection('package-ledger-invalid'));
});

test('diagnostic labels do not turn unresolved exit facts into stop proof', () => {
  assert.equal(outcomeForExit(exit).code, 'installed');
  assert.equal(outcomeForExit({ ...exit, code: 1 }).code, 'exit-nonzero');
  assert.equal(outcomeForExit({ ...exit, code: null, signal: 'SIGTERM' }).code, 'signal');
  assert.equal(outcomeForExit({ ...exit, timedOut: true }).code, 'timeout');
  assert.equal(outcomeForExit({ ...exit, timedOut: true, overflow: true }).code, 'output-limit');
  for (const e of [
    { ...exit, code: null }, { ...exit, signal: 'SIGTERM' as const },
    { ...exit, stdoutBytes: -1 }, { ...exit, stdoutBytes: MIB + 2, overflow: true },
  ]) assert.throws(() => outcomeForExit(e), rejection('package-attempt-invalid'));
});

test('ledger sequence and run invariants reject false completion', () => {
  const l = ledger();
  const initial = ledgerBytes(l);
  assert.equal(Object.getPrototypeOf(parseLedger(initial)), null);
  l.runs.push({ run: 0, state: 'open', packageToken: token, lock: { ...lock }, owner: { ...owner } });
  l.attempts.push({ seq: 0, run: 0, index: 0, source: 'npm:fixture', work: { name: `w0-${'a'.repeat(16)}`, id: null }, outcome: null });
  l.nextSeq = 1;
  assert.equal(parseLedger(ledgerBytes(l)).nextSeq, 1);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
  for (const v of [
    { ...l, nextSeq: 2 }, { ...l, attempts: [{ ...l.attempts[0], seq: 1 }] },
    { ...l, attempts: [{ ...l.attempts[0], run: 1 }] },
    { ...l, runs: [{ ...l.runs[0], state: 'closed' }] },
    { ...l, attempts: [{ ...l.attempts[0], outcome: outcomeForExit(exit) }] },
    { ...l, runs: [{ ...l.runs[0], run: 1 }] },
    { ...l, runs: new Array(1), attempts: [], nextSeq: 0 },
    { ...l, attempts: new Array(1) },
  ]) assert.throws(() => parseLedger(encode(v)), rejection('package-ledger-invalid'));
  assert.throws(() => ledgerBytes({ ...l, runs: new Array(1), attempts: [], nextSeq: 0 }), rejection('package-ledger-invalid'));
  assert.throws(() => ledgerBytes({ ...l, attempts: new Array(1) }), rejection('package-ledger-invalid'));
  l.attempts[0].work.id = { ...id };
  l.attempts[0].outcome = outcomeForExit(exit);
  l.runs[0].state = 'closed';
  assert.deepEqual(ledgerBytes(parseLedger(ledgerBytes(l))), ledgerBytes(l));
});

test('maximum valid identities, escaped hosts and all terminal fields fit future-phase budgets', () => {
  const bigId = { dev: '9'.repeat(20), ino: '9'.repeat(20), birthtimeNs: '9'.repeat(20) };
  const bigOwner: PackageOwner = { ...owner, pid: Number.MAX_SAFE_INTEGER, uid: Number.MAX_SAFE_INTEGER, hostname: '"'.repeat(255), platform: 'darwin' };
  const bigExit: PackageExit = { code: null, signal: 'SIGKILL', stdoutBytes: MIB, stderrBytes: MIB, timedOut: false, overflow: false };
  const a: AttemptRecord = { ...attempt(), seq: MAX_ATTEMPTS - 1, run: MAX_RUNS - 1,
    index: 4095, source: `npm:${'z'.repeat(214)}`, owner: bigOwner,
    work: { name: `w1023-${'f'.repeat(16)}`, id: bigId },
    phase: 'config-verified', child: { pid: Number.MAX_SAFE_INTEGER, pgid: Number.MAX_SAFE_INTEGER }, exit: bigExit };
  const aBytes = attemptBytes(a);
  assert.ok(aBytes.length <= ATTEMPT_LIMIT);
  const l: PackageLedger = { ...ledger(), workParent: bigId, nextSeq: MAX_ATTEMPTS,
    runs: Array.from({ length: MAX_RUNS }, (_, run) => ({ run, state: 'closed', packageToken: token,
      lock: { ...bigId, ctimeNs: '9'.repeat(20) }, owner: bigOwner })),
    attempts: Array.from({ length: MAX_ATTEMPTS }, (_, seq) => ({ seq, run: MAX_RUNS - 1,
      index: 4096 - MAX_ATTEMPTS + seq, source: `npm:${'z'.repeat(210)}${seq.toString().padStart(4, '0')}`,
      work: { name: `w${seq}-${'f'.repeat(16)}`, id: bigId },
      outcome: { code: 'output-limit', exit: { code: null, signal: 'SIGKILL', stdoutBytes: MIB + 1, stderrBytes: MIB + 1 } } })),
  };
  const bytes = ledgerBytes(l);
  assert.ok(bytes.length <= LEDGER_LIMIT);
  assert.equal(parseLedger(bytes).attempts.length, 1024);
  assert.equal(parseLedger(bytes).runs.length, 32);
  assert.throws(() => ledgerBytes({ ...l, nextSeq: 1025, attempts: [...l.attempts, l.attempts[0]] }), rejection('package-ledger-invalid'));
  assert.throws(() => ledgerBytes({ ...l, runs: [...l.runs, l.runs[0]] }), rejection('package-ledger-invalid'));
});
