/**
 * Independent reservation-foundation acceptance tests.
 * All resources, gates, locks and targets belong to temporary fixtures.
 * No Pi startup, package execution or resource import occurs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, mock, test } from 'node:test';
import { ToolError } from '../src/errors.ts';
import type { Platform } from '../src/schema.ts';
import {
  applyRestore,
  inspectRestore,
  readAppliedRestore,
  resolveRestore,
  rollbackRestore,
  type RestorePacket,
  type TxOptions,
} from '../src/transaction.ts';
import {
  lockBytes,
  type TxDeps,
} from '../src/transaction-fs.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
});

const PLATFORM = process.platform as Platform;
const BOOT = '11111111-2222-4333-8444-555555555555';
const OTHER_BOOT = '99999999-2222-4333-8444-555555555555';
const UID = process.getuid?.() ?? 0;
const PID = 4_000_001;
const PRIVATE = 'QA_ATTEMPT_PRIVATE_927183';
const REASON = 'package-attempt-unresolved';
const TOKEN = `sha256:${'a'.repeat(64)}`;

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')),
  );
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);

  const calls = { boot: 0, host: 0, pid: 0, probe: 0 };
  const deps: TxDeps = {
    platform: PLATFORM,
    bootId: () => { calls.boot++; return BOOT; },
    hostname: () => { calls.host++; return 'qa-host'; },
    uid: () => UID,
    pid: () => { calls.pid++; return PID; },
    probePid: () => { calls.probe++; return 'esrch'; },
    randomHex: n => crypto.randomBytes(n).toString('hex'),
    fault: () => {},
  };
  const bytes = Buffer.from('# Fixture rules\nDo not execute resources.\n');
  const packet: RestorePacket = {
    planToken: TOKEN,
    platform: PLATFORM,
    state: path.join(root, 'state'),
    agentTarget: path.join(root, 'agent'),
    lensTarget: null,
    settings: {},
    packages: [],
    protectedRoots: [],
    files: [{
      root: 'agent',
      path: 'AGENTS.md',
      class: 'agent-context',
      bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  const opts: TxOptions = { env: {}, guard: { home }, deps };
  return {
    root, home, calls, deps, packet, opts,
    state: packet.state,
    agent: packet.agentTarget,
    target: path.join(packet.agentTarget, 'AGENTS.md'),
    gate: path.join(packet.state, 'package-attempt.json'),
    journal: path.join(packet.state, 'journal.json'),
    stateLock: path.join(packet.state, 'lock.json'),
    recoveryLock: path.join(packet.state, 'recovery-gate.json'),
  };
}
type Fixture = ReturnType<typeof fixture>;

function refusal(fn: () => unknown): ToolError {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error instanceof ToolError, 'expected operational refusal');
  assert.equal(error.exit, 1);
  assert.match(error.code, /^[a-z][a-z0-9-]{0,63}$/);
  assert.equal(error.message, error.code);
  assert.equal(error.layer, undefined);
  assert.equal(error.code.includes(PRIVATE), false);
  return error;
}

function resetCalls(f: Fixture): void {
  Object.assign(f.calls, { boot: 0, host: 0, pid: 0, probe: 0 });
}

/**
 * Regular files retain bytes and complete identity metadata.
 * Directory times and link counts are omitted only when testing injected
 * entry changes and acquisition/cleanup of newly owned locks. Some filesystems
 * change directory link counts for these permitted entry changes.
 * Never follows symlinks or reads FIFO bodies.
 */
function snapshot(root: string, directoryTimes = true): Map<string, string> {
  const result = new Map<string, string>();
  function visit(p: string): void {
    const s = fs.lstatSync(p, { bigint: true });
    const kind = s.isDirectory() ? 'dir' :
      s.isSymbolicLink() ? 'link' :
      s.isFile() ? 'file' :
      s.isFIFO() ? 'fifo' : 'other';
    const fields = [
      kind, s.dev, s.ino, s.birthtimeNs,
      s.mode, s.uid, s.gid,
    ];
    if (!s.isDirectory() || directoryTimes) {
      fields.push(s.nlink, s.size, s.mtimeNs, s.ctimeNs);
    }
    let payload = '';
    if (s.isSymbolicLink()) payload = fs.readlinkSync(p);
    else if (s.isFile() && (s.mode & 0o400n) !== 0n) {
      payload = crypto.createHash('sha256')
        .update(fs.readFileSync(p)).digest('hex');
    }
    result.set(path.relative(root, p) || '.', `${fields.join(':')}:${payload}`);
    if (s.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name));
    }
  }
  visit(root);
  return result;
}

