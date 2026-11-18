import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, captureReview } from '../src/capture.ts';
import { plan, type PlanOptions, type PlanResult } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import { rollbackRestore, type TxOptions } from '../src/transaction.ts';
import type { Platform } from '../src/schema.ts';
import { themeReady } from '../src/theme.ts';
import { ToolError } from '../src/errors.ts';

// Pi 1.5.2 theme-tokens.js: entries without a fallback.
const required = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error',
  'warning', 'muted', 'dim', 'text', 'thinkingText', 'selectedBg',
  'userMessageBg', 'userMessageText', 'customMessageBg', 'customMessageText',
  'customMessageLabel', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg',
  'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode',
  'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr',
  'mdListBullet', 'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext',
  'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
  'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator',
  'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal', 'thinkingLow',
  'thinkingMedium', 'thinkingHigh', 'thinkingXhigh', 'bashMode',
];
const optional = [
  'scrollbarTrack', 'scrollbarThumb', 'searchMatchBg', 'searchMatchText',
  'thinkingMax',
];
type Doc = {
  name: string;
  colors: Record<string, unknown>;
  vars?: Record<string, unknown>;
  export?: Record<string, unknown>;
};
function valid(): Doc {
  return { name: 'custom', colors: Object.fromEntries(required.map((key) => [key, ''])) };
}
function ready(doc: unknown, name = 'custom'): boolean {
  return themeReady(Buffer.from(JSON.stringify(doc)), name);
}

test('native required tokens and optional fallback omissions', () => {
  assert.equal(required.length, 51);
  assert.equal(optional.length, 5);
  assert.equal(ready(valid()), true);
  for (const key of required) {
    const doc = valid(); delete doc.colors[key];
    assert.equal(ready(doc), false, `missing ${key}`);
  }
  const full = valid();
  for (const key of optional) full.colors[key] = '#abc';
  assert.equal(ready(full), true);
  full.colors.unrecognized = '';
  assert.equal(ready(full), false);
});

test('native color syntax and conservative numeric boundaries', () => {
  const examples: Array<[unknown, boolean]> = [
    ['', true], ['#ABC', true], ['#aBc123', true], ['#12', false],
    [0, true], [255, true], [-1, false], [256, false], [1.5, false],
    ['oklch(50% 1e0 -360deg)', true], ['OKLCH(1 1000000 1000000)', true],
    ['oklch(1.01 0 0)', false], ['oklch(0 -1 0)', false],
    ['oklch(0 1000001 0)', false], ['oklch(0 0 1000001)', false],
    ['oklch(0 0 1e999)', false], ['oklch(0, 0, 0)', false],
    ['okhsl(-360deg 50% 50%)', true], ['okhsl(0 0 0)', true], ['okhsl(0 1 1)', true],
    ['okhsl(0 1 .000001)', true], ['okhsl(0 1 .999999)', true],
    ['okhsl(0 1 .0000001)', false], ['okhsl(0 1 .9999999)', false],
    ['okhsl(1000001 0 .5)', false], ['okhsl(0 101% .5)', false],
  ];
  for (const [value, expected] of examples) {
    const doc = valid(); doc.colors.accent = value;
    assert.equal(ready(doc), expected, String(value));
  }
});

test('references require own variables and validate unused and export values', () => {
  const doc = valid(); doc.colors.accent = 'toString';
  assert.equal(ready(doc), false);
  doc.vars = { toString: '#123', unused: 255 }; doc.export = { pageBg: 'toString' };
  assert.equal(ready(doc), true);
  doc.export.cardBg = 'missing'; assert.equal(ready(doc), false);
  doc.export.cardBg = '#fff'; doc.vars.unused = 'missing'; assert.equal(ready(doc), false);
  doc.vars.unused = 'unused'; assert.equal(ready(doc), false);
  doc.vars.unused = '#fff'; doc.export.infoBg = 'unused'; assert.equal(ready(doc), true);
  doc.export.infoBg = 'missing'; assert.equal(ready(doc), false);
});

test('reference chains allow 32 distinct names but not 33 or cycles', () => {
  function chain(count: number): Doc {
    const doc = valid(); const vars: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) vars[`v${i}`] = i + 1 === count ? '#fff' : `v${i + 1}`;
    doc.vars = vars; doc.colors.accent = 'v0'; return doc;
  }
  assert.equal(ready(chain(32)), true);
  assert.equal(ready(chain(33)), false);
  const cycle = chain(3); cycle.vars!.v2 = 'v0'; assert.equal(ready(cycle), false);
});

test('variable and string limits include their exact boundary', () => {
  const vars = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`v${i}`, '']));
  const doc = valid(); doc.vars = vars;
  assert.equal(ready(doc), true);
  vars.extra = ''; assert.equal(ready(doc), false);
  const byLength = valid(); const longName = 'x'.repeat(4096);
  byLength.vars = { [longName]: '#fff' }; byLength.colors.accent = longName;
  assert.equal(ready(byLength), true);
  const tooLong = 'x'.repeat(4097);
  byLength.vars = { [tooLong]: '#fff' }; byLength.colors.accent = tooLong;
  assert.equal(ready(byLength), false);
});

test('custom names match the file stem and cannot shadow built-ins', () => {
  const doc = valid(); assert.equal(ready(doc), true); assert.equal(ready(doc, 'other'), false);
  for (const name of ['', ' custom', 'custom ', 'a/b', 'system', 'dark', 'light']) {
    doc.name = name; assert.equal(ready(doc, name), false, name);
  }
});

