/** Public fixture-only restore lifecycle; never starts Pi or installs packages. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture, captureReview } from '../src/capture.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const platform = process.platform as Platform;
const privateValue = 'PRIVATE-CLI-MODEL-VALUE';
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-cli-restore-'));
  roots.push(root);
  const home = path.join(root, 'home'); const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ theme: 'dark', defaultModel: privateValue }));
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Private fixture instructions\n');
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: {
    settings: ['theme', 'defaultModel'], files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }],
  } } }));
  const input = { policy, sourceAgent: source, platform, env: {}, guard: { home } };
  const approval = captureReview(input).captureReviewToken;
  const bundle = path.join(root, 'bundle');
  capture({ ...input, out: bundle, approveInclusion: approval });
  return { root, bundle, target: path.join(root, 'target'), state: path.join(root, 'state') };
}
type Fixture = ReturnType<typeof fixture>;
function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, 'CLI timeout or launch failure');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(privateValue), 'private selected value leaked');
  return result;
}
function failure(args: string[], code: string, status: number) {
  const result = run(args);
  assert.equal(result.status, status, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: code });
  assert.equal(result.stdout, '');
}
function planArgs(f: Fixture) { return ['plan', '--bundle', f.bundle, '--platform', platform, '--target-agent', f.target]; }
function applyArgs(f: Fixture) { return ['apply', '--bundle', f.bundle, '--platform', platform, '--target-agent', f.target, '--state-dir', f.state]; }
function stateArgs(f: Fixture) { return ['--state-dir', f.state, '--target-agent', f.target]; }
function applied(f: Fixture) {
  const preview = run(planArgs(f)); assert.equal(preview.status, 0, preview.stderr);
  const token = JSON.parse(preview.stdout).approvalToken;
  const result = run([...applyArgs(f), '--approve-activation', token]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { tx: string; status: string };
}

test('real CLI plan/apply/inspect/rollback lifecycle stays bound to its target', () => {
  const f = fixture(); const result = applied(f);
  assert.equal(result.status, 'applied');
  const settings = path.join(f.target, 'settings.json');
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).defaultModel, privateValue);
  const inspect = run(['recover', ...stateArgs(f), '--inspect']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).class, 'applied');
  const journal = fs.readFileSync(path.join(f.state, 'journal.json'));
  const wrong = { ...f, target: path.join(f.root, 'other-target') };
  failure(['recover', ...stateArgs(wrong), '--inspect'], 'target-context-mismatch', 1);
  failure(['rollback', ...stateArgs(wrong), '--tx', result.tx], 'target-context-mismatch', 1);
  failure(['recover', ...stateArgs(wrong), '--resolve', '--tx', result.tx, '--expect', 'applied', '--action', 'rollback'], 'target-context-mismatch', 1);
  assert.deepEqual(fs.readFileSync(path.join(f.state, 'journal.json')), journal);
  assert.ok(fs.existsSync(settings));
  const undo = run(['rollback', ...stateArgs(f), '--tx', result.tx]);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(JSON.parse(undo.stdout).status, 'rolled-back');
  assert.equal(fs.existsSync(settings), false);
  assert.equal(fs.existsSync(path.join(f.target, 'AGENTS.md')), false);
  fs.writeFileSync(settings, 'foreign replacement');
  const repeat = run(['rollback', ...stateArgs(f), '--tx', result.tx]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).removed, 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), 'foreign replacement');
});

test('explicit CLI recovery action reports previous class and can be inspected afterwards', () => {
  const f = fixture(); const result = applied(f);
  const resolved = run(['recover', ...stateArgs(f), '--resolve', '--tx', result.tx, '--expect', 'applied', '--action', 'rollback']);
  assert.equal(resolved.status, 0, resolved.stderr);
  const action = JSON.parse(resolved.stdout);
  assert.equal(action.previousClass, 'applied'); assert.equal(action.action, 'rollback');
  const after = run(['recover', ...stateArgs(f), '--inspect']);
  assert.equal(after.status, 0, after.stderr); assert.equal(JSON.parse(after.stdout).class, 'rolled-back');
});

test('CLI activation refusals never create state or target', () => {
  const f = fixture();
  failure(applyArgs(f), 'activation-approval-required', 2);
  failure([...applyArgs(f), '--approve-activation', 'invalid'], 'approval-token-invalid', 2);
  failure([...applyArgs(f), '--approve-activation', `sha256:${'0'.repeat(64)}`], 'activation-approval-mismatch', 1);
  assert.equal(fs.existsSync(f.state), false); assert.equal(fs.existsSync(f.target), false);
});

test('CLI never accepts internal dependencies or ambiguous recovery modes', () => {
  const f = fixture();
  for (const flag of ['--deps', '--guard', '--fault', '--verify-locked-intent']) failure([...applyArgs(f), flag, 'true'], 'usage', 2);
  for (const args of [[], ['--inspect', '--resolve'], ['--inspect', '--tx', '0'.repeat(32)], ['--resolve']]) {
    failure(['recover', ...stateArgs(f), ...args], 'usage', 2);
  }
  for (const command of ['constructor', '__proto__', 'toString']) failure([command], 'usage', 2);
  assert.equal(fs.existsSync(f.state), false); assert.equal(fs.existsSync(f.target), false);
});