function pathname(value: unknown): string | null {
  if (typeof value === 'string') return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return fileURLToPath(value);
  return null;
}

function watch() {
  const open = mock.method(fs, 'openSync');
  const read = mock.method(fs, 'readFileSync');
  const lst = mock.method(fs, 'lstatSync');
  const stat = mock.method(fs, 'statSync');
  const opendir = mock.method(fs, 'opendirSync');
  const readdir = mock.method(fs, 'readdirSync');
  // Prevent an implementation defect from reaching a real process.
  const kill = mock.method(process, 'kill', () => true);

  return {
    reset() {
      open.mock.resetCalls();
      read.mock.resetCalls();
      lst.mock.resetCalls();
      stat.mock.resetCalls();
      opendir.mock.resetCalls();
      readdir.mock.resetCalls();
      kill.mock.resetCalls();
    },
    stop() {
      const trace = {
        bodies: [
          ...open.mock.calls.map(c => pathname(c.arguments[0])),
          ...read.mock.calls.map(c => pathname(c.arguments[0])),
        ],
        metadata: [
          ...lst.mock.calls.map(c => pathname(c.arguments[0])),
          ...stat.mock.calls.map(c => pathname(c.arguments[0])),
        ],
        listings: [
          ...opendir.mock.calls.map(c => pathname(c.arguments[0])),
          ...readdir.mock.calls.map(c => pathname(c.arguments[0])),
        ],
        signals: kill.mock.calls.length,
      };
      open.mock.restore();
      read.mock.restore();
      lst.mock.restore();
      stat.mock.restore();
      opendir.mock.restore();
      readdir.mock.restore();
      kill.mock.restore();
      return trace;
    },
  };
}
type Trace = ReturnType<ReturnType<typeof watch>['stop']>;

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}${path.sep}`);
}

function quiet(
  f: Fixture,
  trace: Trace,
  ownedLockMetadata: string[] = [],
  suppliedTargetMetadata = false,
): void {
  // State/root directory opens for cleanup fsync are allowed.
  const permittedDirectory = (p: string) => p === f.root || p === f.state;
  assert.equal(trace.bodies.filter(p =>
    p !== null && under(p, f.root) && !permittedDirectory(p),
  ).length, 0, 'fixture file was opened after exclusion');

  const journalOrLock = [f.journal, f.stateLock, f.recoveryLock];
  assert.equal(trace.metadata.filter(p => p !== null &&
    !ownedLockMetadata.includes(p) &&
    (journalOrLock.includes(p) ||
      (!suppliedTargetMetadata && under(p, f.agent))),
  ).length, 0, 'journal, foreign lock or target metadata was accessed');

  assert.equal(trace.listings.filter(p =>
    p !== null && under(p, f.root) && !permittedDirectory(p),
  ).length, 0, 'excluded directory was traversed');
  assert.equal(trace.signals, 0);
}

function observedQuietly(
  f: Fixture,
  fn: () => void,
  suppliedTargetMetadata = false,
): void {
  const observer = watch();
  let trace: Trace;
  try { fn(); } finally { trace = observer.stop(); }
  quiet(f, trace!, [], suppliedTargetMetadata);
}

function blockedInspection(
  f: Fixture,
  opts: TxOptions = f.opts,
  state = f.state,
): void {
  assert.deepEqual(inspectRestore(state, opts), {
    tx: null,
    status: null,
    class: 'corrupt',
    actions: [],
    reason: REASON,
    locks: { state: 'absent', target: 'absent', gate: 'absent' },
    items: [],
    warnings: [],
  });
}

type Kind =
  | 'applied' | 'unfinished' | 'published-unfinished' | 'conflict'
  | 'rolled-back' | 'closed' | 'lock-stale' | 'gate-stale';

function seed(kind: Kind = 'applied') {
  const f = fixture();
  const failPoint = kind === 'unfinished' || kind === 'closed' ?
    'stage-create' :
    kind === 'published-unfinished' || kind === 'lock-stale' ?
      'unstage' : null;
  if (failPoint !== null) {
    let failed = false;
    refusal(() => applyRestore(f.packet, {
      ...f.opts,
      deps: {
        ...f.deps,
        fault(point) {
          if (failed && kind === 'lock-stale' &&
              /^(target-lock-release|lock-release)/.test(point)) {
            throw new Error('fixture interruption');
          }
          if (!failed && point === failPoint) {
            failed = true;
            throw new Error('fixture interruption');
          }
        },
      },
    }));
    assert.equal(failed, true);
  } else {
    assert.equal(applyRestore(f.packet, f.opts).outputs, 1);
  }

  let initial = inspectRestore(f.state, f.opts);
  assert.ok(initial.tx);
  const tx = initial.tx;
  if (kind === 'conflict') {
    fs.writeFileSync(f.target, '# Changed fixture\n');
  } else if (kind === 'rolled-back') {
    rollbackRestore(f.state, tx, f.opts);
  } else if (kind === 'closed') {
    resolveRestore(f.state, {
      tx, expect: 'unfinished', action: 'abandon',
    }, f.opts);
  } else if (kind === 'gate-stale') {
    fs.writeFileSync(f.recoveryLock, lockBytes({
      role: 'gate', tx, pid: PID + 1, uid: UID,
      hostname: 'qa-host', bootId: BOOT, platform: PLATFORM,
    }), { flag: 'wx', mode: 0o600 });
  }
  initial = inspectRestore(f.state, f.opts);
  assert.equal(initial.class, kind);
  return { ...f, tx, initial };
}

function regularGate(f: Fixture, body = PRIVATE): void {
  fs.writeFileSync(f.gate, body, { flag: 'wx', mode: 0o600 });
}

const gateKinds = [
  'empty', 'malformed', 'owner-looking', 'future', 'oversized',
  'mode-000', 'mode-0644', 'directory', 'file-symlink',
  'directory-symlink', 'dangling-symlink', 'hardlink', 'fifo',
] as const;

function installGate(
  f: Fixture,
  kind: typeof gateKinds[number],
  tx: string,
): void {
  const witness = path.join(f.root, 'witness');
  switch (kind) {
    case 'empty': regularGate(f, ''); break;
    case 'malformed': regularGate(f, `{${PRIVATE}`); break;
    case 'owner-looking':
      regularGate(f, JSON.stringify({
        schemaVersion: 1, tx, packageToken: TOKEN, attemptIndex: 0,
        phase: 'config-verified', pid: PID, coordinatorPid: PID,
        uid: UID, hostname: 'qa-host', bootId: BOOT,
        childPid: PID + 1, pgid: PID + 1, private: PRIVATE,
      }));
      break;
    case 'future':
      regularGate(f, JSON.stringify({ schemaVersion: 999, private: PRIVATE }));
      break;
    case 'oversized': regularGate(f, PRIVATE.repeat(70_000)); break;
    case 'mode-000':
      regularGate(f); fs.chmodSync(f.gate, 0o000); break;
    case 'mode-0644':
      regularGate(f); fs.chmodSync(f.gate, 0o644); break;
    case 'directory':
      fs.mkdirSync(f.gate);
      fs.writeFileSync(path.join(f.gate, 'private'), PRIVATE);
      break;
    case 'file-symlink':
      fs.writeFileSync(witness, PRIVATE);
      fs.symlinkSync(witness, f.gate);
      break;
    case 'directory-symlink':
      fs.mkdirSync(witness);
      fs.writeFileSync(path.join(witness, 'private'), PRIVATE);
      fs.symlinkSync(witness, f.gate);
      break;
    case 'dangling-symlink':
      fs.symlinkSync(witness, f.gate);
      break;
    case 'hardlink':
      fs.writeFileSync(witness, PRIVATE, { mode: 0o600 });
      fs.linkSync(witness, f.gate);
      break;
    case 'fifo':
      execFileSync('mkfifo', [f.gate], { env: {}, stdio: 'pipe' });
      assert.equal(fs.lstatSync(f.gate).isFIFO(), true);
      break;
  }
}

describe('package-attempt reservation', { concurrency: false }, () => {
  test('no-gate lifecycle and body-read watcher positive control', () => {
    const f = seed();
    const before = snapshot(f.root);
    const observer = watch();
    let trace: Trace;
    try {
      assert.equal(inspectRestore(f.state, f.opts).class, 'applied');
    } finally { trace = observer.stop(); }
    assert.ok(trace!.bodies.includes(f.journal));
    assert.ok(trace!.bodies.includes(f.target));
    assert.ok(trace!.metadata.includes(f.target));
    assert.equal(trace!.signals, 0);
    assert.deepEqual(snapshot(f.root), before);

    const proof = readAppliedRestore(f.state, f.tx, {
      ...f.opts,
      expectedTargets: { agent: f.agent, lens: null },
    });
    assert.equal(proof.tx, f.tx);
    assert.equal(proof.outputs.length, 1);
    assert.equal(rollbackRestore(f.state, f.tx, f.opts).removed, 1);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(rollbackRestore(f.state, f.tx, f.opts).removed, 0);
    assert.equal(inspectRestore(f.state, f.opts).class, 'rolled-back');
    assert.equal(fs.existsSync(f.gate), false);
  });

  for (const kind of gateKinds) {
    test(`${kind}: no interpretation, reads, signals or mutation`, () => {
      const f = seed();
      installGate(f, kind, f.tx);
      const before = snapshot(f.root);
      resetCalls(f);

      observedQuietly(f, () => {
        blockedInspection(f);
        refusal(() => rollbackRestore(f.state, f.tx, f.opts));
        for (const [expect, action] of [
          ['applied', 'rollback'],
          ['unfinished', 'abandon'],
          ['published-unfinished', 'finalize'],
          ['conflict', 'record-conflict'],
          ['lock-stale', 'release-lock'],
          ['gate-stale', 'release-gate'],
          ['corrupt', 'rollback'],
        ]) {
          refusal(() => resolveRestore(
            f.state, { tx: f.tx, expect, action }, f.opts,
          ));
        }
      });
      assert.deepEqual(f.calls, { boot: 0, host: 0, pid: 0, probe: 0 });
      assert.deepEqual(snapshot(f.root), before);

      // Explicit target binding may examine supplied path metadata.
      // It still must not open target, journal, lock or gate bodies.
      observedQuietly(f, () => {
        refusal(() => readAppliedRestore(f.state, f.tx, {
          ...f.opts,
          expectedTargets: { agent: f.agent, lens: null },
        }));
      }, true);
      assert.deepEqual(snapshot(f.root), before);
    });
  }

  const kinds: Kind[] = [
    'applied', 'unfinished', 'published-unfinished', 'conflict',
    'rolled-back', 'closed', 'lock-stale', 'gate-stale',
  ];
  for (const kind of kinds) {
    test(`${kind}: genuine recovery control, then exclusion precedence`, () => {
      const control = seed(kind);
      const action = control.initial.actions[0];
      if (action) {
        const result = resolveRestore(control.state, {
          tx: control.tx, expect: kind, action,
        }, control.opts);
        if (kind === 'lock-stale') assert.equal(result.removed, 2);
        if (kind === 'gate-stale') assert.equal(result.removed, 1);
      } else if (kind === 'rolled-back') {
        assert.equal(
          rollbackRestore(control.state, control.tx, control.opts).removed, 0,
        );
      }

      const f = seed(kind);
      regularGate(f);
      const before = snapshot(f.root);
      observedQuietly(f, () => {
        blockedInspection(f);
        refusal(() => rollbackRestore(f.state, f.tx, f.opts));
        if (f.initial.actions[0]) {
          refusal(() => resolveRestore(f.state, {
            tx: f.tx, expect: kind, action: f.initial.actions[0],
          }, f.opts));
        }
      });
      assert.deepEqual(snapshot(f.root), before);
    });
  }

  for (const damage of [
    'missing-journal', 'invalid-journal', 'unexpected-entry', 'unsafe-locks',
  ] as const) {
    test(`${damage}: marker wins before journal or lock reads`, () => {
      const f = seed();
      if (damage === 'missing-journal') fs.unlinkSync(f.journal);
      if (damage === 'invalid-journal') fs.writeFileSync(f.journal, PRIVATE);
      if (damage === 'unexpected-entry') {
        fs.writeFileSync(path.join(f.state, '000-unexpected'), PRIVATE);
      }
      if (damage === 'unsafe-locks') {
        fs.writeFileSync(f.stateLock, PRIVATE, { mode: 0o644 });
        fs.symlinkSync(path.join(f.root, 'missing'), f.recoveryLock);
      }
      regularGate(f);
      const before = snapshot(f.root);
      observedQuietly(f, () => blockedInspection(f));
      assert.deepEqual(snapshot(f.root), before);
    });
  }

  for (const scenario of [
    'same-boot-esrch', 'changed-boot', 'alive', 'eperm',
    'foreign-host', 'missing-boot',
  ] as const) {
    test(`${scenario}: stale-owner evidence cannot override the marker`, () => {
      const f = seed('lock-stale');
      regularGate(f);
      let probes = 0;
      const opts: TxOptions = {
        ...f.opts,
        deps: {
          ...f.deps,
          bootId: () => {
            probes++;
            return scenario === 'missing-boot' ? null :
              scenario === 'changed-boot' ? OTHER_BOOT : BOOT;
          },
          hostname: () => {
            probes++;
            return scenario === 'foreign-host' ? 'other-host' : 'qa-host';
          },
          probePid: () => {
            probes++;
            return scenario === 'alive' ? 'alive' :
              scenario === 'eperm' ? 'eperm' : 'esrch';
          },
        },
      };
      const before = snapshot(f.root);
      observedQuietly(f, () => {
        blockedInspection(f, opts);
        refusal(() => resolveRestore(f.state, {
          tx: f.tx, expect: 'lock-stale', action: 'release-lock',
        }, opts));
      });
      assert.equal(probes, 0);
      assert.deepEqual(snapshot(f.root), before);
    });
  }

  test('canonical state aliases cannot hide an exact reserved entry', () => {
    const f = seed();
    regularGate(f);
    const alias = path.join(f.root, 'parent-alias');
    fs.symlinkSync(f.root, alias);
    const before = snapshot(f.root);
    observedQuietly(f, () => {
      blockedInspection(f, f.opts, path.join(alias, 'state'));
    });
    assert.deepEqual(snapshot(f.root), before);
  });

  test('case-only names never authorize inspection or mutation', () => {
    const f = seed();
    fs.writeFileSync(path.join(f.state, 'PACKAGE-ATTEMPT.JSON'), PRIVATE);
    let resolvesExactName = false;
    try {
      fs.lstatSync(f.gate);
      resolvesExactName = true;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
    }
    const before = snapshot(f.root);
    observedQuietly(f, () => {
      const result = inspectRestore(f.state, f.opts);
      assert.equal(result.class, 'corrupt');
      assert.deepEqual(result.actions, []);
      assert.equal(result.reason, resolvesExactName ?
        REASON : 'state-unexpected-entry');
      assert.equal(result.tx, null);
      assert.deepEqual(result.items, []);
      refusal(() => rollbackRestore(f.state, f.tx, f.opts));
    });
    assert.deepEqual(snapshot(f.root), before);
  });

  for (const [kind, direct] of [
    ['applied', true],
    ['applied', false],
    ['unfinished', false],
    ['published-unfinished', false],
    ['conflict', false],
    ['lock-stale', false],
  ] as const) {
    test(`${kind}/${direct ? 'direct' : 'resolve'}: under-lock injection`, () => {
      const f = seed(kind);
      const before = snapshot(f.root, false);
      const expected = new Map(before);
      const point = kind === 'lock-stale' ? 'gate-dirsync' : 'lock-dirsync';
      const owned = kind === 'lock-stale' ? f.recoveryLock : f.stateLock;
      let injected = false;
      const observer = watch();
      let trace: Trace;
      const opts: TxOptions = {
        ...f.opts,
        deps: {
          ...f.deps,
          fault(p) {
            if (p !== point || injected) return;
            assert.equal(fs.existsSync(owned), true);
            regularGate(f);
            expected.set(
              path.relative(f.root, f.gate),
              snapshot(f.root, false).get(path.relative(f.root, f.gate))!,
            );
            injected = true;
            observer.reset();
          },
        },
      };
      try {
        refusal(() => direct ?
          rollbackRestore(f.state, f.tx, opts) :
          resolveRestore(f.state, {
            tx: f.tx, expect: kind, action: f.initial.actions[0],
          }, opts));
      } finally { trace = observer.stop(); }
      assert.equal(injected, true);
      quiet(f, trace!, [owned]);
      assert.deepEqual(snapshot(f.root, false), expected);
      observedQuietly(f, () => blockedInspection(f));
    });
  }

  for (const boundary of [
    'state-parent-sync', 'lock-dirsync', 'locked-verifier',
  ] as const) {
    test(`fresh apply/${boundary}: gate precedes first journal and target`, () => {
      const f = fixture();
      let injected = false;
      let expected: Map<string, string> | undefined;
      const observer = watch();
      let trace: Trace;

      function inject(): void {
        assert.equal(fs.existsSync(f.journal), false);
        assert.equal(fs.existsSync(f.agent), false);
        regularGate(f);
        expected = snapshot(f.root, false);
        expected.delete(path.relative(f.root, f.stateLock));
        injected = true;
        observer.reset();
      }

      const opts: TxOptions = {
        ...f.opts,
        deps: {
          ...f.deps,
          fault(point) {
            if (!injected && point === boundary) inject();
          },
        },
        verifyLockedIntent() {
          assert.equal(fs.existsSync(f.stateLock), true);
          if (boundary === 'locked-verifier') inject();
          return TOKEN;
        },
      };
      try {
        refusal(() => applyRestore(f.packet, opts));
      } finally { trace = observer.stop(); }
      assert.equal(injected, true);
      quiet(f, trace!, [f.stateLock]);
      assert.equal(fs.existsSync(f.journal), false);
      assert.equal(fs.existsSync(f.agent), false);
      assert.deepEqual(snapshot(f.root, false), expected);
      observedQuietly(f, () => blockedInspection(f));
    });
  }
});
