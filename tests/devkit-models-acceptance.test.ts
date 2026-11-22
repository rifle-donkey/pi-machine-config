/** Independent offline acceptance for the standalone dev-kit 6.0.0 models adapter. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import workerThreads from 'node:worker_threads';

const src = new URL('../src/', import.meta.url);
const adapter = new URL('devkit-models.ts', src);
const strictJson = new URL('json.ts', src);
const marker = 'SYNTHETIC-MODELS-QA-MARKER';
const profiles = ['work', 'private'] as const;
const slots = ['architect', 'developer', 'reviewer', 'qa', 'researcher', 'reviewer-alternate'] as const;
type Profile = typeof profiles[number];
type Slot = typeof slots[number];
type Upgrade = { when: string; model: string; thinking: string };
type Row = { model: string; thinking: string; upgrade?: Upgrade };
type Document = { schemaVersion: number; hostTasksProfile: string;
  profiles: Record<Profile, { providers: string[]; roles: Record<Slot, Row> }> };
type Analyzer = (input: Uint8Array) => unknown;

// Static copy of config/models.json packaged in @rifle-donkey/pi-dev-kit 6.0.0.
// Formatting only is compacted. The test never reads the installation or active config.
const packagedDefaults = String.raw`{
  "schemaVersion": 1,
  "hostTasksProfile": "work",
  "profiles": {
    "work": {
      "providers": ["github-copilot"],
      "roles": {
        "architect": {"model":"github-copilot/claude-opus-5.5","thinking":"medium"},
        "developer": {"model":"github-copilot/claude-sonnet-5.5","thinking":"medium","upgrade":{"when":"Difficult or high-risk implementation","model":"github-copilot/claude-opus-5.5","thinking":"high"}},
        "reviewer": {"model":"github-copilot/gpt-6.1-sol","thinking":"medium","upgrade":{"when":"Reinforced or adversarial review","model":"github-copilot/gpt-6.1-sol","thinking":"high"}},
        "reviewer-alternate": {"model":"github-copilot/claude-opus-5.5","thinking":"medium","upgrade":{"when":"Reinforced or adversarial review","model":"github-copilot/claude-opus-5.5","thinking":"high"}},
        "qa": {"model":"github-copilot/gpt-6.1-terra","thinking":"medium"},
        "researcher": {"model":"github-copilot/claude-sonnet-5.5","thinking":"medium","upgrade":{"when":"Complex investigation","model":"github-copilot/claude-opus-5.5","thinking":"medium"}}
      }
    },
    "private": {
      "providers": ["anthropic","openai-codex"],
      "roles": {
        "architect": {"model":"anthropic/claude-opus-5-5","thinking":"medium"},
        "developer": {"model":"anthropic/claude-sonnet-5-5","thinking":"medium","upgrade":{"when":"Difficult or high-risk implementation","model":"anthropic/claude-opus-5-5","thinking":"high"}},
        "reviewer": {"model":"openai-codex/gpt-6.1-sol","thinking":"medium","upgrade":{"when":"Reinforced or adversarial review","model":"openai-codex/gpt-6.1-sol","thinking":"high"}},
        "reviewer-alternate": {"model":"anthropic/claude-opus-5-5","thinking":"medium","upgrade":{"when":"Reinforced or adversarial review","model":"anthropic/claude-opus-5-5","thinking":"high"}},
        "qa": {"model":"openai-codex/gpt-6.1-terra","thinking":"medium"},
        "researcher": {"model":"anthropic/claude-sonnet-5-5","thinking":"medium","upgrade":{"when":"Complex investigation","model":"anthropic/claude-opus-5-5","thinking":"medium"}}
      }
    }
  }
}`;

const provider = { work: 'A9.work_qa-v1', private: '7.private_qa-v2' } as const;
function fixture(): Document {
  function profile(name: Profile): Document['profiles'][Profile] {
    const row = (model: string, thinking: string): Row => ({ model: `${provider[name]}/${model}`, thinking });
    const up = (when: string, model: string, thinking: string): Upgrade => ({ when, ...row(model, thinking) });
    return { providers: [provider[name]], roles: {
      architect: row(name === 'work' ? 'claude-decoy/09._:-/GeMiNi:qa' : 'gemini-other', 'off'),
      developer: { ...row('claude-dev', 'minimal'), upgrade: up(' complex task ', 'gemini-dev', 'max') },
      reviewer: { ...row(name === 'work' ? 'Gpt' : 'gpt-qa', 'low'), upgrade: up('strict review', 'gpt:next', 'high') },
      qa: row('gemini-qa', 'medium'),
      researcher: row('gpt-research', 'high'),
      'reviewer-alternate': { ...row('Claude', 'xhigh'), upgrade: up('strict review', 'claude-other', 'max') },
    } };
  }
  return { schemaVersion: 1, hostTasksProfile: 'private', profiles: { work: profile('work'), private: profile('private') } };
}

const good = { status: 'recognized' } as const;
const invalid = (reason: 'json' | 'shape' | 'value' | 'rule') => ({ status: 'invalid', reason }) as const;
const unsupported = (reason: 'limit' | 'version' | 'syntax') => ({ status: 'unsupported', reason }) as const;
type Report = typeof good | ReturnType<typeof invalid | typeof unsupported>;
const bytes = (doc: unknown): Buffer => Buffer.from(JSON.stringify(doc));
const raw = (text: string): Buffer => Buffer.from(text);
const version = (text: string, lexeme: string): string => text.replace('"schemaVersion":1', `"schemaVersion":${lexeme}`);
function assertReport(analyze: Analyzer, input: Uint8Array, wanted: Report, label?: string) {
  const before = Uint8Array.from(input);
  const actual = analyze(input);
  assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual), label);
  const keys = Reflect.ownKeys(actual);
  assert.equal(keys.length, Object.keys(wanted).length, label);
  assert.ok(keys.every(key => Object.hasOwn(wanted, key)), label);
  assert.deepEqual({ ...actual }, wanted, label);
  assert.deepEqual(Uint8Array.from(input), before, 'analysis must not rewrite input bytes');
}
async function analyzer(url = adapter.href): Promise<Analyzer> {
  // A missing feature fails each adapter test without stopping the baseline control.
  const { analyzeDevKitModels } = await import(url);
  assert.equal(typeof analyzeDevKitModels, 'function');
  return analyzeDevKitModels;
}
function reverseMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseMembers);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseMembers(v)]));
  }
  return value;
}
function everyProfile(doc: Document, f: (rows: Record<Slot, Row>, name: Profile) => void) {
  for (const name of profiles) f(doc.profiles[name].roles, name);
}

// First, before any adapter imports: observe attempted loads in both the public
// process and the actual opt-in doctor worker, even if a caller catches the denial.
test('baseline: capture, plan, apply and both doctors do not load the adapter', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'pmc-models-qa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  const targetAgent = path.join(root, 'target');
  const stateDir = path.join(root, 'state');
  const policy = path.join(root, 'policy.json');
  const modelsRel = 'dev-kit/models.json';
  const models = path.join(source, modelsRel);
  const extension = 'extensions/fixture.ts';
  const platform = 'darwin' as const;
  const guard = { home };
  const env = {};
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(source, extension)));
  fs.writeFileSync(path.join(source, extension), 'export {};\n');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Synthetic context.\n');
  const rule = (path: string, cls: string, template = false) => ({ root: 'agent', path, class: cls, template });
  const setPolicy = (...files: ReturnType<typeof rule>[]) => fs.writeFileSync(policy, JSON.stringify({
    schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: { files } },
  }));

  const forbidden = String.raw`(?:^|/)devkit-models\.ts(?:[?#]|$)`;
  const denied = new RegExp(forbidden);
  let parentAttempts = 0;
  const counts = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const dataKey = 'pmc-models-acceptance-import-observer';
  const preload = `import { registerHooks } from 'node:module';
    import { getEnvironmentData } from 'node:worker_threads';
    const counts = getEnvironmentData(${JSON.stringify(dataKey)});
    const denied = new RegExp(${JSON.stringify(forbidden)});
    Atomics.add(counts, 0, 1);
    registerHooks({ resolve(specifier, context, next) {
      const check = (name) => {
        if (denied.test(name)) { Atomics.add(counts, 1, 1); throw new Error('test-only adapter'); }
      };
      check(specifier);
      const result = next(specifier, context);
      check(result.url);
      if (result.url.endsWith('/extension-imports.ts')) Atomics.add(counts, 2, 1);
      return result;
    } });`;
  const hook = registerHooks({ resolve(specifier, context, next) {
    const check = (name: string) => {
      if (denied.test(name)) { parentAttempts++; throw new Error('test-only adapter'); }
    };
    check(specifier);
    const result = next(specifier, context);
    check(result.url);
    return result;
  } });
  try {
    const Worker = workerThreads.Worker;
    workerThreads.setEnvironmentData(dataKey, counts);
    t.mock.method(workerThreads, 'Worker', class extends Worker {
      constructor(entry: ConstructorParameters<typeof Worker>[0], opts?: ConstructorParameters<typeof Worker>[1]) {
        super(entry, { ...opts, env: {}, execArgv: [...(opts?.execArgv ?? []), '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`] });
      }
    });
    syncBuiltinESMExports();
    const { runCli } = await import('../src/cli.ts');
    const { parseJsonBytes } = await import('../src/json.ts');
    const { restoreFromPlan } = await import('../src/restore.ts');
    const cli = (args: string[]) => runCli(args, env, guard);
    const from = ['--policy', policy, '--source-agent', source, '--platform', platform];
    const to = (bundle: string) => ['--bundle', bundle, '--target-agent', targetAgent, '--platform', platform];
    const review = () => cli(['capture-review', ...from]);
    const capture = (bundle: string, token: string) => cli(['capture', ...from, '--out', bundle, '--approve-inclusion', token]);
    const refusal = (code: number, error: string) => ({ code, stdout: '', stderr: `${JSON.stringify({ ok: false, error })}\n` });
    const decode = (text: string) => parseJsonBytes(raw(text));
    type Output = Awaited<ReturnType<typeof cli>>;
    function response(output: Output, code: number, want: object) {
      assert.equal(output.code, code);
      assert.equal(output.stderr, '');
      assert.deepEqual(decode(output.stdout), decode(JSON.stringify(want)));
    }
    function token(output: Output, field: 'captureReviewToken' | 'approvalToken'): string {
      assert.equal(output.code, 0);
      assert.equal(output.stderr, '');
      assert.ok(!output.stdout.includes(marker));
      const doc = decode(output.stdout);
      assert.ok(doc && typeof doc === 'object' && !Array.isArray(doc));
      const value = doc[field];
      assert.ok(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
      return value;
    }

    const templated = fixture();
    everyProfile(templated, rows => { rows.developer.upgrade!.when = '{{HOME}}'; });
    const cases = [
      ['recognized', bytes(fixture()), false, true],
      ['out-of-subset', bytes({ schemaVersion: 2, [marker]: marker }), false, false],
      ['templated', bytes(templated), true, false],
    ] as const;
    for (const [name, payload, template, withExtension] of cases) {
      setPolicy(rule(modelsRel, 'tool-config', template), ...(withExtension ? [rule(extension, 'extension-source')] : []));
      fs.writeFileSync(models, String.raw`{"schemaVersion":1,"schema\u0056ersion":1}`);
      assert.deepEqual(await review(), refusal(2, 'json-duplicate-key'));
      fs.writeFileSync(models, payload);
      const bundle = path.join(root, name);
      const reviewed = await review();
      const approved = token(reviewed, 'captureReviewToken');
      assert.deepEqual(await review(), reviewed);
      assert.equal(fs.existsSync(bundle), false);
      fs.appendFileSync(models, ' ');
      assert.notEqual(token(await review(), 'captureReviewToken'), approved);
      assert.deepEqual(await capture(bundle, approved), refusal(1, 'inclusion-approval-mismatch'));
      assert.equal(fs.existsSync(bundle), false);
      fs.writeFileSync(models, payload);
      response(await capture(bundle, approved), 0, { ok: true, command: 'capture', layers: {
        common: { settings: 0, packages: 0, files: withExtension ? 2 : 1 },
        [`platform:${platform}`]: { settings: 0, packages: 0, files: 0 },
      }, skipped: { settings: 0, packages: 0 } });
      const bundled = path.join(bundle, 'config/common/files/agent', modelsRel);
      assert.deepEqual(fs.readFileSync(bundled), payload);
      response(await cli(['plan', ...to(bundle)]), 1, { ok: false, command: 'plan', status: 'incomplete',
        platform, overlay: false, approvalToken: null, items: [
          { kind: 'file', root: 'agent', path: modelsRel, class: 'tool-config', operation: 'incomplete', reason: 'schema-adapter-unavailable' },
          ...(withExtension ? [{ kind: 'file', root: 'agent', path: extension, class: 'extension-source',
            operation: 'incomplete', reason: 'dependency-analysis-unavailable' }] : []),
          { kind: 'target', target: 'agent', operation: 'create' },
        ] });
      assert.deepEqual(await cli(['apply', ...to(bundle), '--state-dir', stateDir, '--approve-activation', `sha256:${'0'.repeat(64)}`]),
        refusal(1, 'plan-not-ready'));
      if (withExtension) response(await cli(['doctor', '--extension-imports', ...to(bundle)]), 0, {
        ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files: [{ path: extension, status: 'analyzed',
          imports: { resolved: 0, missing: 0, 'outside-set': 0, unsupported: 0, 'unsupported-target': 0, external: 0 } }],
      });
      assert.equal(fs.existsSync(targetAgent), false);
      assert.equal(fs.existsSync(stateDir), false);
      assert.deepEqual(fs.readFileSync(bundled), payload);
      assert.deepEqual(fs.readFileSync(models), payload);
    }

    // A separate ready bundle exercises actual locked recompilation and ordinary
    // doctor. All identity inputs are synthetic; a real boot probe is unnecessary.
    setPolicy(rule('AGENTS.md', 'agent-context'));
    const bundle = path.join(root, 'ready');
    assert.equal((await capture(bundle, token(await review(), 'captureReviewToken'))).code, 0);
    const ready = await cli(['plan', ...to(bundle)]);
    const approvalToken = token(ready, 'approvalToken');
    assert.deepEqual(await cli(['plan', ...to(bundle)]), ready);
    const applied = restoreFromPlan({ bundle, targetAgent, stateDir, platform, approveActivation: approvalToken,
      env, guard, deps: { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
        hostname: () => 'fixture-host', pid: () => 4000201, probePid: () => assert.fail('unexpected PID probe') } });
    assert.equal(applied.status, 'applied');
    response(await cli(['doctor', ...to(bundle), '--state-dir', stateDir, '--tx', applied.tx]), 0,
      { ok: true, command: 'doctor', status: 'match' });
    const help = await cli(['help']);
    assert.equal(help.code, 0);
    assert.equal(help.stderr, '');
    assert.doesNotMatch(help.stdout, /devkit-models|dev-kit\/models|analyzeDevKitModels/i);
    for (const cmd of [['devkit-models', ...to(bundle)], ['doctor', '--devkit-models', ...to(bundle)],
      ['plan', '--devkit-models', ...to(bundle)]]) assert.deepEqual(await cli(cmd), refusal(2, 'usage'));
  } finally {
    hook.deregister();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    workerThreads.setEnvironmentData(dataKey, undefined);
  }
  assert.equal(parentAttempts, 0, 'public graph attempted to import standalone adapter');
  assert.equal(Atomics.load(counts, 0), 1, 'doctor worker import observer did not start exactly once');
  assert.equal(Atomics.load(counts, 1), 0, 'doctor worker attempted to import standalone adapter');
  assert.ok(Atomics.load(counts, 2) > 0, 'observer must see the actual extension analyzer');
});

test('input: invalid ToolError for non-byte views; consume just the given Uint8Array', async () => {
  const analyze = await analyzer();
  const { ToolError } = await import('../src/errors.ts');
  for (const value of [undefined, null, false, 1, marker, [123, 125], new Uint16Array(2), new Int8Array(2),
    new Uint8ClampedArray(2), new ArrayBuffer(2), new DataView(new ArrayBuffer(2)),
    { byteLength: Number.MAX_SAFE_INTEGER, length: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => analyze(value as Uint8Array), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.exit, 2);
      assert.equal(error.code, 'devkit-models-input-invalid');
      assert.equal(error.message, 'devkit-models-input-invalid');
      assert.equal(error.layer, undefined);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const backing = Uint8Array.from(Buffer.concat([Buffer.of(0xff), bytes(fixture()), Buffer.of(0xff)]));
  const before = Uint8Array.from(backing);
  assertReport(analyze, backing.subarray(1, -1), good);
  assert.deepEqual(backing, before, 'neither the view nor its surrounding bytes may change');
});

test('recognition: pinned packaged defaults, all slots and thinking levels, synthetic providers', async () => {
  const analyze = await analyzer();
  assertReport(analyze, raw(`${packagedDefaults}\n`), good, 'packaged version 6.0.0 default table');
  const doc = fixture();
  assertReport(analyze, bytes(doc), good, 'mixed-case final path families, unrelated IDs and non-reviewer cross-family upgrade');
  assertReport(analyze, bytes(reverseMembers(doc)), good, 'no canonical object-member order required');
  for (const slot of slots) everyProfile(doc, rows => { delete rows[slot].upgrade; });
  doc.hostTasksProfile = 'work';
  assertReport(analyze, bytes(doc), good, 'neither profile is required to have any upgrades');
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const doc = fixture();
    everyProfile(doc, rows => { rows.qa.thinking = level; rows.reviewer.upgrade!.thinking = level; });
    assertReport(analyze, bytes(doc), good, `default and upgrade both accept ${level}`);
  }
});

test('strict JSON: project ToolErrors map to the same exact report before shape or version', async () => {
  const analyze = await analyzer();
  const sample = bytes(fixture()).toString();
  const cases: Array<[string, string | Buffer]> = [
    ['empty', ''], ['trailing text', `${sample}${marker}`], ['comment', `/* ${marker} */${sample}`],
    ['trailing comma', `${sample.slice(0, -1)},}`], ['BOM', `\ufeff${sample}`],
    ['malformed UTF-8', Buffer.concat([raw(sample.slice(0, -1)), Buffer.from([0xff, 0x7d])])],
    ['duplicate root member', `{"schemaVersion":1,${sample.slice(1)}`],
    ['escaped duplicate root member', String.raw`{"schema\u0056ersion":2,` + sample.slice(1)],
    ['duplicate nested member', sample.replace('"thinking":"off"', '"thinking":"off","thinking":"low"')],
    ['unsafe root key', `{"__proto__":"${marker}"}`], ['unsafe key in an array', '[{"prototype":0}]'],
    ['escaped unsafe nested key', sample.replace('"roles":{', String.raw`"roles":{"constr\u0075ctor":null,`)],
    ['unsafe integer', version(sample, '9007199254740992')], ['nonfinite number', version(sample, '1e999')],
    ['lone surrogate', sample.replace('complex task', String.raw`\ud800`)],
    ['malformed escape', sample.replace('complex task', String.raw`\q`)],
    ['excess nesting', `${'['.repeat(66)}0${']'.repeat(66)}`],
    ...['01', '+1', '1.', '.1', '1e', 'NaN', 'Infinity'].map((n): [string, string] => [`invalid JSON token ${n}`, version(sample, n)]),
  ];
  for (const [label, input] of cases) assertReport(analyze, typeof input === 'string' ? raw(input) : input, invalid('json'), label);
});

test('strict JSON: unexpected parser exceptions propagate by identity', async () => {
  const isolated = new URL(adapter.href);
  isolated.searchParams.set('acceptance', 'parser-exception');
  const shim = `export * from ${JSON.stringify(strictJson.href)};
    export const sentinel = new Error('synthetic unexpected parser error');
    export function parseJsonBytes() { throw sentinel; }`;
  const shimUrl = `data:text/javascript,${encodeURIComponent(shim)}`;
  const { sentinel } = await import(shimUrl);
  let intercepted = 0;
  const hook = registerHooks({ resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (context.parentURL === isolated.href && resolved.url === strictJson.href) {
      intercepted++;
      return next(shimUrl, context);
    }
    return resolved;
  } });
  try {
    const analyze = await analyzer(isolated.href);
    assert.ok(intercepted > 0, 'inject through the actual project parser import');
    assert.throws(() => analyze(bytes(fixture())), (error: unknown) => error === sentinel);
  } finally {
    hook.deregister();
  }
});

test('limits: inclusive file-byte cap precedes parsing and counts only the view', async () => {
  const analyze = await analyzer();
  const { LIMITS } = await import('../src/schema.ts');
  const size = LIMITS.fileBytes;
  const sample = bytes(fixture());
  const backing = Buffer.alloc(size + 3, 0x20);
  sample.copy(backing, 1);
  backing[0] = 0xff;
  backing[size + 2] = 0xff;
  assertReport(analyze, backing.subarray(1, size), good, 'one byte below cap');
  assertReport(analyze, backing.subarray(1, size + 1), good, 'exact file limit');
  assertReport(analyze, backing.subarray(1, size + 2), unsupported('limit'), 'valid document one byte over');
  backing[1] = 0xff;
  assertReport(analyze, backing.subarray(1, size + 1), invalid('json'), 'malformed UTF-8 at limit');
  assertReport(analyze, backing.subarray(1, size + 2), unsupported('limit'), 'oversize wins before UTF-8 decode');
  const multibyte = Buffer.from(sample.toString().replace('complex task', 'é'));
  const spaces = Buffer.alloc(size + 1 - multibyte.length, 0x20);
  assert.equal(multibyte.toString().length + spaces.length, size);
  assertReport(analyze, Buffer.concat([multibyte, spaces]), unsupported('limit'), 'count UTF-8 bytes, not decoded code units');
});

test('version: decoded value before closed shape; lexical integer token after shape', async () => {
  const analyze = await analyzer();
  const sample = bytes(fixture()).toString();
  const { schemaVersion: _removed, ...missing } = fixture();
  assertReport(analyze, bytes(missing), unsupported('version'), 'missing version');
  for (const spelling of ['0', '-0', '-1', '2', '1.5', '0.9999999999999', '1e-999', '"1"', 'true', 'null', '[]', '{}']) {
    assertReport(analyze, raw(version(sample, spelling)), unsupported('version'), `wrong decoded value: ${spelling}`);
  }
  for (const spelling of ['1.0', '1.00', '1e0', '1E+0', '10e-1', '0.1e1',
    '0.99999999999999999', '1.0000000000000001', '100000000000000001e-17']) {
    assert.equal(Number(spelling), 1, 'fixture must decode to 1 in JS');
    assertReport(analyze, raw(version(sample, spelling)), unsupported('version'), `not the exact number token: ${spelling}`);
  }
  assertReport(analyze, raw(sample.replace('"schemaVersion":1', '"schemaVersion"\r\n:\t 1 \n')), good, 'whitespace not part of token');
});

test('version scanner: escaped member names and escaped numeric decoys in strings', async () => {
  const analyze = await analyzer();
  const doc = fixture();
  const trigger = String.raw`1.0 "schemaVersion":2 \ 0.99999999999999999 / [1e0]`;
  everyProfile(doc, rows => { rows.developer.upgrade!.when = trigger; });
  const decorate = (text: string) => text
    .replace('"schemaVersion"', String.raw`"schema\u0056ersion"`)
    .replace('"hostTasksProfile"', String.raw`"hostTasksPro\u0066ile"`)
    .replace('"work"', String.raw`"w\u006frk"`)
    .replace('"reviewer-alternate"', String.raw`"reviewer\u002dalternate"`)
    .replace('"when"', String.raw`"wh\u0065n"`)
    .replace('/Gpt"', String.raw`\/\u0047pt"`)
    .replace(JSON.stringify(trigger), JSON.stringify(trigger).replace('1.0', String.raw`\u0031.0`).replace(' / ', String.raw` \/ `));
  for (const ordered of [doc, reverseMembers(doc)]) {
    const text = JSON.stringify(ordered);
    assertReport(analyze, raw(decorate(text)), good, 'decode quotes, slash, backslash and Unicode escapes before comparisons');
    assertReport(analyze, raw(decorate(version(text, '1.0'))), unsupported('version'), 'string text cannot supply the integer token');
  }
  // A paired backslash directly before a closing quote must not escape the quote.
  everyProfile(doc, rows => { rows.developer.upgrade!.when = 'ends with a backslash \\'; });
  assertReport(analyze, raw(decorate(JSON.stringify(reverseMembers(doc)))), good, 'actual version token after a trailing backslash string');
});

const omit = Symbol('omit member');
function change(root: object, route: readonly string[], value: unknown): void {
  let node = root as Record<string, unknown>;
  for (const key of route.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const key = route.at(-1)!;
  if (value === omit) delete node[key];
  else node[key] = value;
}

test('shape: closed object keys and leaf types at every level', async () => {
  const analyze = await analyzer();
  for (const root of [null, true, 1, marker, [], [fixture()], [{ schemaVersion: 9 }]]) {
    assertReport(analyze, bytes(root), invalid('shape'), 'require object root before version');
  }
  const p = ['profiles'];
  const work = [...p, 'work'];
  const roles = [...work, 'roles'];
  const row = [...roles, 'developer'];
  const up = [...row, 'upgrade'];
  const cases: Array<[string[], unknown]> = [
    [['hostTasksProfile'], omit], [['hostTasksProfile'], 5], [p, omit], [p, []], [p, null],
    [[marker], marker], [[...p, 'third'], {}], [[...p, 'private'], omit], [work, true],
    [[...work, marker], marker], [[...work, 'providers'], omit], [[...work, 'providers'], provider.work],
    [[...work, 'providers'], [provider.work, 1]], [[...work, 'providers'], [false]], [[...work, 'providers'], [[]]],
    [roles, omit], [roles, []], [[...roles, 'alternate-reviewer'], {}], [[...roles, marker], marker],
    ...slots.map((slot): [string[], unknown] => [[...roles, slot], omit]),
    [row, []], [row, null], [[...row, marker], marker], [[...row, 'model'], omit], [[...row, 'model'], 1],
    [[...row, 'thinking'], omit], [[...row, 'thinking'], false],
    [up, null], [up, []], [up, 'automatic'], [[...up, marker], marker],
    [[...up, 'model'], omit], [[...up, 'model'], [marker]], [[...up, 'thinking'], omit], [[...up, 'thinking'], {}],
    [[...up, 'when'], omit], [[...up, 'when'], null],
  ];
  for (const [route, value] of cases) {
    const doc = fixture();
    change(doc, route, value);
    assertReport(analyze, bytes(doc), invalid('shape'), route.join('.'));
  }
});

test('syntax: provider spelling and inclusive provider-prefix bound', async () => {
  const analyze = await analyzer();
  for (const bad of ['', '.alpha', '_alpha', '-alpha', 'a:b', 'a/b', 'a b', ' a', 'a ', 'a\n', 'a\r', 'a\0',
    'a\u007f', 'a\u2028', 'é', '１', 'a*']) {
    const doc = fixture();
    doc.profiles.private.providers.push(bad); // Unused providers still must have valid spelling.
    assertReport(analyze, bytes(doc), unsupported('syntax'), 'invalid provider even when unused');
  }
  for (const n of [63, 64, 65]) {
    const name = 'P'.repeat(n);
    const listed = fixture();
    listed.profiles.private.providers.push(name);
    assertReport(analyze, bytes(listed), n <= 64 ? good : unsupported('syntax'), `listed provider length ${n}`);
    for (const field of ['default', 'upgrade'] as const) {
      const doc = fixture();
      const row = doc.profiles.private.roles.developer;
      const entry = field === 'default' ? row : row.upgrade!;
      entry.model = `${name}/${field === 'default' ? 'claude' : 'gemini'}`;
      if (n <= 64) doc.profiles.private.providers.push(name);
      assertReport(analyze, bytes(doc), n <= 64 ? good : unsupported('syntax'),
        `${field} model provider length ${n}; overlong prefix is syntax even when unlisted`);
    }
  }
});

test('syntax: model segment grammar and inclusive total model length for defaults and upgrades', async () => {
  const analyze = await analyzer();
  const p = provider.private;
  for (const field of ['default', 'upgrade'] as const) {
    const family = field === 'default' ? 'claude' : 'gemini';
    const cases = ['', `${p}`, `/` + family, `${p}/`, `${p}//${family}`, `${p}/${family}/`,
      `${p}/.ns/${family}`, `${p}/_ns/${family}`, `${p}/-ns/${family}`, `${p}/:ns/${family}`,
      `${p}/ns//${family}`, `${p}/ns /${family}`, `${p}/ns\\${family}`, `${p}/ns/${family}[*]`, `${p}/${family}?`,
      `${p}/${family},x`, `${p}/${family}@x`, `${p}/${family}+x`, `${p}/${family}$x`, `${p}/${family} `,
      `${p}/${family}\n`, `${p}/${family}\r`, `${p}/${family}\u2029`, `${p}/${family}\0`, `${p}/${family}é`,
      `${p}:${family}`, `task:${family}`, `https://${p}/${family}`];
    for (const bad of cases) {
      const doc = fixture();
      const row = doc.profiles.private.roles.developer;
      (field === 'default' ? row : row.upgrade!).model = bad;
      assertReport(analyze, bytes(doc), unsupported('syntax'), `${field} model grammar`);
    }
    for (const n of [255, 256, 257]) {
      const doc = fixture();
      const row = doc.profiles.private.roles.developer;
      const prefix = `${p}/9._-:/one/${family}`;
      (field === 'default' ? row : row.upgrade!).model = prefix + 'x'.repeat(n - prefix.length);
      assertReport(analyze, bytes(doc), n <= 256 ? good : unsupported('syntax'), `${field} model total length ${n}`);
    }
  }
});

test('syntax versus value: trigger uses decoded printable ASCII, including space, with an inclusive cap', async () => {
  const analyze = await analyzer();
  const allAscii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 0x20)).join('');
  const cases: [string, Report][] = [
    ['', invalid('value')], [' ', invalid('value')], [' '.repeat(256), invalid('value')],
    [' '.repeat(257), unsupported('syntax')], ['~', good], [' 1 ', good], [allAscii, good],
    ['x'.repeat(255), good], ['x'.repeat(256), good], ['x'.repeat(257), unsupported('syntax')],
    ...['\t', '\n', '\r', '\b', '\f', '\v', '\0', '\u001f', '\u007f', '\u0085', '\u00a0', '\u2028', 'é', '😀']
      .map((ch): [string, Report] => [` x${ch} `, unsupported('syntax')]),
    ['\t   ', unsupported('syntax')],
  ];
  for (const [trigger, report] of cases) {
    const doc = fixture();
    everyProfile(doc, rows => { rows.developer.upgrade!.when = trigger; });
    assertReport(analyze, bytes(doc), report, 'spelling and non-space check are distinct');
  }
  const doc = fixture();
  const repeated = 'W'.repeat(256);
  everyProfile(doc, rows => { rows.developer.upgrade!.when = repeated; });
  const escaped = JSON.stringify(doc).replace(JSON.stringify(repeated), `"${String.raw`\u0057`.repeat(256)}"`);
  assertReport(analyze, raw(escaped), good, 'escaped source can be longer than 256 when decoded trigger is not');
});

