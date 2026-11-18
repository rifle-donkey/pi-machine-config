/**
 * Independent acceptance tests for the accepted revision-2 pure schema slice.
 * Integration destination: tests/package-attempt-state-acceptance.test.ts.
 * These tests do not access files, probe owners, spawn, import resources, or
 * treat serialized diagnostics as proof that a process group has stopped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_ID } from '../src/schema.ts';
import { ToolError } from '../src/errors.ts';
import {
  ATTEMPT_LIMIT, LEDGER_LIMIT, MAX_ATTEMPTS, MAX_RUNS,
  attemptBytes, parseAttempt, ledgerBytes, parseLedger, checkAdvance, outcomeForExit,
  type AttemptRecord, type PackageLedger, type PackageExit, type AttemptOutcome,
} from '../src/package-attempt.ts';

const MIB = 1024 * 1024;
const TX = '0123456789abcdef0123456789abcdef';
const PLAN = `sha256:${'a'.repeat(64)}`;
const PACKAGE = `sha256:${'b'.repeat(64)}`;
const BOOT = '01234567-89ab-cdef-0123-456789abcdef';
const D = { dev: '0', ino: '23', birthtimeNs: '45' };
const F = { ...D, ctimeNs: '67' };
const OWNER = { pid: 42, uid: 0, hostname: 'fixture-host', bootId: BOOT, platform: 'darwin' as const };
const CHILD = { pid: 84, pgid: 84 };
const PHASES = ['intent', 'spawned', 'stopped-proven', 'config-verified'] as const;
const OUTCOMES = ['installed', 'exit-nonzero', 'signal', 'timeout', 'output-limit'] as const;

function copy<T>(value: T): T { return structuredClone(value); }
function raw(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), 'utf8'); }
function exit(over: Partial<PackageExit> = {}): PackageExit {
  return { code: 0, signal: null, timedOut: false, overflow: false, stdoutBytes: 0, stderrBytes: 0, ...over };
}
function attempt(phase: AttemptRecord['phase'] = 'intent'): AttemptRecord {
  return {
    schemaVersion: 1, kind: 'pi-machine-config/package-attempt', tool: TOOL_ID,
    tx: TX, planToken: PLAN, packageToken: PACKAGE, seq: 0, run: 0, index: 0,
    source: 'npm:@fixture/package', owner: copy(OWNER),
    work: { name: 'w0-0123456789abcdef', id: copy(D) }, phase,
    child: phase === 'intent' ? null : copy(CHILD),
    exit: phase === 'stopped-proven' || phase === 'config-verified' ? exit() : null,
  };
}
function outcome(code: AttemptOutcome['code'] = 'installed'): AttemptOutcome {
  return {
    code,
    exit: { code: code === 'exit-nonzero' ? 7 : code === 'signal' ? null : 0,
      signal: code === 'signal' ? 'SIGTERM' : null, stdoutBytes: 0, stderrBytes: 0 },
  };
}
function run(n = 0, state: 'open' | 'closed' = 'open') {
  return { run: n, state, packageToken: PACKAGE, lock: copy(F), owner: copy(OWNER) };
}
function entry(seq = 0, runNumber = 0, index = seq, source = `npm:fixture-${index}`) {
  return { seq, run: runNumber, index, source,
    work: { name: `w${seq}-0123456789abcdef`, id: copy(D) as typeof D | null },
    outcome: outcome() as AttemptOutcome | null };
}
function ledger(): PackageLedger {
  return {
    schemaVersion: 1, kind: 'pi-machine-config/package-ledger', tool: TOOL_ID,
    tx: TX, planToken: PLAN, workParent: copy(D), nextSeq: 1,
    runs: [run()], attempts: [entry()],
  };
}

type Path = readonly (string | number)[];
function at(value: unknown, path: Path): any {
  let cursor: any = value;
  for (const key of path) cursor = cursor[key];
  return cursor;
}
function set(value: unknown, path: Path, replacement: unknown): void {
  at(value, path.slice(0, -1))[path[path.length - 1]] = replacement;
}
function removed(value: unknown, path: Path): void {
  delete at(value, path.slice(0, -1))[path[path.length - 1]];
}
function fixedError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ToolError, 'Use the project fixed-code error type');
    assert.equal(error.code, code);
    assert.equal(error.message, code, 'Error messages must not include rejected input');
    return true;
  });
}
function rejectsAttempt(value: unknown): void {
  fixedError(() => parseAttempt(raw(value)), 'package-attempt-invalid');
  fixedError(() => attemptBytes(value as AttemptRecord), 'package-attempt-invalid');
}
function rejectsLedger(value: unknown): void {
  fixedError(() => parseLedger(raw(value)), 'package-ledger-invalid');
  fixedError(() => ledgerBytes(value as PackageLedger), 'package-ledger-invalid');
}
function acceptsAttempt(value: AttemptRecord): void {
  const bytes = attemptBytes(value);
  assert.ok(bytes.length <= ATTEMPT_LIMIT);
  assert.deepEqual(plain(parseAttempt(bytes)), plain(value));
}
function acceptsLedger(value: PackageLedger): void {
  const bytes = ledgerBytes(value);
  assert.ok(bytes.length <= LEDGER_LIMIT);
  assert.deepEqual(plain(parseLedger(bytes)), plain(value));
}
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  }
  return value;
}
function maps(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(maps); return; }
  if (value !== null && typeof value === 'object') {
    assert.equal(Object.getPrototypeOf(value), null, 'Every parsed map has a null prototype');
    Object.values(value).forEach(maps);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function reverseMaps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseMaps);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseMaps(child)]));
  }
  return value;
}
// This literal is an independent wire-format oracle, not the production encoder.
const INTENT_WIRE = '{"child":null,"exit":null,"index":0,"kind":"pi-machine-config/package-attempt",'
  + '"owner":{"bootId":"01234567-89ab-cdef-0123-456789abcdef","hostname":"fixture-host","pid":42,"platform":"darwin","uid":0},'
  + `"packageToken":"${PACKAGE}","phase":"intent","planToken":"${PLAN}","run":0,"schemaVersion":1,"seq":0,`
  + `"source":"npm:@fixture/package","tool":${JSON.stringify(TOOL_ID)},"tx":"${TX}",`
  + '"work":{"id":{"birthtimeNs":"45","dev":"0","ino":"23"},"name":"w0-0123456789abcdef"}}\n';

test('contract constants retain declaration, history, and byte-budget distinctions', () => {
  assert.equal(ATTEMPT_LIMIT, 4096);
  assert.equal(LEDGER_LIMIT, 1048576);
  assert.equal(MAX_ATTEMPTS, 1024);
  assert.equal(MAX_RUNS, 32);
  const a = attempt(); a.index = 4095; acceptsAttempt(a);
  const l = ledger(); l.attempts[0].index = 4095; acceptsLedger(l);
});

for (const phase of PHASES) test(`attempt accepts phase ${phase} with its exact facts`, () => acceptsAttempt(attempt(phase)));

test('canonical bytes have sorted maps, one trailing newline, and stable array order', () => {
  assert.equal(Buffer.from(attemptBytes(attempt())).toString('utf8'), INTENT_WIRE);
  for (const [value, encode] of [[attempt('config-verified'), attemptBytes], [ledger(), ledgerBytes]] as const) {
    const bytes = (encode as (v: any) => Uint8Array)(value);
    assert.deepEqual(bytes, (encode as (v: any) => Uint8Array)(reverseMaps(value)));
    const text = Buffer.from(bytes).toString('utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.endsWith('\n\n'));
    assert.ok(!text.slice(0, -1).includes('\n'), 'Compact canonical JSON, not pretty JSON');
  }
  const l = ledger(); l.attempts.push(entry(1, 0, 100)); l.nextSeq = 2;
  assert.deepEqual(parseLedger(ledgerBytes(l)).attempts.map(a => a.index), [0, 100]);
});

test('parsers return fresh null-prototype maps; encoders and transition checks do not mutate inputs', () => {
  const a = freeze(attempt('config-verified'));
  const l = freeze(ledger());
  const beforeA = raw(a); const beforeL = raw(l);
  const ab = attemptBytes(a); const lb = ledgerBytes(l);
  const a1 = parseAttempt(ab); const a2 = parseAttempt(ab);
  const l1 = parseLedger(lb); const l2 = parseLedger(lb);
  maps(a1); maps(l1);
  a1.owner.hostname = 'changed'; a1.work.id.ino = '999';
  l1.runs[0].owner.hostname = 'changed'; l1.attempts[0].work.id!.ino = '999';
  assert.deepEqual(raw(a2), raw(parseAttempt(ab)));
  assert.deepEqual(raw(l2), raw(parseLedger(lb)));
  assert.deepEqual(raw(a), beforeA); assert.deepEqual(raw(l), beforeL);
  const prev = freeze(attempt('stopped-proven')); const next = freeze(attempt('config-verified'));
  assert.doesNotThrow(() => checkAdvance(prev, next));
  assert.deepEqual(raw(prev), raw(attempt('stopped-proven')));
  assert.deepEqual(raw(next), raw(attempt('config-verified')));
});

const ownerBad: [string, unknown[]][] = [
  ['pid', [null, 0, 1, -2, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]],
  ['uid', [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]],
  ['hostname', [null, '', 'a'.repeat(256), 'with space', '\u0000', '\n', '\t', '\u007f', 'höst', '\ud800']],
  ['bootId', [null, '', BOOT.toUpperCase(), `${BOOT}\n`, '0123456789abcdef0123456789abcdef']],
  ['platform', [null, '', 'win32', 'Darwin', 'linux\n']],
];
for (const [key, values] of ownerBad) for (const bad of values) {
  test(`owner ${key} rejects ${JSON.stringify(bad)}`, () => {
    const a = attempt(); set(a, ['owner', key], bad); rejectsAttempt(a);
    const l = ledger(); set(l, ['runs', 0, 'owner', key], bad); rejectsLedger(l);
  });
}
test('owner numeric and hostname endpoints are valid on both supported platforms', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const a = attempt();
    a.owner = { ...a.owner, pid: Number.MAX_SAFE_INTEGER, uid: Number.MAX_SAFE_INTEGER,
      hostname: '!'.repeat(254) + '~', platform };
    acceptsAttempt(a);
    const l = ledger(); l.runs[0].owner = copy(a.owner); acceptsLedger(l);
  }
  const a = attempt(); a.owner.pid = 2; a.owner.hostname = '!'; acceptsAttempt(a);
});

const commonBad: [string, unknown[]][] = [
  ['schemaVersion', [null, '1', 0, 2]],
  ['tool', [null, '', 'pi-machine-config@0.0.0', `${TOOL_ID}\n`]],
  ['tx', [null, '', TX.toUpperCase(), 'a'.repeat(31), 'a'.repeat(33), `${TX}\n`]],
  ['planToken', [null, '', 'a'.repeat(64), `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `${PLAN}\n`]],
];
for (const [key, values] of commonBad) for (const bad of values) test(`common ${key} rejects ${JSON.stringify(bad)}`, () => {
  const a = attempt(); set(a, [key], bad); rejectsAttempt(a);
  const l = ledger(); set(l, [key], bad); rejectsLedger(l);
});
for (const key of ['packageToken'] as const) for (const bad of commonBad.find(([k]) => k === 'planToken')![1]) {
  test(`package token rejects ${JSON.stringify(bad)}`, () => {
    const a = attempt(); set(a, [key], bad); rejectsAttempt(a);
    const l = ledger(); set(l, ['runs', 0, key], bad); rejectsLedger(l);
  });
}
test('record kinds cannot be confused or decorated', () => {
  const a = attempt(); a.kind = 'pi-machine-config/package-ledger' as any; rejectsAttempt(a);
  const l = ledger(); l.kind = 'pi-machine-config/package-attempt' as any; rejectsLedger(l);
  for (const kind of ['', 'package-attempt', 'pi-machine-config/package-attempt\n']) {
    rejectsAttempt({ ...attempt(), kind }); rejectsLedger({ ...ledger(), kind });
  }
});

for (const [key, max] of [['seq', 1023], ['run', 31], ['index', 4095]] as const) {
  for (const bad of [null, -1, 0.5, `${max}`, max + 1, Number.MAX_SAFE_INTEGER + 1]) {
    test(`attempt ${key} rejects ${JSON.stringify(bad)}`, () => {
      const a = attempt(); set(a, [key], bad); rejectsAttempt(a);
    });
  }
}
test('attempt maximum sequence and run are representable independently of a ledger', () => {
  const a = attempt(); a.seq = 1023; a.run = 31; a.index = 4095;
  a.work.name = 'w1023-ffffffffffffffff'; acceptsAttempt(a);
});

const BAD_SOURCES = [null, '', 'fixture', 'npm:Package', 'npm:pkg@1', 'npm:pkg@latest',
  'npm:@scope/pkg@1.0.0', 'npm:@scope', 'npm:@scope/', 'npm:/pkg', 'npm:../pkg',
  'npm:.pkg', 'npm:_pkg', 'npm:pkg/child', 'file:pkg', 'git:https://example.invalid/pkg',
  'npm:pkg\n', 'npm:pkg\u0000', `npm:${'p'.repeat(215)}`];
for (const source of BAD_SOURCES) test(`source rejects ${JSON.stringify(source)}`, () => {
  const a = attempt(); set(a, ['source'], source); rejectsAttempt(a);
  const l = ledger(); set(l, ['attempts', 0, 'source'], source); rejectsLedger(l);
});
for (const source of ['npm:a', 'npm:a.b_c-d', 'npm:@scope/pkg', `npm:${'p'.repeat(214)}`, `npm:@${'s'.repeat(105)}/${'p'.repeat(107)}`]) {
  test(`unversioned npm identity accepts ${source.length}-character source`, () => {
    const a = attempt(); a.source = source; acceptsAttempt(a);
    const l = ledger(); l.attempts[0].source = source; acceptsLedger(l);
  });
}

const BAD_NAMES = ['', 'w00-0123456789abcdef', 'w1-0123456789abcdef', 'w0-0123456789abcde',
  'w0-0123456789abcdef0', 'w0-ABCDEF0123456789', '../w0-0123456789abcdef',
  '/w0-0123456789abcdef', 'w0-0123456789abcdef/child', 'w0-0123456789abcdef\n'];
for (const name of BAD_NAMES) test(`work name rejects ${JSON.stringify(name)}`, () => {
  const a = attempt(); a.work.name = name; rejectsAttempt(a);
  const l = ledger(); l.attempts[0].work.name = name; rejectsLedger(l);
});
const ID_PATHS_A: Path[] = [['work', 'id']];
const ID_PATHS_L: Path[] = [['workParent'], ['runs', 0, 'lock'], ['attempts', 0, 'work', 'id']];
for (const path of [...ID_PATHS_A.map(path => ({ kind: 'attempt', path })), ...ID_PATHS_L.map(path => ({ kind: 'ledger', path }))]) {
  const keys = path.path.includes('lock') ? ['dev', 'ino', 'birthtimeNs', 'ctimeNs'] : ['dev', 'ino', 'birthtimeNs'];
  for (const key of keys) for (const bad of [null, 1, '', '-1', '+1', '01', '1.0', '1e2', '1\n', '1'.repeat(21), ...(key === 'birthtimeNs' ? ['0'] : [])]) {
    test(`${path.kind} ${path.path.join('.')}.${key} rejects ${JSON.stringify(bad)}`, () => {
      const v = path.kind === 'attempt' ? attempt() : ledger(); set(v, [...path.path, key], bad);
      if (path.kind === 'attempt') rejectsAttempt(v); else rejectsLedger(v);
    });
  }
}
test('identity endpoints are decimal strings, not JS numeric magnitudes', () => {
  const id = { dev: '0', ino: '99999999999999999999', birthtimeNs: '1' };
  const a = attempt(); a.work.id = copy(id); acceptsAttempt(a);
  const l = ledger(); l.workParent = copy(id); l.attempts[0].work.id = copy(id);
  l.runs[0].lock = { ...id, ctimeNs: '0' }; acceptsLedger(l);
});

const BAD_EXITS: [string, unknown[]][] = [
  ['code', [-1, 256, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]],
  ['signal', ['', 'SIGINT', 'sigterm', 'SIGTERM\n', 1]],
  ['timedOut', [null, 0, 1, 'false']], ['overflow', [null, 0, 1, 'false']],
  ['stdoutBytes', [null, -1, 0.5, `${MIB}`, MIB + 2]],
  ['stderrBytes', [null, -1, 0.5, `${MIB}`, MIB + 2]],
];
for (const [key, values] of BAD_EXITS) for (const bad of values) test(`exit ${key} rejects ${JSON.stringify(bad)}`, () => {
  const a = attempt('stopped-proven'); set(a, ['exit', key], bad); rejectsAttempt(a);
  if (key !== 'timedOut' && key !== 'overflow') {
    const l = ledger(); set(l, ['attempts', 0, 'outcome', 'exit', key], bad); rejectsLedger(l);
  }
});
test('exit requires exactly one of code or signal', () => {
  for (const facts of [{ code: null, signal: null }, { code: 0, signal: 'SIGTERM' }]) {
    const a = attempt('stopped-proven'); Object.assign(a.exit!, facts); rejectsAttempt(a);
    const l = ledger(); Object.assign(l.attempts[0].outcome!.exit, facts); rejectsLedger(l);
  }
});
for (const facts of [
  exit({ code: 255, stdoutBytes: MIB + 1, stderrBytes: MIB + 1 }),
  exit({ code: null, signal: 'SIGTERM' }), exit({ code: null, signal: 'SIGKILL' }),
  exit({ code: null, signal: 'other' }), exit({ timedOut: true, overflow: true }),
]) test(`bounded exit facts accept ${JSON.stringify(facts)}`, () => {
  const a = attempt('stopped-proven'); a.exit = facts; acceptsAttempt(a);
});

for (const phase of [null, '', 'Intent', 'stopped', 'intent\n', 'config-verified\u0000']) {
  test(`attempt rejects unknown/control phase ${JSON.stringify(phase)}`, () => {
    const a = attempt(); set(a, ['phase'], phase); rejectsAttempt(a);
  });
}
for (const state of [null, '', 'OPEN', 'closed\n']) test(`ledger rejects run state ${JSON.stringify(state)}`, () => {
  const l = ledger(); set(l, ['runs', 0, 'state'], state); rejectsLedger(l);
});
for (const code of [null, '', 'success', 'installed\n', 'timeout\u0000']) test(`ledger rejects outcome ${JSON.stringify(code)}`, () => {
  const l = ledger(); set(l, ['attempts', 0, 'outcome', 'code'], code); rejectsLedger(l);
});
for (const path of [['runs', 0, 'run'], ['attempts', 0, 'seq'], ['attempts', 0, 'run'], ['nextSeq']] as const) {
  for (const bad of [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    test(`ledger ${path.join('.')} rejects ${JSON.stringify(bad)}`, () => {
      const l = ledger(); set(l, path, bad); rejectsLedger(l);
    });
  }
}
test('ledger exit summary excludes timeout/overflow diagnostics and raw subprocess output', () => {
  for (const key of ['timedOut', 'overflow', 'stdout', 'stderr']) {
    const l = ledger(); set(l, ['attempts', 0, 'outcome', 'exit', key], true); rejectsLedger(l);
  }
});

for (const phase of PHASES) {
  for (const childPresent of [false, true]) for (const exitPresent of [false, true]) {
    const valid = childPresent === (phase !== 'intent')
      && exitPresent === (phase === 'stopped-proven' || phase === 'config-verified');
    if (valid) continue;
    test(`${phase} refuses child=${childPresent}, exit=${exitPresent}`, () => {
      const a = attempt(phase); a.child = childPresent ? copy(CHILD) : null; a.exit = exitPresent ? exit() : null;
      rejectsAttempt(a);
    });
  }
}
for (const child of [{ pid: 1, pgid: 1 }, { pid: 0, pgid: 0 }, { pid: -2, pgid: -2 },
  { pid: 2.5, pgid: 2.5 }, { pid: '84', pgid: '84' }, { pid: 84, pgid: 85 },
  { pid: Number.MAX_SAFE_INTEGER + 1, pgid: Number.MAX_SAFE_INTEGER + 1 }]) {
  test(`child refuses ${JSON.stringify(child)}`, () => {
    const a = attempt('spawned'); set(a, ['child'], child); rejectsAttempt(a);
  });
}
test('child PID endpoints are safe and strictly greater than one', () => {
  for (const pid of [2, Number.MAX_SAFE_INTEGER]) {
    const a = attempt('spawned'); a.child = { pid, pgid: pid }; acceptsAttempt(a);
  }
});

// Complete-map checks are generated from independent valid fixtures at each
// phase. Every observed key is required and every map forbids extra keys.
function objectPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => objectPaths(v, [...path, i]));
  if (value !== null && typeof value === 'object') return [path, ...Object.entries(value).flatMap(([k, v]) => objectPaths(v, [...path, k]))];
  return [];
}
for (const [name, fixture, reject] of [
  ...PHASES.map(p => [`attempt ${p}`, attempt(p), rejectsAttempt] as const),
  ['ledger', ledger(), rejectsLedger] as const,
]) {
  for (const path of objectPaths(fixture)) {
    test(`${name} rejects extra field at ${path.join('.') || 'root'}`, () => {
      const v = copy(fixture); at(v, path).rawOutput = 'SENSITIVE_FIXTURE_MARKER'; reject(v);
    });
    for (const key of Object.keys(at(fixture, path))) {
      test(`${name} requires ${[...path, key].join('.')}`, () => {
        const v = copy(fixture); removed(v, [...path, key]); reject(v);
      });
    }
    for (const replacement of [null, [], 'SENSITIVE_FIXTURE_MARKER', 7, false]) {
      // The final outcome is explicitly nullable while its run is open.
      // The dedicated unfinished-entry tests exercise that valid state.
      if (name === 'ledger' && path.join('.') === 'attempts.0.outcome' && replacement === null) continue;
      test(`${name} requires map at ${path.join('.') || 'root'} not ${JSON.stringify(replacement)}`, () => {
        const v = copy(fixture);
        if (path.length === 0) reject(replacement); else { set(v, path, replacement); reject(v); }
      });
    }
  }
}

for (const [name, fixture, parse, code] of [
  ['attempt', attempt('config-verified'), parseAttempt, 'package-attempt-invalid'],
  ['ledger', ledger(), parseLedger, 'package-ledger-invalid'],
] as const) {
  const text = JSON.stringify(fixture);
  const malformed = [
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw(fixture)])],
    ['bad UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])],
    ['duplicate root', Buffer.from(text.replace('{', '{"schemaVersion":1,'))],
    ['escaped duplicate', Buffer.from(text.replace('{', '{"schema\\u0056ersion":1,'))],
    ['duplicate nested', Buffer.from(text.replace('"dev":"0"', '"dev":"0","dev":"0"'))],
    ['unsafe number', Buffer.from(text.replace('"pid":42', '"pid":9007199254740993'))],
    ['nonfinite number', Buffer.from(text.replace('"pid":42', '"pid":1e999'))],
    ['trailing comma', Buffer.from(text.slice(0, -1) + ',}')],
    ['trailing value', Buffer.from(text + '{}')],
    ['empty', Buffer.alloc(0)], ['null', Buffer.from('null')],
    ['unpaired surrogate', Buffer.from(text.replace('fixture-host', '\\ud800'))],
    ['literal newline in string', Buffer.from(text.replace('fixture-host', 'fixture\nhost'))],
  ] as const;
  for (const [why, bytes] of malformed) test(`${name} strict JSON rejects ${why} with fixed code`, () => fixedError(() => parse(bytes), code));
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    for (const nested of [false, true]) test(`${name} rejects ${key} ${nested ? 'nested' : 'root'}`, () => {
      const payload = nested ? text.replace('"dev":"0"', `"dev":"0",${JSON.stringify(key)}:{"SENSITIVE_FIXTURE_MARKER":1}`)
        : text.replace('{', `{${JSON.stringify(key)}:{"SENSITIVE_FIXTURE_MARKER":1},`);
      fixedError(() => parse(Buffer.from(payload)), code);
    });
  }
  test(`${name} accepts legal surrounding JSON whitespace but emits canonical bytes`, () => {
    const parsed = parse(Buffer.from(` \t\r\n${text}\n `));
    assert.deepEqual(plain(parsed), plain(fixture));
  });
}

for (let from = 0; from < PHASES.length; from++) for (let to = 0; to < PHASES.length; to++) {
  test(`transition ${PHASES[from]} -> ${PHASES[to]} ${to === from + 1 ? 'accepts' : 'refuses'}`, () => {
    const prev = attempt(PHASES[from]); const next = attempt(PHASES[to]);
    if (to === from + 1) assert.doesNotThrow(() => checkAdvance(prev, next));
    else fixedError(() => checkAdvance(prev, next), 'package-attempt-transition');
  });
}
const IMMUTABLE_CHANGES: [Path, unknown][] = [
  [['tool'], 'pi-machine-config@0.0.0'], [['tx'], 'f'.repeat(32)],
  [['planToken'], `sha256:${'c'.repeat(64)}`], [['packageToken'], `sha256:${'d'.repeat(64)}`],
  [['seq'], 1], [['run'], 1], [['index'], 1], [['source'], 'npm:other'],
  [['owner', 'pid'], 43], [['owner', 'uid'], 1], [['owner', 'hostname'], 'other-host'],
  [['owner', 'bootId'], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], [['owner', 'platform'], 'linux'],
  [['work', 'name'], 'w0-fedcba9876543210'], [['work', 'id', 'dev'], '1'],
  [['work', 'id', 'ino'], '24'], [['work', 'id', 'birthtimeNs'], '46'],
];
for (let n = 0; n < 3; n++) for (const [path, replacement] of IMMUTABLE_CHANGES) {
  test(`transition ${PHASES[n]} freezes ${path.join('.')}`, () => {
    const prev = attempt(PHASES[n]); const next = attempt(PHASES[n + 1]); set(next, path, replacement);
    // Keep the modified record structurally valid so immutability, not shape,
    // is the reason for rejection.
    if (path.length === 1 && path[0] === 'seq') next.work.name = 'w1-0123456789abcdef';
    if (path.length === 1 && path[0] === 'tool') {
      // Tool identity changes are invalid structurally as well as immutable.
    } else acceptsAttempt(next);
    fixedError(() => checkAdvance(prev, next), 'package-attempt-transition');
  });
}
for (const from of ['spawned', 'stopped-proven'] as const) test(`${from} freezes introduced child identity`, () => {
  const prev = attempt(from); const next = attempt(from === 'spawned' ? 'stopped-proven' : 'config-verified');
  next.child = { pid: 86, pgid: 86 }; acceptsAttempt(next);
  fixedError(() => checkAdvance(prev, next), 'package-attempt-transition');
});
for (const [key, replacement] of [['code', 1], ['timedOut', true], ['overflow', true], ['stdoutBytes', 1], ['stderrBytes', 1]] as const) {
  test(`stopped-proven freezes introduced exit ${key}`, () => {
    const prev = attempt('stopped-proven'); const next = attempt('config-verified'); set(next, ['exit', key], replacement);
    acceptsAttempt(next); fixedError(() => checkAdvance(prev, next), 'package-attempt-transition');
  });
}
test('stopped-proven freezes introduced signal, even if the replacement is valid', () => {
  const prev = attempt('stopped-proven'); prev.exit = exit({ code: null, signal: 'SIGTERM' });
  const next = copy(prev); next.phase = 'config-verified'; next.exit!.signal = 'SIGKILL';
  acceptsAttempt(next); fixedError(() => checkAdvance(prev, next), 'package-attempt-transition');
});
test('diagnostic exit booleans cannot skip phases or introduce an exit before stopped-proven', () => {
  const prev = attempt('intent'); const next = attempt('config-verified');
  next.exit = exit({ timedOut: true, overflow: true });
  fixedError(() => checkAdvance(prev, next), 'package-attempt-transition');
  const spawned = attempt('spawned'); spawned.exit = exit({ timedOut: true, overflow: true });
  rejectsAttempt(spawned);
});

for (const overflow of [false, true]) for (const timedOut of [false, true]) {
  for (const terminal of [{ code: 0, signal: null }, { code: 1, signal: null },
    { code: 255, signal: null }, { code: null, signal: 'SIGTERM' },
    { code: null, signal: 'SIGKILL' }, { code: null, signal: 'other' }] as const) {
    test(`outcome precedence ${JSON.stringify({ overflow, timedOut, ...terminal })}`, () => {
      const facts = freeze(exit({ overflow, timedOut, ...terminal, stdoutBytes: MIB + 1, stderrBytes: 23 }));
      const expectedCode = overflow ? 'output-limit' : timedOut ? 'timeout' : terminal.signal !== null ? 'signal'
        : terminal.code === 0 ? 'installed' : 'exit-nonzero';
      const result = outcomeForExit(facts);
      assert.deepEqual(plain(result), { code: expectedCode,
        exit: { ...terminal, stdoutBytes: MIB + 1, stderrBytes: 23 } });
      assert.notEqual(result.exit, facts, 'The audit summary does not alias executor facts');
      assert.deepEqual(raw(facts), raw(exit({ overflow, timedOut, ...terminal, stdoutBytes: MIB + 1, stderrBytes: 23 })));
    });
  }
}

test('ledger accepts empty bootstrap, open empty run, and durable closed history', () => {
  const l = ledger(); l.runs = []; l.attempts = []; l.nextSeq = 0; acceptsLedger(l);
  l.runs = [run()]; acceptsLedger(l);
  l.runs[0].state = 'closed'; acceptsLedger(l);
  acceptsLedger({ ...ledger(), runs: [run(0, 'closed')] });
});
test('ledger preserves retries across runs, permits declaration gaps and resets only per-run indices', () => {
  const l = ledger(); l.runs = [run(0, 'closed'), run(1, 'open')];
  l.attempts = [entry(0, 0, 100, 'npm:retry'), entry(1, 0, 4095, 'npm:last'), entry(2, 1, 0, 'npm:retry')];
  l.nextSeq = 3; acceptsLedger(l);
  for (const code of OUTCOMES) { l.attempts[0].outcome = outcome(code); acceptsLedger(l); }
});
test('only final attempt in the open last run may be unfinished; work identity may be pending', () => {
  const l = ledger(); l.attempts[0].outcome = null;
  l.attempts[0].work.id = null; acceptsLedger(l);
  l.attempts[0].work.id = copy(D); acceptsLedger(l);
});
const BAD_LEDGERS: [string, (l: PackageLedger) => void][] = [
  ['no run for an attempt', l => { l.runs = []; }],
  ['run numbering gap', l => { l.runs[0].run = 1; }],
  ['repeated run number', l => { l.runs = [run(0, 'closed'), run(0)]; }],
  ['earlier run open', l => { l.runs = [run(), run(1)]; }],
  ['unrecognized run state', l => { l.runs[0].state = 'stopped' as any; }],
  ['sequence gap', l => { l.attempts[0].seq = 1; l.attempts[0].work.name = 'w1-0123456789abcdef'; }],
  ['sequence duplicate', l => { l.attempts.push(entry(0, 0, 1)); l.nextSeq = 2; }],
  ['nextSeq behind', l => { l.nextSeq = 0; }],
  ['nextSeq ahead', l => { l.nextSeq = 2; }],
  ['nextSeq fraction', l => { l.nextSeq = 1.5; }],
  ['nextSeq string', l => { l.nextSeq = '1' as any; }],
  ['missing run reference', l => { l.attempts[0].run = 1; }],
  ['negative run reference', l => { l.attempts[0].run = -1; }],
  ['fractional index', l => { l.attempts[0].index = 0.5; }],
  ['negative index', l => { l.attempts[0].index = -1; }],
  ['declaration index overflow', l => { l.attempts[0].index = 4096; }],
  ['repeated index', l => { l.attempts.push(entry(1, 0, 0, 'npm:distinct')); l.nextSeq = 2; }],
  ['descending index', l => { l.attempts[0].index = 2; l.attempts.push(entry(1, 0, 1)); l.nextSeq = 2; }],
  ['repeated source', l => { l.attempts.push(entry(1, 0, 1, l.attempts[0].source)); l.nextSeq = 2; }],
  ['run membership regresses', l => {
    l.runs = [run(0, 'closed'), run(1)];
    l.attempts = [entry(0, 1, 0), entry(1, 0, 1)]; l.nextSeq = 2;
  }],
  ['unfinished closed run', l => { l.runs[0].state = 'closed'; l.attempts[0].outcome = null; }],
  ['unfinished non-final attempt', l => { l.attempts[0].outcome = null; l.attempts.push(entry(1)); l.nextSeq = 2; }],
  ['unfinished earlier run', l => {
    l.attempts[0].outcome = null; l.runs = [run(0, 'closed'), run(1)];
  }],
  ['finished attempt without work identity', l => { l.attempts[0].work.id = null; }],
  ['unknown outcome', l => { l.attempts[0].outcome!.code = 'success' as any; }],
  ['run list not array', l => { l.runs = {} as any; }],
  ['attempt list not array', l => { l.attempts = {} as any; }],
  ['work parent absent', l => { l.workParent = null as any; }],
  ['lock identity absent', l => { l.runs[0].lock = null as any; }],
  ['too many runs', l => { l.runs = Array.from({ length: 33 }, (_, n) => run(n, 'closed')); }],
  ['too many total attempts', l => {
    l.attempts = Array.from({ length: 1025 }, (_, n) => entry(n)); l.nextSeq = 1025;
  }],
];
for (const [why, mutate] of BAD_LEDGERS) test(`ledger refuses ${why}`, () => {
  const l = ledger(); mutate(l); rejectsLedger(l);
});

for (const [name, make, parse, limit, code] of [
  ['attempt', attempt, parseAttempt, 4096, 'package-attempt-invalid'],
  ['ledger', ledger, parseLedger, 1048576, 'package-ledger-invalid'],
] as const) {
  test(`${name} input byte bound is inclusive and applies before whitespace removal`, () => {
    const bytes = raw(make());
    const atLimit = Buffer.concat([bytes, Buffer.alloc(limit - bytes.length, 0x20)]);
    assert.equal(atLimit.length, limit);
    assert.doesNotThrow(() => parse(atLimit));
    fixedError(() => parse(Buffer.concat([atLimit, Buffer.from(' ')])), code);
  });
}

test('all four attempt phases fit with escaped maximal hostname/source/identity/number fields', () => {
  const n = '99999999999999999999';
  for (const phase of PHASES) for (const hostname of ['"'.repeat(255), '\\'.repeat(255)]) {
    const a = attempt(phase); a.seq = 1023; a.run = 31; a.index = 4095;
    a.owner = { ...a.owner, pid: Number.MAX_SAFE_INTEGER, uid: Number.MAX_SAFE_INTEGER, hostname };
    a.source = `npm:${'p'.repeat(214)}`; assert.equal(a.source.length, 218);
    a.work = { name: 'w1023-ffffffffffffffff', id: { dev: n, ino: n, birthtimeNs: n } };
    if (a.child) a.child = { pid: Number.MAX_SAFE_INTEGER, pgid: Number.MAX_SAFE_INTEGER };
    if (a.exit) a.exit = exit({ code: 255, timedOut: true, overflow: true, stdoutBytes: MIB + 1, stderrBytes: MIB + 1 });
    acceptsAttempt(a);
  }
});

test('one-MiB ledger fits all 1024 total attempts and 32 runs with worst-length valid fields', () => {
  const n = '99999999999999999999';
  const did = { dev: n, ino: n, birthtimeNs: n };
  const l = ledger(); l.workParent = copy(did); l.nextSeq = 1024;
  l.runs = Array.from({ length: 32 }, (_, r) => ({ ...run(r, r === 31 ? 'open' : 'closed'),
    lock: { ...did, ctimeNs: n },
    owner: { ...copy(OWNER), pid: Number.MAX_SAFE_INTEGER, uid: Number.MAX_SAFE_INTEGER, hostname: '\\'.repeat(255) },
  }));
  l.attempts = Array.from({ length: 1024 }, (_, seq) => ({ ...entry(seq, Math.floor(seq / 32), 4064 + seq % 32,
    `npm:${'p'.repeat(210)}${String(seq % 32).padStart(4, '0')}`),
    work: { name: `w${seq}-ffffffffffffffff`, id: copy(did) },
    outcome: { code: 'output-limit' as const, exit: { code: null, signal: 'SIGTERM' as const,
      stdoutBytes: MIB + 1, stderrBytes: MIB + 1 } },
  }));
  assert.ok(l.attempts.every(a => a.source.length === 218));
  acceptsLedger(l);
  l.runs[31].state = 'closed'; acceptsLedger(l);
  assert.equal(parseLedger(ledgerBytes(l)).nextSeq, 1024, 'No history truncation to meet byte cap');
  assert.equal(parseLedger(ledgerBytes(l)).attempts.length, 1024);
  // Capacity is cross-run: another short entry is refused even with spare bytes.
  const extra = copy(l); extra.attempts.push(entry(1024, 31, 4095, 'npm:extra')); extra.nextSeq = 1025;
  rejectsLedger(extra);
});
