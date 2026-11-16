import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture, captureReview } from '../src/capture.ts';
import type { Platform } from '../src/schema.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = process.platform as Platform;
const instructions = 'Independent fixture instructions\n';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-cli-qa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(home);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), instructions);
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({
    schemaVersion: 1, kind: 'pi-machine-config/inclusion',
    layers: { common: {
      settings: ['theme'],
      files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }],
    } },
  }));
  const input = { policy, sourceAgent: source, platform, env: {}, guard: { home } };
  const bundle = path.join(root, 'bundle');
  const review = captureReview(input);
  capture({ ...input, out: bundle, approveInclusion: review.captureReviewToken });
  return { root, bundle, target: path.join(root, 'target'), state: path.join(root, 'state') };
}
type Fixture = ReturnType<typeof fixture>;

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024,
  });
  assert.equal(r.error, undefined, 'CLI failed to launch or timed out');
  return r;
}
function error(args: string[], status: number, code: string) {
  const r = run(args);
  assert.equal(r.status, status);
  assert.equal(r.stdout, '');
  assert.equal(JSON.parse(r.stderr).error, code);
}
function planArgs(f: Fixture) {
  return ['plan', '--bundle', f.bundle, '--platform', platform, '--target-agent', f.target];
}
function applyArgs(f: Fixture) {
  return ['apply', '--bundle', f.bundle, '--platform', platform,
    '--target-agent', f.target, '--state-dir', f.state];
}
function stateArgs(f: Fixture) {
  return ['--state-dir', f.state, '--target-agent', f.target];
}
function applied(f: Fixture) {
  const p = run(planArgs(f));
  assert.equal(p.status, 0, p.stderr);
  const preview = JSON.parse(p.stdout);
  assert.equal(preview.status, 'ready');
  assert.match(preview.approvalToken, /^sha256:[a-f0-9]{64}$/);
  const r = run([...applyArgs(f), '--approve-activation', preview.approvalToken]);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, 'applied');
  return result.tx as string;
}
function bytes(f: Fixture) {
  return {
    journal: fs.readFileSync(path.join(f.state, 'journal.json')),
    settings: fs.readFileSync(path.join(f.target, 'settings.json')),
    instructions: fs.readFileSync(path.join(f.target, 'AGENTS.md')),
  };
}

test('approved lifecycle is read-only on inspect and bound to target context', t => {
  const f = fixture(t);
  const tx = applied(f);
  const before = bytes(f);
  assert.deepEqual(JSON.parse(before.settings.toString()), { theme: 'dark' });
  assert.equal(before.instructions.toString(), instructions);
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.state, 'journal.json')).mode & 0o777, 0o600);

  const inspect = run(['recover', ...stateArgs(f), '--inspect']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).class, 'applied');
  assert.deepEqual(bytes(f), before);

  const wrong = { ...f, target: path.join(f.root, 'wrong-target') };
  error(['recover', ...stateArgs(wrong), '--inspect'], 1, 'target-context-mismatch');
  error(['rollback', ...stateArgs(wrong), '--tx', tx], 1, 'target-context-mismatch');
  assert.deepEqual(bytes(f), before);
  assert.equal(fs.existsSync(wrong.target), false);

  const undo = run(['rollback', ...stateArgs(f), '--tx', tx]);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(JSON.parse(undo.stdout).status, 'rolled-back');
  assert.equal(fs.existsSync(path.join(f.target, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(f.target, 'AGENTS.md')), false);
});

test('edited group member prevents removal of the other member', t => {
  const f = fixture(t);
  const tx = applied(f);
  const settings = path.join(f.target, 'settings.json');
  const agent = path.join(f.target, 'AGENTS.md');
  const originalSettings = fs.readFileSync(settings);
  fs.writeFileSync(agent, 'Edited after apply\n');
  error(['rollback', ...stateArgs(f), '--tx', tx], 1, 'rollback-conflict');
  assert.deepEqual(fs.readFileSync(settings), originalSettings);
  assert.equal(fs.readFileSync(agent, 'utf8'), 'Edited after apply\n');
});

test('activation consent failures leave both state and target absent', t => {
  const f = fixture(t);
  const p = run(planArgs(f));
  assert.equal(p.status, 0, p.stderr);
  assert.notEqual(JSON.parse(p.stdout).approvalToken, `sha256:${'0'.repeat(64)}`);
  for (const [extra, status, code] of [
    [[], 2, 'activation-approval-required'],
    [['--approve-activation', 'invalid'], 2, 'approval-token-invalid'],
    [['--approve-activation', `sha256:${'0'.repeat(64)}`], 1, 'activation-approval-mismatch'],
  ] as [string[], number, string][]) {
    error([...applyArgs(f), ...extra], status, code);
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(fs.existsSync(f.target), false);
  }
});

test('recovery requires explicit unambiguous arguments and rejects internal flags', t => {
  const f = fixture(t);
  const base = ['recover', ...stateArgs(f)];
  for (const extra of [
    [], ['--inspect', '--resolve'],
    ['--inspect', '--tx', 'id'],
    ['--resolve', '--expect', 'applied', '--action', 'rollback'],
    ['--resolve', '--tx', 'id', '--action', 'rollback'],
    ['--resolve', '--tx', 'id', '--expect', 'applied'],
  ]) error([...base, ...extra], 2, 'usage');
  error([...applyArgs(f), '--fault', 'true'], 2, 'usage');
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(fs.existsSync(f.target), false);
});

test('corrupt journal inspection offers no actions and does not mutate evidence', t => {
  const f = fixture(t);
  applied(f);
  const journal = path.join(f.state, 'journal.json');
  fs.writeFileSync(journal, '{broken');
  const before = bytes(f);
  const r = run(['recover', ...stateArgs(f), '--inspect']);
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.equal(result.class, 'corrupt');
  assert.deepEqual(result.actions, []);
  assert.deepEqual(bytes(f), before);
});