test('value: host profile, thinking, provider uniqueness and exact per-profile membership', async () => {
  const analyze = await analyzer();
  for (const value of ['', 'Private', ' work', 'private\n', marker]) {
    const doc = fixture();
    doc.hostTasksProfile = value;
    assertReport(analyze, bytes(doc), invalid('value'), 'host profile matches exactly');
  }
  for (const value of ['', 'HIGH', 'high\n', ' high', 'auto', marker]) {
    for (const field of ['default', 'upgrade'] as const) {
      const doc = fixture();
      everyProfile(doc, rows => {
        (field === 'default' ? rows.reviewer : rows.reviewer.upgrade!).thinking = value;
      });
      assertReport(analyze, bytes(doc), invalid('value'), `invalid ${field} thinking on both sides`);
    }
  }
  for (const p of profiles) {
    for (const names of [[], [provider[p], provider[p]], [provider[p], 'spare', 'spare']]) {
      const doc = fixture();
      doc.profiles[p].providers = names;
      assertReport(analyze, bytes(doc), invalid('value'), 'empty/duplicate provider list');
    }
    const other = p === 'work' ? 'private' : 'work';
    for (const name of [provider[other], provider[p].toUpperCase(), `unknown-${marker}`]) {
      for (const field of ['default', 'upgrade'] as const) {
        const doc = fixture();
        const row = doc.profiles[p].roles.developer;
        (field === 'default' ? row : row.upgrade!).model = `${name}/${field === 'default' ? 'claude' : 'gemini'}`;
        assertReport(analyze, bytes(doc), invalid('value'), `${field} provider belongs to its own profile, case-sensitive`);
      }
    }
  }
  const doc = fixture();
  doc.profiles.work.providers.push('QA-Spare', 'qa-spare');
  doc.profiles.private.providers.push('Qa-Spare');
  assertReport(analyze, bytes(doc), good, 'unused provider names and case-distinct spellings are representable');
  // There is no schema-specific provider count cap apart from file bytes.
  doc.profiles.work.providers.push(...Array.from({ length: 4097 }, (_, i) => `spare_${i}`));
  assertReport(analyze, bytes(doc), good, 'do not import unrelated list-size restrictions');
});

