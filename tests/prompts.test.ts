/** Exact prompt references, not a YAML parser or a complete discovery adapter. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promptReferencesReady } from '../src/prompts.ts';
import type { MergedFile } from '../src/bundle.ts';
import { capture, captureReview } from '../src/capture.ts';
import { plan } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import { rollbackRestore, type TxOptions } from '../src/transaction.ts';
import { ToolError } from '../src/errors.ts';
import { sha256Hex, type Platform } from '../src/schema.ts';

function file(name = 'review', body = 'Review $1 and $@.\n'): MergedFile {
  const bytes = Buffer.from(body);
  return { bytes, record: { root: 'agent', path: `prompts/${name}.md`, class: 'prompt', template: false,
    bytes: bytes.length, sha256: sha256Hex(bytes) } };
}

test('exact paths, force-includes and duplicate declarations resolve the same approved prompt', () => {
  const files = [file()];
  for (const entries of [['prompts/review.md'], ['+prompts/review.md'], ['prompts/review.md', '+prompts/review.md']]) {
    assert.equal(promptReferencesReady(entries, files, false), true);
  }
  assert.equal(promptReferencesReady([], files, false), false);
  assert.equal(promptReferencesReady(['prompts/review.md'], files, true), false);
});

test('unknown discovery grammar and unapproved paths stay unsupported', () => {
  for (const entry of ['prompts', 'prompts/*.md', './prompts/review.md', 'prompts/sub/review.md', 'prompts/Review.md',
    'prompts/missing.md', '-prompts/review.md', '!prompts/review.md', '++prompts/review.md']) {
    assert.equal(promptReferencesReady(['prompts/review.md', entry], [file()], false), false, entry);
  }
  for (const name of ['.hidden', 'two words', '\u00e9']) {
    assert.equal(promptReferencesReady(['prompts/review.md'], [file(), file(name)], false), false, name);
  }
  assert.equal(promptReferencesReady(['prompts/review.md'], [], false), false);
});

test('native closed-frontmatter boundaries refuse, including unsupported automatic siblings', () => {
  for (const body of ['---\n---', '---\r\n---', '---\r---', '\ufeff---\n---', '---title\n---',
    '---\ndescription: review\n---\nBody', '\ufeff\ufeffReview']) {
    assert.equal(promptReferencesReady(['prompts/review.md'], [file('review', body)], false), false, JSON.stringify(body));
    assert.equal(promptReferencesReady(['prompts/review.md'], [file(), file('other', body)], false), false);
  }
  for (const body of ['--- unclosed', 'Body\n---\nmore', '\ufeffReview\r\n$1 $@\r']) {
    assert.equal(promptReferencesReady(['prompts/review.md'], [file('review', body)], false), true);
  }
});

function fixture(t: TestContext, prompts: string[] | undefined, body = '\ufeffReview $1 and $@.\r\n') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-prompt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(path.join(source, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'prompts/review.md'), body);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify(prompts === undefined ? {} : { prompts }));
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: {
    settings: prompts === undefined ? [] : ['prompts'],
    files: [{ root: 'agent', path: 'prompts/review.md', class: 'prompt', template: false }],
  } } }));
  const platform = process.platform as Platform; const env = {}; const guard = { home };
  const bundle = path.join(root, 'bundle'); const input = { policy, sourceAgent: source, platform, env, guard };
  capture({ ...input, out: bundle, approveInclusion: captureReview(input).captureReviewToken });
  const opts = { bundle, platform, targetAgent: path.join(root, 'target'), env, guard };
  const deps: TxOptions['deps'] = { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'fixture', uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive' };
  return { root, source, opts, deps, body, stateDir: path.join(root, 'state') };
}

test('approved exact prompt references apply unchanged bytes and roll back once', t => {
  const f = fixture(t, ['prompts/review.md', '+prompts/review.md']); const preview = plan(f.opts);
  assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
  assert.deepEqual(preview.items.find((item) => item.kind === 'setting'), { kind: 'setting', key: 'prompts', operation: 'activation-required' });
  const applied = restoreFromPlan({ ...f.opts, stateDir: f.stateDir, deps: f.deps, approveActivation: preview.approvalToken });
  const target = path.join(f.opts.targetAgent, 'prompts/review.md');
  assert.deepEqual(fs.readFileSync(target), Buffer.from(f.body));
  const undone = rollbackRestore(f.stateDir, applied.tx, { env: {}, guard: f.opts.guard, deps: f.deps,
    expectedTargets: { agent: f.opts.targetAgent, lens: null } });
  assert.equal(undone.removed, 2); assert.equal(fs.existsSync(target), false);
});

test('incomplete references cannot activate and do not create output', t => {
  const f = fixture(t, ['prompts/missing.md']); const preview = plan(f.opts);
  assert.equal(preview.status, 'incomplete'); assert.equal(preview.approvalToken, null);
  assert.throws(() => restoreFromPlan({ ...f.opts, stateDir: f.stateDir, deps: f.deps, approveActivation: `sha256:${'0'.repeat(64)}` }),
    (e: unknown) => e instanceof ToolError && e.code === 'plan-not-ready');
  assert.equal(fs.existsSync(f.stateDir), false); assert.equal(fs.existsSync(f.opts.targetAgent), false);
});

test('file-only and negative-only classifications are not changed by this reference subset', t => {
  for (const entries of [undefined, [], ['-prompts/review.md'], ['!prompts/*.md']]) {
    const f = fixture(t, entries, '---\ndescription: existing file-only behavior\n---\nBody');
    assert.equal(plan(f.opts).status, 'ready');
  }
});
