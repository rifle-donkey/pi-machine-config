/** Pi 1.5.2 theme schema and first-restore integration against owned fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { themeReady } from '../src/theme.ts';
import { capture, captureReview } from '../src/capture.ts';
import { plan } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import { rollbackRestore, type TxOptions } from '../src/transaction.ts';
import { ToolError } from '../src/errors.ts';
import type { Platform } from '../src/schema.ts';

// Independently transcribed required tokens from the vendor's 1.5.2 JSON schema.
const required = ('accent border borderAccent borderMuted success error warning muted dim text thinkingText selectedBg ' +
  'userMessageBg userMessageText customMessageBg customMessageText customMessageLabel toolPendingBg toolSuccessBg ' +
  'toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder ' +
  'mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable ' +
  'syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow ' +
  'thinkingMedium thinkingHigh thinkingXhigh bashMode').split(' ');
const optional = ['scrollbarTrack', 'scrollbarThumb', 'searchMatchBg', 'searchMatchText', 'thinkingMax'];
function document() { return { name: 'mine', colors: Object.fromEntries(required.map((k) => [k, '#12AB34'])) } as Record<string, unknown>; }
function ready(value: unknown, name = 'mine') { return themeReady(Buffer.from(JSON.stringify(value)), name); }
function withColor(value: unknown) { const d = document(); (d.colors as Record<string, unknown>).accent = value; return d; }

test('complete themes accept native color forms and optional schema metadata', () => {
  assert.equal(required.length, 51);
  for (const value of ['', '#abc', '#AABBCC', 0, 255, 'OKLCH(50% 0.1 120DEG)', 'oklch(.5 0 -30)',
    'okhsl(120deg 50% 50%)', 'okhsl(1e2 .5 .5)', 'okhsl(0 0 0)', 'okhsl(0 1 1)']) assert.equal(ready(withColor(value)), true, String(value));
  const d = document(); d.$schema = 'https://example.invalid/theme.schema.json'; d.appearance = 'light';
  d.vars = { first: 'second', second: '#abc' }; d.export = { pageBg: 'first', cardBg: 0, infoBg: '' };
  assert.equal(ready(d), true);
});

test('every required token is required and all optional fallback tokens may be omitted', () => {
  for (const key of required) { const d = document(); delete (d.colors as Record<string, unknown>)[key]; assert.equal(ready(d), false, key); }
  assert.equal(ready(document()), true);
  for (const key of optional) { const d = document(); (d.colors as Record<string, unknown>)[key] = 'missing'; assert.equal(ready(d), false, key); }
  const d = document(); for (const key of optional) (d.colors as Record<string, unknown>)[key] = '#fff';
  assert.equal(ready(d), true);
});

test('closed schema and invalid or extreme color forms cannot become ready', () => {
  for (const value of [true, null, [], {}, -1, 256, 1.5, '#abcd', '#GGG', '#fff;}', 'red',
    'oklch(101% 0 0)', 'oklch(.5 -.1 0)', 'oklch(.5 .1 1e400)', 'okhsl(0 101% 50%)',
    'okhsl(0, .5, .5)', 'okhsl(0 .5 1e-250)', 'okhsl(1000001 .5 .5)', 'oklch(.5 1000001 0)']) {
    assert.equal(ready(withColor(value)), false, JSON.stringify(value));
  }
  for (const value of [null, [], {}, { name: 'mine', colors: [] }, { ...document(), extra: 1 },
    { ...document(), appearance: 'auto' }, { ...document(), vars: null }, { ...document(), export: [] }]) assert.equal(ready(value), false);
  const unknown = document(); (unknown.colors as Record<string, unknown>).extra = '#fff'; assert.equal(ready(unknown), false);
  assert.equal(ready({ ...document(), export: { extra: '#fff' } }), false);
});

test('own variable references, unused cycles and export injection are checked', () => {
  assert.equal(ready(withColor('toString')), false);
  assert.equal(ready({ ...withColor('toString'), vars: { toString: '#fff' } }), true);
  for (const vars of [{ a: 'a' }, { a: 'b', b: 'a' }, { a: 'missing' }, { unused: '#fff;}</style>' }]) {
    assert.equal(ready({ ...document(), vars }), false);
  }
  for (const pageBg of ['#fff;}', 'bad']) assert.equal(ready({ ...document(), vars: { bad: '#fff;}' }, export: { pageBg } }), false);
});

test('variable chains, entry counts and strings enforce exact bounds', () => {
  for (const count of [32, 33]) {
    const vars = Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, i + 1 === count ? '#fff' : `v${i + 1}`]));
    assert.equal(ready({ ...withColor('v0'), vars }), count === 32);
  }
  for (const count of [4096, 4097]) {
    const vars = Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, '#fff']));
    assert.equal(ready({ ...document(), vars }), count === 4096);
    assert.equal(ready({ ...document(), $schema: 'x'.repeat(count) }), count === 4096);
    assert.equal(ready({ ...document(), vars: { ['v'.repeat(count)]: '#fff' } }), count === 4096);
  }
});

test('names must match the file stem and never claim reserved built-ins', () => {
  for (const name of ['system', 'dark', 'light', ' mine', 'mine ', '', 'a/b']) assert.equal(ready({ ...document(), name }, name), false);
  assert.equal(ready(document(), 'different'), false);
  assert.equal(ready({ ...document(), name: 'cafe\u0301' }, 'caf\u00e9'), false);
});

test('strict JSON failures retain their existing fixed error codes', () => {
  for (const [body, code] of [['{"x":1,"x":2}', 'json-duplicate-key'], ['{"__proto__":{}}', 'json-unsafe-key'], ['\ufeff{}', 'json-bom']]) {
    assert.throws(() => themeReady(Buffer.from(body), 'mine'), (e: unknown) => e instanceof ToolError && e.code === code);
  }
});

function fixture(t: TestContext, value: unknown = document(), theme = 'light/mine', packages: unknown[] = [], themes?: string[]) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-theme-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'themes'));
  fs.writeFileSync(path.join(source, 'themes/mine.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ theme, packages, ...(themes === undefined ? {} : { themes }) }));
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: {
    common: { settings: ['theme', ...(themes === undefined ? [] : ['themes'])], packages,
      files: [{ root: 'agent', path: 'themes/mine.json', class: 'theme', template: false }] },
  } }));
  const platform = process.platform as Platform; const env = {}; const guard = { home };
  const bundle = path.join(root, 'bundle'); const targetAgent = path.join(root, 'target'); const stateDir = path.join(root, 'state');
  const input = { policy, sourceAgent: source, platform, env, guard };
  capture({ ...input, out: bundle, approveInclusion: captureReview(input).captureReviewToken });
  const options = { bundle, targetAgent, platform, env, guard };
  const deps: TxOptions['deps'] = { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'fixture-host', uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive' };
  return { root, source, options, stateDir, deps };
}

test('validated local themes plan, apply exact bytes and roll back without starting Pi', t => {
  const f = fixture(t); const preview = plan(f.options);
  assert.equal(preview.status, 'ready'); assert.match(preview.approvalToken!, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(preview).includes('#12AB34'));
  const result = restoreFromPlan({ ...f.options, stateDir: f.stateDir, approveActivation: preview.approvalToken!, deps: f.deps });
  const file = path.join(f.options.targetAgent, 'themes/mine.json');
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(f.source, 'themes/mine.json')));
  const undone = rollbackRestore(f.stateDir, result.tx, { env: {}, guard: f.options.guard, deps: f.deps,
    expectedTargets: { agent: f.options.targetAgent, lens: null } });
  assert.equal(undone.removed, 2); assert.equal(fs.existsSync(file), false);
});

test('missing references and ambiguous package or selection discovery remain incomplete', t => {
  for (const args of [
    [document(), 'mine/missing', [], undefined], [document(), 'mine', ['npm:fixture'], undefined],
    [document(), 'mine', [{ source: 'npm:fixture', autoload: false, themes: [] }], undefined],
    [document(), 'mine', [], ['-themes/mine.json']], [null, 'mine', [], undefined],
  ] as [unknown, string, unknown[], string[] | undefined][]) {
    const f = fixture(t, ...args); const preview = plan(f.options);
    assert.equal(preview.status, 'incomplete'); assert.equal(preview.approvalToken, null);
    assert.throws(() => restoreFromPlan({ ...f.options, stateDir: f.stateDir, approveActivation: `sha256:${'0'.repeat(64)}`, deps: f.deps }),
      (e: unknown) => e instanceof ToolError && e.code === 'plan-not-ready');
    assert.equal(fs.existsSync(f.stateDir), false); assert.equal(fs.existsSync(f.options.targetAgent), false);
  }
  assert.equal(plan(fixture(t, document(), 'mine', [], []).options).status, 'ready');
});