test('rules: disjoint sets, recognized last-segment families, reviewer independence and both upgrade retentions', async () => {
  const analyze = await analyzer();
  const doc = fixture();
  for (const p of profiles) doc.profiles[p].providers.push('unused.shared-provider');
  assertReport(analyze, bytes(doc), invalid('rule'), 'unused intersection still violates separation');
  for (const slot of slots) {
    const doc = fixture();
    everyProfile(doc, (rows, p) => { rows[slot].model = `${provider[p]}/claude/gpt/gemini/other-${marker}`; });
    assertReport(analyze, bytes(doc), invalid('rule'), `unknown final family for ${slot} default`);
  }
  for (const slot of ['developer', 'reviewer', 'reviewer-alternate'] as const) {
    const doc = fixture();
    everyProfile(doc, (rows, p) => { rows[slot].upgrade!.model = `${provider[p]}/gemini/unknown`; });
    assertReport(analyze, bytes(doc), invalid('rule'), `unknown final family for ${slot} upgrade`);
  }
  const colliding = fixture();
  everyProfile(colliding, (rows, p) => {
    rows['reviewer-alternate'].model = `${provider[p]}/gpt-secondary`;
    rows['reviewer-alternate'].upgrade!.model = `${provider[p]}/catalog/GPT:deep`;
  });
  assertReport(analyze, bytes(colliding), invalid('rule'), 'reviewer-family collision without cross-profile or upgrade mismatch');
  for (const slot of ['reviewer', 'reviewer-alternate'] as const) {
    const doc = fixture();
    everyProfile(doc, (rows, p) => { rows[slot].upgrade!.model = `${provider[p]}/catalog/GEMINI-independent`; });
    assertReport(analyze, bytes(doc), invalid('rule'), `recognized upgrade family changes ${slot} in both profiles`);
  }
});

