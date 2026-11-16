/** Journal context binding, including lens journals seeded through the internal engine. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { main } from '../src/cli.ts';
import { ToolError } from '../src/errors.ts';
import { applyRestore, inspectRestore, type RestorePacket, type TxOptions } from '../src/transaction.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(lens: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-context-'));
  roots.push(root);
  const home = path.join(root, 'home'); const external = path.join(root, 'external');
  fs.mkdirSync(home); fs.mkdirSync(external);
  const target = path.join(root, 'agent'); const state = path.join(root, 'state');
  const lensPath = path.join(external, 'config.json'); const platform = process.platform as Platform;
  const body = Buffer.from('{"fixture":true}\n');
  const packet: RestorePacket = { planToken: `sha256:${'a'.repeat(64)}`, platform, state, agentTarget: target,
    lensTarget: lens ? lensPath : null, settings: { theme: 'dark' }, packages: [], protectedRoots: [],
    files: lens ? [{ root: 'lens-config', path: 'config.json', class: 'external-config', bytes: body,
      sha256: crypto.createHash('sha256').update(body).digest('hex') }] : [] };
  const opts: TxOptions = { env: {}, guard: { home }, deps: { platform,
    bootId: () => '11111111-2222-4333-8444-555555555555', hostname: () => 'fixture-host',
    uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive' } };
  // This trusted packet is only a recovery fixture; public lens plans remain incomplete.
  const applied = applyRestore(packet, opts);
  const run = (args: string[]) => main(args, {}, { home });
  const base = ['--state-dir', state, '--target-agent', target];
  const snapshot = () => [fs.readFileSync(path.join(state, 'journal.json')), fs.readFileSync(path.join(target, 'settings.json')),
    ...(lens ? [fs.readFileSync(lensPath)] : [])];
  return { root, home, target, state, lensPath, opts, applied, run, base, snapshot };
}
function cliError(result: ReturnType<typeof main>, code: string, exit: number) {
  assert.equal(result.code, exit, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: code });
}

test('a recorded lens is mandatory for inspect, rollback and explicit recovery', () => {
  const f = fixture(true); const lens = ['--lens-config', f.lensPath];
  const control = f.run(['recover', ...f.base, ...lens, '--inspect']);
  assert.equal(control.code, 0, control.stderr);
  assert.equal(JSON.parse(control.stdout).class, 'applied');
  const before = f.snapshot();
  cliError(f.run(['recover', ...f.base, '--inspect']), 'target-context-mismatch', 1);
  cliError(f.run(['rollback', ...f.base, '--tx', f.applied.tx]), 'target-context-mismatch', 1);
  cliError(f.run(['recover', ...f.base, '--resolve', '--tx', f.applied.tx, '--expect', 'applied', '--action', 'rollback']), 'target-context-mismatch', 1);
  assert.deepEqual(f.snapshot(), before);
});

test('an extra or wrong lens cannot rebind a transaction', () => {
  const without = fixture(false);
  assert.equal(without.run(['recover', ...without.base, '--inspect']).code, 0);
  const before = without.snapshot();
  cliError(without.run(['recover', ...without.base, '--lens-config', without.lensPath, '--inspect']), 'target-context-mismatch', 1);
  assert.deepEqual(without.snapshot(), before);
  const withLens = fixture(true);
  const prior = withLens.snapshot();
  cliError(withLens.run(['recover', ...withLens.base, '--lens-config', path.join(withLens.root, 'wrong.json'), '--inspect']), 'target-context-mismatch', 1);
  assert.deepEqual(withLens.snapshot(), prior);
});

test('a mismatched lens is rejected before any target-file or target-lock body opens', () => {
  const f = fixture(true);
  const open = mock.method(fs, 'openSync');
  let result: ReturnType<typeof main>;
  let reads = 0;
  let journalReads = 0;
  try {
    result = f.run(['recover', ...f.base, '--inspect']);
    journalReads = open.mock.calls.filter((c) => c.arguments[0] === path.join(f.state, 'journal.json')).length;
    reads = open.mock.calls.filter((c) => typeof c.arguments[0] === 'string' &&
      (c.arguments[0].startsWith(`${f.target}/`) || c.arguments[0] === f.lensPath)).length;
  } finally { open.mock.restore(); }
  cliError(result!, 'target-context-mismatch', 1);
  assert.ok(journalReads > 0, 'open watcher did not observe even the state journal');
  assert.equal(reads, 0);
});

test('malformed and relative expected-target contexts refuse before mutation', () => {
  const f = fixture(false); const before = f.snapshot();
  for (const expectedTargets of [null, { agent: f.target }, { agent: f.target, lens: 1 }, { agent: f.target, lens: null, extra: true }]) {
    assert.throws(() => inspectRestore(f.state, { ...f.opts, expectedTargets: expectedTargets as unknown as NonNullable<TxOptions['expectedTargets']> }),
      (e: unknown) => e instanceof ToolError && e.code === 'target-context-invalid' && e.exit === 2);
  }
  cliError(f.run(['recover', '--state-dir', f.state, '--target-agent', 'relative', '--inspect']), 'usage', 2);
  cliError(f.run(['recover', ...f.base, '--lens-config', 'relative', '--inspect']), 'usage', 2);
  assert.deepEqual(f.snapshot(), before);
});

test('a live expected target refuses before reading a valid state journal', () => {
  const f = fixture(false); const before = f.snapshot();
  cliError(f.run(['recover', '--state-dir', f.state, '--target-agent', path.join(f.home, '.pi', 'agent'), '--inspect']), 'live-path-refused', 2);
  assert.deepEqual(f.snapshot(), before);
});

test('an expected target reached through an unchanged symlinked parent is accepted', () => {
  const f = fixture(true);
  const parent = path.join(f.root, 'parent-alias');
  fs.symlinkSync(f.root, parent);
  const before = f.snapshot();
  const result = f.run(['recover', '--state-dir', f.state, '--target-agent', path.join(parent, 'agent'),
    '--lens-config', path.join(parent, 'external/config.json'), '--inspect']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).class, 'applied');
  assert.deepEqual(f.snapshot(), before);
});