test('strict JSON failures retain fixed codes', () => {
  for (const [input, code] of [
    ['{', 'json-syntax'], ['{"name":"a","name":"b"}', 'json-duplicate-key'],
    ['{"vars":{"__proto__":"#fff"}}', 'json-unsafe-key'], ['{"vars":{"constructor":"#fff"}}', 'json-unsafe-key'],
  ]) assert.throws(() => themeReady(Buffer.from(input), 'custom'),
    (error: unknown) => error instanceof ToolError && error.code === code, code);
});

const wrongToken = `sha256:${'0'.repeat(64)}`;
function themeFixture(t: TestContext, settings: Record<string, unknown> = {}, themeDoc: unknown = valid()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-theme-qa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(path.join(source, 'themes'), { recursive: true });
  const themeBytes = Buffer.from(JSON.stringify(themeDoc, null, 2) + '\n');
  fs.writeFileSync(path.join(source, 'themes/custom.json'), themeBytes);
  const sourceSettings: Record<string, unknown> = { theme: 'custom', ...settings };
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify(sourceSettings));
  const packages = sourceSettings.packages ?? [];
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: {
    common: { settings: Object.keys(sourceSettings).filter((key) => key !== 'packages'), packages,
      files: [{ root: 'agent', path: 'themes/custom.json', class: 'theme', template: false }] },
  } }));
  const platform = process.platform as Platform; const env = {}; const guard = { home };
  const bundle = path.join(root, 'bundle');
  const input = { policy, sourceAgent: source, platform, env, guard };
  const review = captureReview(input);
  capture({ ...input, out: bundle, approveInclusion: review.captureReviewToken });
  const options: PlanOptions = { bundle, platform, targetAgent: path.join(root, 'target'), env, guard };
  const deps: TxOptions['deps'] = { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'fixture-host', uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive' };
  return { root, source, themeBytes, options, deps, stateDir: path.join(root, 'state') };
}
function expectThemeReason(preview: PlanResult, kind: 'file' | 'setting', reason: string): void {
  assert.ok(preview.items.some((item) => item.kind === kind &&
    (item.kind === 'file' ? item.path === 'themes/custom.json' : item.key === 'theme') &&
    item.operation === 'incomplete' && item.reason === reason), `${kind}: ${reason}`);
}
function expectRestoreError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ToolError && error.code === code && error.exit === 1);
}

test('approved custom themes apply and roll back without exposing color values', (t) => {
  for (const theme of ['custom', 'light/custom']) {
    const doc = valid(); doc.colors.accent = '#a1b2c3';
    const f = themeFixture(t, { theme }, doc); const preview = plan(f.options);
    assert.equal(preview.status, 'ready'); assert.ok(preview.approvalToken);
    assert.ok(!JSON.stringify(preview).includes('#a1b2c3'));
    assert.notEqual(preview.approvalToken, wrongToken);
    const restore = { ...f.options, stateDir: f.stateDir, deps: f.deps };
    expectRestoreError(() => restoreFromPlan({ ...restore, approveActivation: wrongToken }), 'activation-approval-mismatch');
    assert.equal(fs.existsSync(f.stateDir), false); assert.equal(fs.existsSync(f.options.targetAgent), false);
    const applied = restoreFromPlan({ ...restore, approveActivation: preview.approvalToken });
    assert.equal(applied.status, 'applied');
    const targetTheme = path.join(f.options.targetAgent, 'themes/custom.json');
    const targetSettings = path.join(f.options.targetAgent, 'settings.json');
    assert.deepEqual(fs.readFileSync(targetTheme), f.themeBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'themes/custom.json')), f.themeBytes);
    assert.equal(JSON.parse(fs.readFileSync(targetSettings, 'utf8')).theme, theme);
    const undone = rollbackRestore(f.stateDir, applied.tx, { env: {}, guard: f.options.guard, deps: f.deps,
      expectedTargets: { agent: f.options.targetAgent, lens: null } });
    assert.equal(undone.removed, 2);
    assert.equal(fs.existsSync(targetTheme), false); assert.equal(fs.existsSync(targetSettings), false);
  }
});

test('semantically invalid theme captures but cannot activate', (t) => {
  const f = themeFixture(t, {}, {}); const preview = plan(f.options);
  assert.equal(preview.status, 'incomplete'); assert.equal(preview.approvalToken, null);
  expectThemeReason(preview, 'file', 'theme-invalid');
  expectThemeReason(preview, 'setting', 'theme-reference-unverified');
  expectRestoreError(() => restoreFromPlan({ ...f.options, stateDir: f.stateDir, deps: f.deps, approveActivation: wrongToken }), 'plan-not-ready');
  assert.equal(fs.existsSync(f.stateDir), false); assert.equal(fs.existsSync(f.options.targetAgent), false);
});

test('packages and nonempty theme selection prevent verified custom discovery', (t) => {
  for (const declaration of ['npm:fixture-package', { source: 'npm:fixture-package', autoload: false, themes: [] }]) {
    const f = themeFixture(t, { packages: [declaration] }); const preview = plan(f.options);
    assert.equal(preview.status, 'incomplete'); assert.equal(preview.approvalToken, null);
    expectThemeReason(preview, 'file', 'package-theme-discovery-unverified');
    expectThemeReason(preview, 'setting', 'theme-reference-unverified');
    assert.equal(fs.existsSync(f.stateDir), false); assert.equal(fs.existsSync(f.options.targetAgent), false);
  }
  const excluded = themeFixture(t, { themes: ['-themes/custom.json'] }); const refused = plan(excluded.options);
  assert.equal(refused.status, 'incomplete'); assert.equal(refused.approvalToken, null);
  expectThemeReason(refused, 'setting', 'theme-reference-unverified');
  const empty = themeFixture(t, { themes: [] }); assert.equal(plan(empty.options).status, 'ready');
});
