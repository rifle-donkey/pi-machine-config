/** Metadata-only reservation checks, including probe failures and enumeration races. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { applyRestore, inspectRestore, type RestorePacket, type TxOptions } from '../src/transaction.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-attempt-')));
  roots.push(root);
  const state = path.join(root, 'state');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(state, { mode: 0o700 });
  const marker = path.join(state, 'package-attempt.json');
  const opts: TxOptions = {
    env: {}, guard: { home },
    deps: {
      platform: process.platform,
      uid: () => process.getuid?.() ?? 0,
      bootId: () => { assert.fail('attempt exclusion must precede boot probes'); },
      probePid: () => { assert.fail('attempt exclusion must precede PID probes'); },
    },
  };
  return { root, state, marker, opts };
}

test('an unprovable attempt probe is exclusion, not absence', () => {
  const f = fixture();
  const original = fs.lstatSync;
  const probe = mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === f.marker) throw Object.assign(new Error('private sentinel'), { code: 'EACCES' });
    return Reflect.apply(original, fs, args);
  }) as typeof fs.lstatSync);
  try {
    const result = inspectRestore(f.state, f.opts);
    assert.equal(result.class, 'corrupt');
    assert.equal(result.reason, 'package-attempt-unresolved');
    assert.equal(result.tx, null);
    assert.deepEqual(result.actions, []);
    assert.equal(JSON.stringify(result).includes('private sentinel'), false);
  } finally {
    probe.mock.restore();
  }
});

test('a marker missed by the probe still fails the unchanged state allowlist', () => {
  const f = fixture();
  fs.writeFileSync(f.marker, 'never open this marker', { mode: 0o600 });
  const original = fs.lstatSync;
  let misses = 0;
  const probe = mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === f.marker) {
      misses++;
      throw Object.assign(new Error('fixture absence'), { code: 'ENOENT' });
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.lstatSync);
  try {
    const result = inspectRestore(f.state, f.opts);
    assert.equal(misses, 1);
    assert.equal(result.class, 'corrupt');
    assert.equal(result.reason, 'state-unexpected-entry');
    assert.deepEqual(result.actions, []);
  } finally {
    probe.mock.restore();
  }
});

test('exact attempt exclusion precedes the state-entry limit', () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(f.state, `unknown-${i}`), '');
  fs.writeFileSync(f.marker, '');
  const result = inspectRestore(f.state, f.opts);
  assert.equal(result.class, 'corrupt');
  assert.equal(result.reason, 'package-attempt-unresolved');
  assert.deepEqual(result.actions, []);
});

test('fresh apply checks after its verifier and before its first journal', () => {
  const f = fixture();
  fs.rmdirSync(f.state);
  const token = `sha256:${'a'.repeat(64)}`;
  const bytes = Buffer.from('# Fixture rules\n');
  const agent = path.join(f.root, 'agent');
  const packet: RestorePacket = {
    planToken: token, platform: process.platform as Platform,
    state: f.state, agentTarget: agent, lensTarget: null,
    settings: {}, packages: [], protectedRoots: [],
    files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }],
  };
  let verified = false;
  assert.throws(() => applyRestore(packet, {
    ...f.opts,
    deps: { ...f.opts.deps, bootId: () => '11111111-2222-4333-8444-555555555555' },
    verifyLockedIntent() {
      verified = true;
      fs.writeFileSync(f.marker, 'private attempt', { mode: 0o600 });
      return token;
    },
  }), (e: unknown) => e instanceof ToolError && e.exit === 1 && e.code === 'package-attempt-unresolved');
  assert.equal(verified, true);
  assert.equal(fs.existsSync(path.join(f.state, 'journal.json')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'lock.json')), false);
  assert.equal(fs.existsSync(agent), false);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'private attempt');
});
