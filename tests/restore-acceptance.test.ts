import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { capture, captureReview } from '../src/capture.ts';
import { ToolError } from '../src/errors.ts';
import { plan } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';

const badToken = `sha256:${'0'.repeat(64)}`;
const model = 'qa-private-model-value';
const text = 'qa-private-agent-instructions\n';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-gate-qa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(home);
  fs.mkdirSync(source);
  t.mock.method(os, 'userInfo', () => ({
    username: 'fixture', uid: 123, gid: 123, shell: null, homedir: home,
  }));
  fs.writeFileSync(path.join(source, 'settings.json'),
    JSON.stringify({ theme: 'dark', defaultModel: model, hideThinkingBlock: true }));
  fs.writeFileSync(path.join(source, 'AGENTS.md'), text);
  const policy = path.join(root, 'policy.json');
  const writePolicy = (theme = false) => {
    const files = [
      { root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false },
      ...(theme ? [{ root: 'agent', path: 'themes/custom.json', class: 'theme', template: false }] : []),
    ];
    fs.writeFileSync(policy, JSON.stringify({
      schemaVersion: 1, kind: 'pi-machine-config/inclusion',
      layers: { common: { settings: ['theme', 'defaultModel'], files } },
    }));
  };
  writePolicy();
  const platform = 'linux' as const;
  const env = {};
  const guard = { home };
  const input = { policy, sourceAgent: source, platform, env, guard };
  const bundle = path.join(root, 'bundle');
  const captureTo = (out: string) => {
    const review = captureReview(input);
    capture({ ...input, out, approveInclusion: review.captureReviewToken });
  };
  captureTo(bundle);
  const targetAgent = path.join(root, 'target');
  const stateDir = path.join(root, 'state');
  const opts = { bundle, platform, targetAgent, env, guard };
  const deps = {
    platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'qa-fixture', uid: () => process.getuid?.() ?? 0,
    pid: () => process.pid, probePid: () => 'alive' as const,
  };
  const ready = () => {
    const result = plan(opts);
    assert.equal(result.status, 'ready');
    assert.match(result.approvalToken ?? '', /^sha256:[a-f0-9]{64}$/);
    return result.approvalToken!;
  };
  return { root, source, bundle, targetAgent, stateDir, opts, deps, ready, captureTo, writePolicy };
}

function expectError(fn: () => unknown, code: string, exit: number) {
  assert.throws(fn, (e: unknown) => e instanceof ToolError && e.code === code && e.exit === exit);
}

test('approved ready intent restores only selected data and keeps journal private', t => {
  const f = fixture(t);
  const token = f.ready();
  const publicJson = JSON.stringify(plan(f.opts));
  assert.ok(!publicJson.includes(model));
  assert.ok(!publicJson.includes(text.trim()));
  const result = restoreFromPlan({ ...f.opts, stateDir: f.stateDir, approveActivation: token, deps: f.deps });
  assert.equal(result.status, 'applied');
  assert.deepEqual(fs.readdirSync(f.targetAgent).sort(), ['AGENTS.md', 'settings.json']);
  assert.equal(fs.readFileSync(path.join(f.targetAgent, 'AGENTS.md'), 'utf8'), text);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.targetAgent, 'settings.json'), 'utf8')),
    { theme: 'dark', defaultModel: model });
  assert.deepEqual(fs.readdirSync(f.stateDir), ['journal.json']);
  assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.stateDir, 'journal.json')).mode & 0o777, 0o600);
});

for (const [label, approval, code, exit] of [
  ['missing', undefined, 'activation-approval-required', 2],
  ['malformed', 'not-a-token', 'approval-token-invalid', 2],
  ['wrong', badToken, 'activation-approval-mismatch', 1],
] as const) {
  test(`${label} consent cannot create state or target`, t => {
    const f = fixture(t);
    const token = f.ready();
    assert.notEqual(token, badToken);
    expectError(() => restoreFromPlan({
      ...f.opts, stateDir: f.stateDir, approveActivation: approval, deps: f.deps,
    }), code, exit);
    assert.equal(fs.existsSync(f.stateDir), false);
    assert.equal(fs.existsSync(f.targetAgent), false);
  });
}

test('incomplete intent is refused before state or target creation', t => {
  const f = fixture(t);
  const token = f.ready();
  fs.mkdirSync(path.join(f.source, 'themes'));
  fs.writeFileSync(path.join(f.source, 'themes/custom.json'), '{}');
  f.writePolicy(true);
  const incomplete = path.join(f.root, 'incomplete');
  f.captureTo(incomplete);
  const opts = { ...f.opts, bundle: incomplete };
  assert.equal(plan(opts).status, 'incomplete');
  expectError(() => restoreFromPlan({
    ...opts, stateDir: f.stateDir, approveActivation: token, deps: f.deps,
  }), 'plan-not-ready', 1);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.existsSync(f.targetAgent), false);
});

test('conflicting target remains untouched and no state is created', t => {
  const f = fixture(t);
  const token = f.ready();
  fs.mkdirSync(f.targetAgent);
  fs.writeFileSync(path.join(f.targetAgent, 'keep'), 'unmanaged');
  assert.equal(plan(f.opts).status, 'conflict');
  expectError(() => restoreFromPlan({
    ...f.opts, stateDir: f.stateDir, approveActivation: token, deps: f.deps,
  }), 'plan-not-ready', 1);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.deepEqual(fs.readdirSync(f.targetAgent), ['keep']);
  assert.equal(fs.readFileSync(path.join(f.targetAgent, 'keep'), 'utf8'), 'unmanaged');
});

test('changed valid intent under the lock is refused before journal or target', t => {
  const f = fixture(t);
  const token = f.ready();
  fs.writeFileSync(path.join(f.source, 'settings.json'),
    JSON.stringify({ theme: 'light', defaultModel: model }));
  const alternate = path.join(f.root, 'alternate');
  f.captureTo(alternate);
  const alternatePlan = plan({ ...f.opts, bundle: alternate });
  assert.equal(alternatePlan.status, 'ready');
  assert.notEqual(alternatePlan.approvalToken, token);
  let swapped = false;
  expectError(() => restoreFromPlan({
    ...f.opts, stateDir: f.stateDir, approveActivation: token,
    deps: {
      ...f.deps,
      fault(point) {
        if (point !== 'lock-dirsync' || swapped) return;
        assert.ok(fs.existsSync(path.join(f.stateDir, 'lock.json')));
        assert.equal(fs.existsSync(path.join(f.stateDir, 'journal.json')), false);
        assert.equal(fs.existsSync(f.targetAgent), false);
        fs.renameSync(f.bundle, path.join(f.root, 'original'));
        fs.renameSync(alternate, f.bundle);
        swapped = true;
      },
    },
  }), 'activation-approval-mismatch', 1);
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(f.targetAgent), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'journal.json')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'lock.json')), false);
  assert.deepEqual(fs.readdirSync(f.stateDir), []);
});
