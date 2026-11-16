/** Shared preview compilation and activation revalidation under the state lock. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { capture, captureReview } from '../src/capture.ts';
import { ToolError } from '../src/errors.ts';
import { plan, preparePlan, type PlanOptions } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import type { Platform } from '../src/schema.ts';
import { applyRestore, type TxOptions } from '../src/transaction.ts';

const roots: string[] = [];
const platform = process.platform as Platform;
const selected = 'SELECTED-PRIVATE-MODEL';
const payload = 'PRIVATE-PAYLOAD {{AGENT_DIR}}\n';
const zero = `sha256:${'0'.repeat(64)}`;
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function fixture(unsupported = false) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-restore-service-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ theme: 'dark', defaultModel: selected }));
  fs.writeFileSync(path.join(source, 'AGENTS.md'), payload);
  const files: object[] = [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: true }];
  if (unsupported) {
    fs.mkdirSync(path.join(source, 'themes'));
    fs.writeFileSync(path.join(source, 'themes/custom.json'), '{}');
    files.push({ root: 'agent', path: 'themes/custom.json', class: 'theme', template: false });
  }
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: {
    common: { settings: ['theme', 'defaultModel'], files },
  } }));
  const env = {};
  const guard = { home };
  const bundle = path.join(root, 'bundle');
  const input = { policy, sourceAgent: source, platform, env, guard };
  const makeBundle = (out: string) => {
    const review = captureReview(input);
    capture({ ...input, out, approveInclusion: review.captureReviewToken });
  };
  makeBundle(bundle);
  const options: PlanOptions = { bundle, platform, targetAgent: path.join(root, 'target'), env, guard };
  const deps: TxOptions['deps'] = {
    platform, bootId: () => '11111111-2222-4333-8444-555555555555', hostname: () => 'fixture-host',
    uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive',
  };
  return { root, source, bundle, makeBundle, options, deps, stateDir: path.join(root, 'state') };
}
function error(fn: () => unknown, code: string, exit: number) {
  assert.throws(fn, (e: unknown) => e instanceof ToolError && e.code === code && e.exit === exit);
}

test('public plan omits private compiler data while sharing its exact preview and token', () => {
  const f = fixture();
  const prepared = preparePlan(f.options);
  const preview = plan(f.options);
  assert.deepEqual(preview, prepared.result);
  assert.deepEqual(Object.keys(preview).sort(), ['approvalToken', 'items', 'overlay', 'platform', 'status']);
  const printed = JSON.stringify(preview);
  assert.ok(!printed.includes(selected) && !printed.includes('PRIVATE-PAYLOAD') && !printed.includes('bytes'));
  assert.equal(prepared.settings.defaultModel, selected);
  assert.equal(Buffer.from(prepared.files[0].bytes).toString(), payload.replace('{{AGENT_DIR}}', prepared.targets.agent));
  assert.equal(prepared.files[0].sha256, crypto.createHash('sha256').update(prepared.files[0].bytes).digest('hex'));
});

test('restore reads the compiled intent while the state lock is held and before target/journal creation', () => {
  const f = fixture();
  const token = plan(f.options).approvalToken!;
  const open = fs.openSync;
  let lockedReads = 0;
  const patch = mock.method(fs, 'openSync', (p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (p === path.join(f.bundle, 'config/common/manifest.json') && fs.existsSync(path.join(f.stateDir, 'lock.json'))) {
      lockedReads++;
      assert.equal(fs.existsSync(f.options.targetAgent), false);
      assert.equal(fs.existsSync(path.join(f.stateDir, 'journal.json')), false);
    }
    return open(p, flags, mode);
  });
  try {
    const result = restoreFromPlan({ ...f.options, stateDir: f.stateDir, approveActivation: token, deps: f.deps });
    assert.equal(result.status, 'applied');
  } finally { patch.mock.restore(); }
  assert.ok(lockedReads > 0, 'no fresh bundle verification under the writer lock');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.targetAgent, 'settings.json'), 'utf8')).defaultModel, selected);
});

for (const [label, approval, code, exit] of [
  ['missing', undefined, 'activation-approval-required', 2],
  ['malformed', 'bad', 'approval-token-invalid', 2],
  ['mismatched', zero, 'activation-approval-mismatch', 1],
] as const) {
  test(`${label} activation consent creates neither state nor target`, () => {
    const f = fixture();
    error(() => restoreFromPlan({ ...f.options, stateDir: f.stateDir, approveActivation: approval, deps: f.deps }), code, exit);
    assert.equal(fs.existsSync(f.stateDir), false);
    assert.equal(fs.existsSync(f.options.targetAgent), false);
  });
}

test('incomplete plans cannot create a packet or target even with a well-formed token', () => {
  const f = fixture(true);
  assert.equal(plan(f.options).status, 'incomplete');
  error(() => restoreFromPlan({ ...f.options, stateDir: f.stateDir, approveActivation: zero, deps: f.deps }), 'plan-not-ready', 1);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.existsSync(f.options.targetAgent), false);
});

test('a valid changed bundle after lock acquisition invalidates consent before target writes', () => {
  const f = fixture();
  const token = plan(f.options).approvalToken!;
  fs.writeFileSync(path.join(f.source, 'settings.json'), JSON.stringify({ theme: 'light', defaultModel: selected }));
  const alternate = path.join(f.root, 'alternate');
  f.makeBundle(alternate);
  let swapped = false;
  error(() => restoreFromPlan({ ...f.options, stateDir: f.stateDir, approveActivation: token, deps: {
    ...f.deps,
    fault(point) {
      if (point === 'lock-dirsync' && !swapped) {
        assert.ok(fs.existsSync(path.join(f.stateDir, 'lock.json')));
        fs.renameSync(f.bundle, path.join(f.root, 'old-bundle'));
        fs.renameSync(alternate, f.bundle);
        swapped = true;
      }
    },
  } }), 'activation-approval-mismatch', 1);
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(f.options.targetAgent), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'journal.json')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'lock.json')), false);
  assert.deepEqual(fs.readdirSync(f.stateDir), []);
});

for (const mode of ['mismatch', 'throw'] as const) {
  test(`engine locked verifier ${mode} never commits journal or target`, () => {
    const f = fixture();
    const prepared = preparePlan(f.options);
    let called = false;
    error(() => applyRestore({
      planToken: prepared.result.approvalToken!, platform,
      state: f.stateDir, agentTarget: prepared.targets.agent, lensTarget: prepared.targets.lensConfig,
      settings: prepared.settings, packages: prepared.packages, files: prepared.files, protectedRoots: prepared.protectedRoots,
    }, {
      env: f.options.env, guard: f.options.guard, deps: f.deps,
      verifyLockedIntent: () => {
        called = true;
        assert.ok(fs.existsSync(path.join(f.stateDir, 'lock.json')));
        assert.equal(fs.existsSync(path.join(f.stateDir, 'journal.json')), false);
        if (mode === 'throw') throw new Error('synthetic verifier error');
        return zero;
      },
    }), mode === 'throw' ? 'apply-failed' : 'activation-approval-mismatch', 1);
    assert.equal(called, true);
    assert.equal(fs.existsSync(f.options.targetAgent), false);
    assert.deepEqual(fs.readdirSync(f.stateDir), []);
  });
}

test('an offline preview for another platform cannot activate', () => {
  const f = fixture();
  const other = platform === 'darwin' ? 'linux' : 'darwin';
  error(() => restoreFromPlan({ ...f.options, platform: other, stateDir: f.stateDir, approveActivation: zero, deps: f.deps }), 'platform-mismatch', 2);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.existsSync(f.options.targetAgent), false);
});