test('rules: every slot mirrors family, thinking and optional upgrade across profiles', async () => {
  const analyze = await analyzer();
  const want = invalid('rule');
  for (const slot of slots) {
    for (const side of profiles) {
      const other = side === 'work' ? 'private' : 'work';
      let doc = fixture();
      const original = doc.profiles[side].roles[slot];
      original.thinking = original.thinking === 'low' ? 'off' : 'low';
      assertReport(analyze, bytes(doc), want, `${side} ${slot} default thinking differs`);
      doc = fixture();
      everyProfile(doc, rows => { delete rows[slot].upgrade; });
      doc.profiles[side].roles[slot].model = `${provider[side]}/${['architect', 'qa'].includes(slot) ? 'gpt' : 'gemini'}-different`;
      assertReport(analyze, bytes(doc), want, `${side} ${slot} default family differs (reviewer pair still distinct)`);

      // If a role doesn't normally have an upgrade, temporarily add a valid
      // mirrored pair; then change just one cross-profile dimension at a time.
      const withPair = () => {
        const doc = fixture();
        everyProfile(doc, rows => { rows[slot].upgrade ??= { when: 'mirrored', model: rows[slot].model, thinking: 'max' }; });
        return doc;
      };
      doc = withPair();
      assertReport(analyze, bytes(doc), good, `${slot} may carry a valid mirrored upgrade`);
      delete doc.profiles[side].roles[slot].upgrade;
      assert.ok(doc.profiles[other].roles[slot].upgrade);
      assertReport(analyze, bytes(doc), want, `${slot} upgrade missing only in ${side}`);
      doc = withPair();
      doc.profiles[side].roles[slot].upgrade!.when += ' ';
      assertReport(analyze, bytes(doc), want, `${side} ${slot} trigger differs by trailing space`);
      doc = withPair();
      doc.profiles[side].roles[slot].upgrade!.thinking = 'off';
      assertReport(analyze, bytes(doc), want, `${side} ${slot} upgrade thinking differs`);
      if (slot !== 'reviewer' && slot !== 'reviewer-alternate') {
        doc = withPair();
        doc.profiles[side].roles[slot].upgrade!.model = `${provider[side]}/claude-different`;
        assertReport(analyze, bytes(doc), want, `${side} ${slot} upgrade family differs (non-reviewer slot)`);
      }
    }
  }
});

