import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  applyRestore, inspectRestore, resolveRestore,
  type RestorePacket, type TxOptions,
} from '../src/transaction.ts';
import { lockBytes, type LockRole, type PidProbe } from '../src/transaction-fs.ts';
import { ToolError } from '../src/errors.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const boot = '11111111-2222-4333-8444-555555555555';
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const platform = process.platform as Platform;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-restore-qa-')));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const options: TxOptions = { env: {}, guard: { home }, deps: {
    platform, bootId: () => boot, hostname: () => 'qa-host', uid: () => uid,
    pid: () => 4000001, probePid: () => 'esrch',
  } };
  const packet: RestorePacket = {
    planToken: `sha256:${'a'.repeat(64)}`, platform,
    state: path.join(root, 'state'), agentTarget: path.join(root, 'agent'),
    lensTarget: null, settings: { defaultProvider: 'anthropic' },
    packages: [], protectedRoots: [], files: [],
  };
  return { root, packet, options, dest: path.join(packet.agentTarget, 'settings.json') };
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof ToolError && e.code === code);
}

for (const role of ['state', 'gate'] as const) {
  const name = role === 'state' ? 'lock.json' : 'recovery-gate.json';
  const staleClass = role === 'state' ? 'lock-stale' : 'gate-stale';
  const heldClass = role === 'state' ? 'lock-held' : 'gate-held';
  const action = role === 'state' ? 'release-lock' : 'release-gate';

  function seeded() {
    const f = fixture();
    const applied = applyRestore(f.packet, f.options);
    const file = path.join(f.packet.state, name);
    const bytes = lockBytes({
      role: role as LockRole, tx: applied.tx, pid: 4000002, uid,
      hostname: 'qa-host', bootId: boot, platform,
    });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { ...f, tx: applied.tx, file, bytes };
  }

  test(`${role}: proven stale lock has an explicit release control`, () => {
    const f = seeded();
    const before = fs.readFileSync(f.dest);
    const i = inspectRestore(f.packet.state, f.options);
    assert.equal(i.class, staleClass);
    assert.deepEqual(i.actions, [action]);
    const result = resolveRestore(f.packet.state, {
      tx: f.tx, expect: staleClass, action,
    }, f.options);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(inspectRestore(f.packet.state, f.options).class, 'applied');
    assert.deepEqual(fs.readFileSync(f.dest), before);
  });

  for (const scenario of ['alive', 'eperm', 'other-host', 'missing-boot'] as const) {
    test(`${role}: ${scenario} cannot establish stale ownership`, () => {
      const f = seeded();
      const probe: PidProbe = scenario === 'alive' ? 'alive' :
        scenario === 'eperm' ? 'eperm' : 'esrch';
      const options: TxOptions = { ...f.options, deps: {
        ...f.options.deps, probePid: () => probe,
        hostname: () => scenario === 'other-host' ? 'other-host' : 'qa-host',
        bootId: () => scenario === 'missing-boot' ? null : boot,
      } };
      const before = fs.readFileSync(f.dest);
      const i = inspectRestore(f.packet.state, options);
      assert.equal(i.class, heldClass);
      assert.deepEqual(i.actions, []);
      expectCode(() => resolveRestore(f.packet.state, {
        tx: f.tx, expect: staleClass, action,
      }, options), 'expect-mismatch');
      assert.deepEqual(fs.readFileSync(f.file), f.bytes);
      assert.deepEqual(fs.readFileSync(f.dest), before);
    });
  }

  test(`${role}: replacement between stale observation and unlink proof survives`, () => {
    const f = seeded();
    const replacement = path.join(f.root, 'replacement');
    fs.writeFileSync(replacement, f.bytes, { flag: 'wx', mode: 0o600 });
    const replacementInode = fs.statSync(replacement).ino;
    assert.notEqual(replacementInode, fs.statSync(f.file).ino);
    const before = fs.readFileSync(f.dest);
    assert.equal(inspectRestore(f.packet.state, f.options).class, staleClass);

    let probes = 0;
    let swapped = false;
    const options: TxOptions = { ...f.options, deps: {
      ...f.options.deps,
      probePid: (pid) => {
        assert.equal(pid, 4000002);
        probes++;
        if (probes === 2) {
          fs.renameSync(replacement, f.file);
          swapped = true;
        }
        return 'esrch';
      },
    } };
    expectCode(() => resolveRestore(f.packet.state, {
      tx: f.tx, expect: staleClass, action,
    }, options), 'lock-changed');
    assert.equal(probes, 2);
    assert.equal(swapped, true);
    assert.equal(fs.statSync(f.file).ino, replacementInode);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    assert.deepEqual(fs.readFileSync(f.dest), before);
  });
}

for (const replaceStage of [false, true]) {
  test(`abandon preserves foreign destination${replaceStage ? ' and replaced stage' : ''}`, () => {
    const f = fixture();
    let injected = false;
    let stage = '';
    let foreign = Buffer.alloc(0);
    const options: TxOptions = { ...f.options, deps: { ...f.options.deps,
      fault: (point) => {
        if (point !== 'link' || injected) return;
        injected = true;
        const names = fs.readdirSync(f.packet.agentTarget)
          .filter((n) => n.startsWith('.pi-machine-config-stage-'));
        assert.equal(names.length, 1);
        stage = path.join(f.packet.agentTarget, names[0]);
        foreign = fs.readFileSync(stage);
        fs.writeFileSync(f.dest, foreign, { flag: 'wx', mode: 0o600 });
      },
    } };
    expectCode(() => applyRestore(f.packet, options), 'target-conflict');
    assert.equal(injected, true);
    assert.ok(stage);
    assert.deepEqual(fs.readFileSync(f.dest), foreign);
    const foreignInode = fs.statSync(f.dest).ino;
    assert.notEqual(foreignInode, fs.statSync(stage).ino);
    const i = inspectRestore(f.packet.state, f.options);
    assert.equal(i.class, 'unfinished');
    assert.deepEqual(i.actions, ['abandon']);
    assert.equal(i.items.find((x) => x.kind === 'output')?.phase, 'not-created');
    assert.ok(i.tx);

    let replacementInode: number | undefined;
    if (replaceStage) {
      const replacement = path.join(f.root, 'replacement-stage');
      fs.writeFileSync(replacement, fs.readFileSync(stage), { flag: 'wx', mode: 0o600 });
      replacementInode = fs.statSync(replacement).ino;
      assert.notEqual(replacementInode, fs.statSync(stage).ino);
      fs.renameSync(replacement, stage);
    }
    const result = resolveRestore(f.packet.state, {
      tx: i.tx, expect: 'unfinished', action: 'abandon',
    }, f.options);
    assert.equal(result.removed, replaceStage ? 0 : 1);
    assert.equal(fs.statSync(f.dest).ino, foreignInode);
    assert.deepEqual(fs.readFileSync(f.dest), foreign);
    if (replaceStage) {
      assert.equal(fs.statSync(stage).ino, replacementInode);
      assert.deepEqual(fs.readFileSync(stage), foreign);
    } else {
      assert.equal(fs.existsSync(stage), false);
    }
    assert.equal(inspectRestore(f.packet.state, f.options).class, 'closed');
  });
}
