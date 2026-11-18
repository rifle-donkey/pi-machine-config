import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, captureReview } from '../src/capture.ts';
import { plan, type PlanOptions, type PlanResult } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import { rollbackRestore, type TxOptions } from '../src/transaction.ts';
import { ToolError } from '../src/errors.ts';
import type { Platform } from '../src/schema.ts';

const wrongToken = `sha256:${'0'.repeat(64)}`;
function fixture(t: TestContext, settings: Record<string, unknown>, files: Record<string, string> = { 'prompts/simple.md': 'hello\n' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-prompt-qa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(source);
  for (const [name, contents] of Object.entries(files)) {
    const dest = path.join(source, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, contents);
  }
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify(settings));
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: {
    settings: Object.keys(settings).filter((key) => key !== 'packages'), packages: settings.packages ?? [],
    files: Object.keys(files).map((name) => ({ root: 'agent', path: name, class: 'prompt', template: false })),
  } } }));
  const platform = process.platform as Platform; const env = {}; const guard = { home };
  const input = { policy, sourceAgent: source, platform, env, guard }; const bundle = path.join(root, 'bundle');
  const review = captureReview(input);
  capture({ ...input, out: bundle, approveInclusion: review.captureReviewToken });
  const options: PlanOptions = { bundle, platform, targetAgent: path.join(root, 'target'), env, guard };
  const deps: TxOptions['deps'] = { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'fixture-host', uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive' };
  return { options, deps, stateDir: path.join(root, 'state') };
}
function setting(preview: PlanResult) {
  const item = preview.items.find((i) => i.kind === 'setting' && i.key === 'prompts');
  assert.ok(item && item.kind === 'setting'); return item;
}
function noOutputs(f: ReturnType<typeof fixture>) {
  assert.equal(fs.existsSync(f.stateDir), false); assert.equal(fs.existsSync(f.options.targetAgent), false);
}
function refused(f: ReturnType<typeof fixture>) {
  const preview = plan(f.options);
  assert.equal(preview.status, 'incomplete'); assert.equal(preview.approvalToken, null);
  assert.equal(setting(preview).operation, 'incomplete');
  assert.equal(setting(preview).reason, 'resource-reference-unverified');
  assert.throws(() => restoreFromPlan({ ...f.options, stateDir: f.stateDir, deps: f.deps, approveActivation: wrongToken }),
    (e: unknown) => e instanceof ToolError && e.code === 'plan-not-ready' && e.exit === 1);
  noOutputs(f);
}

test('approved exact references preserve bytes and roll back once', (t) => {
  const entries = ['prompts/simple.md', '+prompts/simple.md', 'prompts/simple.md'];
  const bytes = '\uFEFFHello $1 and $@\r\nSecond line\r\n';
  const f = fixture(t, { prompts: entries }, { 'prompts/simple.md': bytes }); const preview = plan(f.options);
  assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
  assert.equal(setting(preview).operation, 'activation-required');
  assert.equal(preview.items.filter((i) => i.kind === 'file' && i.path === 'prompts/simple.md').length, 1);
  const restore = { ...f.options, stateDir: f.stateDir, deps: f.deps };
  assert.throws(() => restoreFromPlan({ ...restore, approveActivation: wrongToken }),
    (e: unknown) => e instanceof ToolError && e.code === 'activation-approval-mismatch' && e.exit === 1);
  noOutputs(f);
  const applied = restoreFromPlan({ ...restore, approveActivation: preview.approvalToken });
  assert.equal(applied.status, 'applied');
  const target = path.join(f.options.targetAgent, 'prompts/simple.md');
  const targetSettings = path.join(f.options.targetAgent, 'settings.json');
  assert.deepEqual(fs.readFileSync(target), Buffer.from(bytes));
  assert.deepEqual(JSON.parse(fs.readFileSync(targetSettings, 'utf8')).prompts, entries);
  const undone = rollbackRestore(f.stateDir, applied.tx, { env: {}, guard: f.options.guard, deps: f.deps,
    expectedTargets: { agent: f.options.targetAgent, lens: null } });
  assert.equal(undone.removed, 2);
  assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(targetSettings), false);
});

test('closed frontmatter and repeated BOM refuse positive selection', (t) => {
  for (const body of ['---\n---', '---title\n---', '---\r\nkey: value\r\n---\r\nbody',
    '---\rkey: value\r---\rbody', '\uFEFF---\n---', '\uFEFF\uFEFFplain body']) {
    refused(fixture(t, { prompts: ['prompts/simple.md'] }, { 'prompts/simple.md': body }));
  }
  refused(fixture(t, { prompts: ['prompts/simple.md'] }, {
    'prompts/simple.md': 'plain', 'prompts/sibling.md': '---\n---\nnot selected',
  }));
});

test('unsupported references and package discovery refuse activation', (t) => {
  for (const entries of [['prompts/missing.md'], ['./prompts/simple.md'], ['prompts/'], ['prompts/*.md'],
    ['prompts/simple.md', '!prompts/other.md'], ['prompts/\u00e9.md']]) refused(fixture(t, { prompts: entries }));
  for (const declaration of ['npm:fixture-package', { source: 'npm:fixture-package', autoload: false, prompts: [] }]) {
    refused(fixture(t, { prompts: ['prompts/simple.md'], packages: [declaration] }));
  }
});

test('empty, negative-only and file-only classifications remain unchanged', (t) => {
  for (const entries of [[], ['-prompts/simple.md']]) {
    const f = fixture(t, { prompts: entries }, { 'prompts/simple.md': '---\n---' }); const preview = plan(f.options);
    assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
    assert.equal(setting(preview).operation, 'activation-required'); noOutputs(f);
  }
  const f = fixture(t, {}, { 'prompts/simple.md': '---\n---' }); const preview = plan(f.options);
  assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
  assert.ok(preview.items.some((i) => i.kind === 'file' && i.path === 'prompts/simple.md' && i.operation === 'activation-required'));
  noOutputs(f);
});

test('unclosed marker and later body rule remain plain for this contract', (t) => {
  for (const body of ['---\nunclosed', 'body\n---\nmore']) {
    const f = fixture(t, { prompts: ['+prompts/simple.md'] }, { 'prompts/simple.md': body }); const preview = plan(f.options);
    assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
    assert.equal(setting(preview).operation, 'activation-required'); noOutputs(f);
  }
});