test('phase order: earlier phase wins pairwise in forward and reversed member order', async () => {
  const analyze = await analyzer();
  type Fault = { label: string; report: Report; alter?: (doc: Document) => void; token?: string };
  const faults: Fault[] = [
    { label: 'strict JSON', report: invalid('json'), alter: doc =>
      void Object.defineProperty(doc.profiles.work.roles.architect, '__proto__', { value: marker, enumerable: true }) },
    { label: 'decoded version', report: unsupported('version'), token: '2' },
    { label: 'closed shape', report: invalid('shape'), alter: doc => change(doc, ['profiles', 'private', 'roles', 'qa', 'upgrade'], null) },
    { label: 'lexical version', report: unsupported('version'), token: '0.99999999999999999' },
    { label: 'spelling', report: unsupported('syntax'), alter: doc => { doc.profiles.work.roles.developer.upgrade!.when += '\n'; } },
    { label: 'values', report: invalid('value'), alter: doc => { doc.profiles.private.roles.researcher.thinking = marker; } },
    { label: 'cross-field rules', report: invalid('rule'), alter: doc => { doc.profiles.work.roles.qa.thinking = 'off'; } },
  ];
  for (const [i, high] of faults.entries()) {
    for (const low of faults.slice(i + 1)) {
      if (high.token && low.token) continue; // There is only one version token.
      const doc = fixture();
      high.alter?.(doc);
      low.alter?.(doc);
      for (const input of [doc, reverseMembers(doc)]) {
        assertReport(analyze, raw(version(JSON.stringify(input), high.token ?? low.token ?? '1')), high.report,
          `${high.label} before ${low.label}`);
      }
    }
  }
});

