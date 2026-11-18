import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { auditAppliedPlan } from '../src/applied-plan.ts';
import { capture, captureReview } from '../src/capture.ts';
import { ToolError } from '../src/errors.ts';
import { plan, preparePlan, type PlanOptions } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import type { Platform } from '../src/schema.ts';
import { readAppliedRestore, rollbackRestore, type TxOptions } from '../src/transaction.ts';

const body = 'Fixture agent instructions\n';
const settingsBytes = '{\n  "defaultModel": "fixture-model",\n  "theme": "dark"\n}\n';
const hash = (bytes: string) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-applied-qa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'AGENTS.md'), body);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ theme: 'dark', defaultModel: 'fixture-model' }));
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: {
    settings: ['theme', 'defaultModel'], files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }],
  } } }));
  const platform = process.platform as Platform; const env = {}; const guard = { home };
  const input = { policy, sourceAgent: source, platform, env, guard };
  const makeBundle = (out: string) => {
    const review = captureReview(input); capture({ ...input, out, approveInclusion: review.captureReviewToken });
  };
  const bundle = path.join(root, 'bundle'); makeBundle(bundle);
  const options: PlanOptions = { bundle, platform, targetAgent: path.join(root, 'target'), env, guard };
  const deps: TxOptions['deps'] = { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'fixture-host', uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive' };
  const stateDir = path.join(root, 'state');
  const context = { env, guard, deps, expectedTargets: { agent: options.targetAgent, lens: null } };
  return { root, source, makeBundle, options, deps, stateDir, context };
}
function error(fn: () => unknown, code: string, exit: number) {
  assert.throws(fn, (e: unknown) => e instanceof ToolError && e.code === code && e.exit === exit);
}
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(name);
      else result[path.relative(root, name)] = fs.readFileSync(name).toString('base64');
    }
  }
  if (fs.existsSync(root)) visit(root);
  return result;
}
function applied(t: TestContext) {
  const f = fixture(t); const preview = plan(f.options);
  assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
  const result = restoreFromPlan({ ...f.options, stateDir: f.stateDir, deps: f.deps, approveActivation: preview.approvalToken });
  assert.equal(result.status, 'applied'); return { ...f, token: preview.approvalToken, tx: result.tx };
}

test('applied proof compares exact outputs without changing state or target', (t) => {
  const f = applied(t); const beforeState = files(f.stateDir); const beforeTarget = files(f.options.targetAgent);
  const preview = plan(f.options); const prepared = preparePlan(f.options);
  assert.equal(preview.status, 'conflict'); assert.equal(preview.approvalToken, null); assert.equal(prepared.intentToken, f.token);
  const audited = auditAppliedPlan({ ...f.options, stateDir: f.stateDir, tx: f.tx, deps: f.deps }); const s = audited.snapshot;
  assert.equal(s.tx, f.tx); assert.equal(s.planToken, f.token); assert.equal(s.platform, f.options.platform);
  assert.deepEqual(s.targets, { agent: f.options.targetAgent, lens: null });
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.targets) && Object.isFrozen(s.outputs));
  assert.ok(s.outputs.every(Object.isFrozen));
  assert.deepEqual([...s.outputs].sort((a, b) => a.path.localeCompare(b.path)), [
    { root: 'agent', path: 'AGENTS.md', class: 'agent-context', sha256: hash(body), bytes: Buffer.byteLength(body) },
    { root: 'agent', path: 'settings.json', class: 'settings', sha256: hash(settingsBytes), bytes: Buffer.byteLength(settingsBytes) },
  ]);
  assert.equal(fs.readFileSync(path.join(f.options.targetAgent, 'AGENTS.md'), 'utf8'), body);
  assert.equal(fs.readFileSync(path.join(f.options.targetAgent, 'settings.json'), 'utf8'), settingsBytes);
  const serialized = JSON.stringify(preview);
  assert.ok(!serialized.includes('intentToken') && !serialized.includes('fixture-model'));
  assert.ok(!serialized.includes('Fixture agent instructions'));
  assert.deepEqual(files(f.stateDir), beforeState); assert.deepEqual(files(f.options.targetAgent), beforeTarget);
});