test('isolation: cold standalone import and calls use only local pure inputs and emit no logs', async () => {
  const doc = fixture();
  everyProfile(doc, rows => { rows.developer.upgrade!.when = marker; });
  const rejected = structuredClone(doc);
  rejected.profiles.private.roles.developer.model = `${marker}/claude`;
  const source = `import { registerHooks, isBuiltin } from 'node:module';
    import { parentPort, workerData } from 'node:worker_threads';
    const safeBuiltins = new Set(['assert', 'assert/strict', 'buffer', 'crypto', 'string_decoder', 'util']);
    let calls = 0;
    const deny = () => { calls++; throw new Error('standalone analysis attempted external access'); };
    const allowed = (id) => safeBuiltins.has(id.replace(/^node:/, ''));
    const hook = registerHooks({ resolve(id, ctx, next) {
      if (isBuiltin(id) && !allowed(id)) return deny();
      const result = next(id, ctx);
      if (isBuiltin(result.url) ? !allowed(result.url) : !result.url.startsWith(workerData.src)) return deny();
      return result;
    } });
    for (const key of ['fetch', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage']) {
      Object.defineProperty(globalThis, key, { get: deny, configurable: true });
    }
    const { analyzeDevKitModels } = await import(workerData.adapter);
    const keys = ['env', 'getBuiltinModule', 'cwd', 'chdir', 'kill', 'exit'];
    const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(process, key)]);
    const inputs = workerData.inputs.map(input => new TextEncoder().encode(input));
    const reports = [];
    try {
      for (const key of keys) Object.defineProperty(process, key, { get: deny, configurable: true });
      for (const input of inputs) reports.push(analyzeDevKitModels(input));
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(process, key, descriptor); else delete process[key];
      }
      hook.deregister();
    }
    parentPort.postMessage({ calls, reports });`;
  const worker = new workerThreads.Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    env: {}, execArgv: [], stdout: true, stderr: true,
    workerData: { src: src.href, adapter: adapter.href, inputs: [JSON.stringify(doc), JSON.stringify(rejected)] },
  });
  let logged = 0;
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk: Buffer) => { logged += chunk.length; });
  let result: unknown;
  try {
    result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`isolated adapter did not send a report (exit ${code})`)));
    });
  } finally {
    await worker.terminate();
  }
  assert.deepEqual(result, { calls: 0, reports: [good, invalid('value')] });
  assert.equal(logged, 0, 'standalone analyzer must not print reports or payloads');
});