test('private candidate cannot authorize a second apply', (t) => {
  const f = applied(t); const candidate = preparePlan(f.options).intentToken;
  assert.equal(candidate, f.token); const secondState = path.join(f.root, 'second-state'); const before = files(f.options.targetAgent);
  error(() => restoreFromPlan({ ...f.options, stateDir: secondState, deps: f.deps, approveActivation: candidate! }), 'plan-not-ready', 1);
  assert.equal(fs.existsSync(secondState), false); assert.deepEqual(files(f.options.targetAgent), before);
});

test('transaction and explicit target context bind the read-only proof', (t) => {
  const f = applied(t); const beforeState = files(f.stateDir); const beforeTarget = files(f.options.targetAgent);
  const wrongTx = `${f.tx[0] === '0' ? '1' : '0'}${f.tx.slice(1)}`;
  error(() => readAppliedRestore(f.stateDir, wrongTx, f.context), 'tx-mismatch', 1);
  error(() => readAppliedRestore(f.stateDir, f.tx, { ...f.context, expectedTargets: { agent: path.join(f.root, 'other'), lens: null } }), 'target-context-mismatch', 1);
  error(() => readAppliedRestore(f.stateDir, f.tx, { env: {}, guard: f.options.guard, deps: f.deps } as Parameters<typeof readAppliedRestore>[2]), 'target-context-required', 2);
  assert.deepEqual(files(f.stateDir), beforeState); assert.deepEqual(files(f.options.targetAgent), beforeTarget);
});

test('changed owned output cannot be adopted or repaired', (t) => {
  const f = applied(t); fs.writeFileSync(path.join(f.options.targetAgent, 'AGENTS.md'), 'changed\n');
  const beforeState = files(f.stateDir); const beforeTarget = files(f.options.targetAgent);
  error(() => readAppliedRestore(f.stateDir, f.tx, f.context), 'restore-not-applied', 1);
  assert.deepEqual(files(f.stateDir), beforeState); assert.deepEqual(files(f.options.targetAgent), beforeTarget);
});

test('a different approved capture cannot match the applied intent', (t) => {
  const f = applied(t); fs.writeFileSync(path.join(f.source, 'AGENTS.md'), 'Different approved instructions\n');
  const bundle = path.join(f.root, 'other-bundle'); f.makeBundle(bundle);
  assert.equal(readAppliedRestore(f.stateDir, f.tx, f.context).tx, f.tx);
  const beforeState = files(f.stateDir); const beforeTarget = files(f.options.targetAgent);
  error(() => auditAppliedPlan({ ...f.options, bundle, stateDir: f.stateDir, tx: f.tx, deps: f.deps }), 'restore-intent-mismatch', 1);
  assert.deepEqual(files(f.stateDir), beforeState); assert.deepEqual(files(f.options.targetAgent), beforeTarget);
});

test('rolled-back state cannot be adopted', (t) => {
  const f = applied(t); rollbackRestore(f.stateDir, f.tx, f.context);
  const beforeState = files(f.stateDir); const beforeTarget = files(f.options.targetAgent);
  error(() => readAppliedRestore(f.stateDir, f.tx, f.context), 'restore-not-applied', 1);
  assert.deepEqual(files(f.stateDir), beforeState); assert.deepEqual(files(f.options.targetAgent), beforeTarget);
});

test('missing parent and incomplete resources do not produce comparable intent', (t) => {
  const f = fixture(t); const missing = preparePlan({ ...f.options, targetAgent: path.join(f.root, 'missing', 'target') });
  assert.equal(missing.result.status, 'conflict'); assert.equal(missing.intentToken, null);
  fs.writeFileSync(path.join(f.source, 'settings.json'), JSON.stringify({ prompts: ['prompts/missing.md'] }));
  fs.writeFileSync(path.join(f.root, 'policy.json'), JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion',
    layers: { common: { settings: ['prompts'], files: [] } } }));
  const bundle = path.join(f.root, 'incomplete-bundle'); f.makeBundle(bundle);
  const incomplete = preparePlan({ ...f.options, bundle });
  assert.equal(incomplete.result.status, 'incomplete'); assert.equal(incomplete.result.approvalToken, null); assert.equal(incomplete.intentToken, null);
});
