/** Independent offline acceptance for the documented pi-herdr-agents 3.12.1 subset. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import workerThreads from 'node:worker_threads';
import { ToolError } from '../src/errors.ts';
import { parseJsonBytes } from '../src/json.ts';
import { LIMITS } from '../src/schema.ts';

const adapter = new URL('../src/herdr-config.ts', import.meta.url);
const strictJson = new URL('../src/json.ts', import.meta.url);
const marker = 'SyntheticHerdrQA';
const reference = 'fixture-provider/fixture-model';
const status = { enabled: true };
const categories = ['coding', 'review', 'recon', 'qa', 'architecture', 'docs'] as const;
const raw = (s: string) => Buffer.from(s);
const bytes = (x: unknown) => raw(JSON.stringify(x));
const recognized = { status: 'recognized' } as const;
const invalid = (reason: 'json' | 'shape' | 'value') => ({ status: 'invalid', reason }) as const;
const unsupported = (reason: 'limit' | 'key' | 'syntax' | 'value') => ({ status: 'unsupported', reason }) as const;
type Report = typeof recognized | ReturnType<typeof invalid | typeof unsupported>;
type Analyzer = (value: Uint8Array) => unknown;

// A late import gives each adapter test its own missing-feature failure while
// allowing the public isolation control to run before the adapter is loaded.
async function analyzer(url = adapter.href): Promise<Analyzer> {
  const { analyzeHerdrConfig } = await import(url);
  assert.equal(typeof analyzeHerdrConfig, 'function');
  return analyzeHerdrConfig;
}
function report(analyze: Analyzer, input: Uint8Array, expected: Report, label?: string): void {
  const before = Uint8Array.from(input);
  const result = analyze(input);
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), label);
  const keys = Reflect.ownKeys(result);
  assert.equal(keys.length, Object.keys(expected).length, label);
  assert.ok(keys.every(key => Object.hasOwn(expected, key)), label);
  assert.deepEqual({ ...result }, expected, label);
  assert.deepEqual(Uint8Array.from(input), before, 'adapter must not modify its input');
}
const config = (rest: object) => bytes({ status, ...rest });
const models = (modelFields: object) => config({ models: modelFields });

// Static copy of config.json.example, not the user's Herdr configuration.
const packagedExample = `{
  "herdr": {
    "backend": "auto"
  },
  "status": {
    "enabled": true
  },
  "models": {
    "agents": {}
  },
  "persistent": {
    "maxAgents": 3
  },
  "spawning": {
    "maxDepth": 3
  },
  "supervision": {
    "forcePolling": false,
    "hangWarningMinutes": 15
  },
  "panes": {
    "mode": "grouped",
    "direction": "right",
    "maxPerTab": 4
  },
  "guidelines": {
    "launchRoster": true
  },
  "outcomeLedger": true
}
`;

// Static copy of docs/configuration.md, "Model preferences", JSON block.
const guideModelsExample = `{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model",
      "reviewer": "your-provider/your-review-model"
    },
    "tasks": {
      "coding": ["your-provider/your-coding-model"],
      "review": ["your-provider/your-review-model"],
      "recon": ["your-provider/your-fast-model"],
      "qa": ["your-provider/your-qa-model"],
      "architecture": ["your-provider/your-architecture-model"],
      "docs": ["your-provider/your-docs-model"]
    },
    "tasksThinking": {
      "coding": "high",
      "review": "high",
      "recon": "low",
      "qa": "medium",
      "architecture": "xhigh",
      "docs": "medium"
    },
    "tasksMeta": {
      "generatedAt": "2026-09-17T00:00:00Z",
      "method": "research"
    }
  }
}`;

// Block attempted resolution in the main thread and in the real extension
// doctor worker, including imports whose failures a caller might swallow.
test('public isolation baseline: capture, plan, apply and both doctors leave the adapter standalone', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'pmc-herdr-qa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  const targetAgent = path.join(root, 'target');
  const stateDir = path.join(root, 'state');
  const policy = path.join(root, 'policy.json');
  const herdrRel = 'herdr-agents/config.json';
  const herdr = path.join(source, herdrRel);
  const extension = 'extensions/herdr-fixture.ts';
  const platform = 'darwin' as const;
  const env = {};
  const guard = { home };
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(herdr), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(source, extension)));
  fs.writeFileSync(path.join(source, extension), 'export {};\n');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Synthetic context.\n');
  const rule = (path: string, cls: string) => ({ root: 'agent', path, class: cls, template: false });
  const setPolicy = (...files: ReturnType<typeof rule>[]) => fs.writeFileSync(policy, JSON.stringify({
    schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: { files } },
  }));

  const denied = /(?:^|\/)herdr-config\.ts(?:[?#]|$)/;
  const dataKey = 'pmc-herdr-acceptance-import-observer';
  const counts = new Int32Array(new SharedArrayBuffer(12));
  const preload = `import { registerHooks } from 'node:module';
    import { getEnvironmentData } from 'node:worker_threads';
    const counts = getEnvironmentData(${JSON.stringify(dataKey)});
    const denied = ${denied};
    Atomics.add(counts, 0, 1);
    registerHooks({ resolve(specifier, context, next) {
      const check = name => {
        if (denied.test(name)) { Atomics.add(counts, 1, 1); throw new Error('standalone adapter'); }
      };
      check(specifier);
      const result = next(specifier, context);
      check(result.url);
      if (result.url.endsWith('/extension-imports.ts')) Atomics.add(counts, 2, 1);
      return result;
    } });`;
  let parentAttempts = 0;
  const hook = registerHooks({ resolve(specifier, context, next) {
    const check = (name: string) => {
      if (denied.test(name)) { parentAttempts++; throw new Error('standalone adapter'); }
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
    const { restoreFromPlan } = await import('../src/restore.ts');
    type Output = Awaited<ReturnType<typeof runCli>>;
    const cli = (args: string[]) => runCli(args, env, guard);
    const from = ['--policy', policy, '--source-agent', source, '--platform', platform];
    const to = (bundle: string) => ['--bundle', bundle, '--target-agent', targetAgent, '--platform', platform];
    const review = () => cli(['capture-review', ...from]);
    const capture = (bundle: string, token: string) => cli(['capture', ...from, '--out', bundle, '--approve-inclusion', token]);
    const refusal = (code: number, error: string) => ({ code, stdout: '', stderr: `${JSON.stringify({ ok: false, error })}\n` });
    function response(output: Output, code: number, expected: object) {
      assert.equal(output.code, code);
      assert.equal(output.stderr, '');
      assert.deepEqual(parseJsonBytes(raw(output.stdout)), parseJsonBytes(bytes(expected)));
    }
    function token(output: Output, field: 'captureReviewToken' | 'approvalToken'): string {
      assert.equal(output.code, 0);
      assert.equal(output.stderr, '');
      assert.ok(!output.stdout.includes(marker));
      const body = parseJsonBytes(raw(output.stdout));
      assert.ok(body && typeof body === 'object' && !Array.isArray(body));
      const token = body[field];
      assert.ok(typeof token === 'string' && /^sha256:[a-f0-9]{64}$/.test(token));
      return token;
    }

    // The two payloads would get different standalone reports. Public routes
    // still accept strict JSON for capture and keep tool-config incomplete.
    const variants = [models({ default: `fixture/${marker}` }), bytes({ [marker]: marker })];
    for (const [i, payload] of variants.entries()) {
      const withExtension = i === 0;
      setPolicy(rule(herdrRel, 'tool-config'), ...(withExtension ? [rule(extension, 'extension-source')] : []));
      fs.writeFileSync(herdr, String.raw`{"status":{},"sta\u0074us":{}}`);
      assert.deepEqual(await review(), refusal(2, 'json-duplicate-key'));
      fs.writeFileSync(herdr, payload);
      const bundle = path.join(root, `bundle-${i}`);
      const reviewed = await review();
      const approved = token(reviewed, 'captureReviewToken');
      assert.deepEqual(await review(), reviewed);
      fs.appendFileSync(herdr, ' ');
      assert.notEqual(token(await review(), 'captureReviewToken'), approved);
      assert.deepEqual(await capture(bundle, approved), refusal(1, 'inclusion-approval-mismatch'));
      assert.equal(fs.existsSync(bundle), false);
      fs.writeFileSync(herdr, payload);
      response(await capture(bundle, approved), 0, { ok: true, command: 'capture', layers: {
        common: { settings: 0, packages: 0, files: withExtension ? 2 : 1 },
        [`platform:${platform}`]: { settings: 0, packages: 0, files: 0 },
      }, skipped: { settings: 0, packages: 0 } });
      const bundled = path.join(bundle, 'config/common/files/agent', herdrRel);
      response(await cli(['plan', ...to(bundle)]), 1, { ok: false, command: 'plan', status: 'incomplete',
        platform, overlay: false, approvalToken: null, items: [
          { kind: 'file', root: 'agent', path: herdrRel, class: 'tool-config', operation: 'incomplete', reason: 'schema-adapter-unavailable' },
          ...(withExtension ? [{ kind: 'file', root: 'agent', path: extension, class: 'extension-source',
            operation: 'incomplete', reason: 'dependency-analysis-unavailable' }] : []),
          { kind: 'target', target: 'agent', operation: 'create' },
        ] });
      assert.deepEqual(await cli(['apply', ...to(bundle), '--state-dir', stateDir, '--approve-activation', `sha256:${'0'.repeat(64)}`]),
        refusal(1, 'plan-not-ready'));
      response(await cli(['doctor', '--extension-imports', ...to(bundle)]), 0, {
        ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files: withExtension ? [
          { path: extension, status: 'analyzed', imports: {
            resolved: 0, missing: 0, 'outside-set': 0, unsupported: 0, 'unsupported-target': 0, external: 0,
          } },
        ] : [],
      });
      assert.equal(fs.existsSync(targetAgent), false);
      assert.equal(fs.existsSync(stateDir), false);
      assert.deepEqual(fs.readFileSync(bundled), payload);
      assert.deepEqual(fs.readFileSync(herdr), payload);
    }

    // Successful default doctor and locked plan recompilation on a separate
    // fixture without tool-config, using only synthetic identity callbacks.
    setPolicy(rule('AGENTS.md', 'agent-context'));
    const readyBundle = path.join(root, 'ready-bundle');
    assert.equal((await capture(readyBundle, token(await review(), 'captureReviewToken'))).code, 0);
    const ready = await cli(['plan', ...to(readyBundle)]);
    const approveActivation = token(ready, 'approvalToken');
    assert.deepEqual(await cli(['plan', ...to(readyBundle)]), ready);
    const applied = restoreFromPlan({ bundle: readyBundle, targetAgent, stateDir, platform, approveActivation, env, guard,
      deps: { platform, bootId: () => '11111111-2222-4333-8444-555555555555', hostname: () => 'fixture-host',
        pid: () => 4000201, probePid: () => assert.fail('unexpected PID probe') } });
    assert.equal(applied.status, 'applied');
    response(await cli(['doctor', ...to(readyBundle), '--state-dir', stateDir, '--tx', applied.tx]), 0,
      { ok: true, command: 'doctor', status: 'match' });
    const help = await cli(['help']);
    assert.equal(help.code, 0);
    assert.equal(help.stderr, '');
    assert.doesNotMatch(help.stdout, /herdr-config|analyzeHerdrConfig|herdr-agents\/config\.json/i);
    for (const cmd of [['herdr-config', ...to(readyBundle)], ['doctor', '--herdr-config', ...to(readyBundle)],
      ['plan', '--herdr-config', ...to(readyBundle)]]) assert.deepEqual(await cli(cmd), refusal(2, 'usage'));
  } finally {
    hook.deregister();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    workerThreads.setEnvironmentData(dataKey, undefined);
  }
  assert.equal(parentAttempts, 0, 'public graph attempted to load the standalone adapter');
  assert.equal(Atomics.load(counts, 0), 1, 'one worker observer must start');
  assert.equal(Atomics.load(counts, 1), 0, 'extension worker attempted to load the standalone adapter');
  assert.ok(Atomics.load(counts, 2) > 0, 'observer must see the extension analyzer');
});

test('input contract: byte views only, visible slice only, and fixed ToolError', async () => {
  const analyze = await analyzer();
  for (const value of [undefined, null, false, 1, marker, [123, 125], new Uint16Array(1), new Int8Array(1),
    new Uint8ClampedArray(1), new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), { length: 1, byteLength: 1 }]) {
    assert.throws(() => analyze(value as Uint8Array), (err: unknown) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'herdr-config-input-invalid');
      assert.equal(err.message, 'herdr-config-input-invalid');
      assert.equal(err.exit, 2);
      assert.equal(err.layer, undefined);
      assert.equal(err.cause, undefined);
      return true;
    });
  }
  const carrier = Uint8Array.from(Buffer.concat([Buffer.of(0xff), config({}), Buffer.of(0xff)]));
  const before = Uint8Array.from(carrier);
  report(analyze, carrier.subarray(1, -1), recognized);
  assert.deepEqual(carrier, before);
});

test('recognition: pinned packaged defaults and unmodified versus status-completed guide example', async () => {
  const analyze = await analyzer();
  report(analyze, raw(packagedExample), recognized, 'packaged config.json.example');
  report(analyze, raw(guideModelsExample), unsupported('key'), 'guide Model preferences example omits status');
  report(analyze, raw(`{"status":{"enabled":true},${guideModelsExample.slice(1)}`), recognized, 'guide plus required status');
  report(analyze, raw(String.raw`{"st\u0061tus":{"ena\u0062led":false},"models":{"default":"fixture\/\u006Dodel"}}`),
    recognized, 'decode escaped names and reference before validating');
});

test('byte limit: exactly at limit parsed, excess wins before strict JSON in both orders', async () => {
  const analyze = await analyzer();
  const pad = (text: string, n: number) => Buffer.concat([raw(text), Buffer.alloc(n - Buffer.byteLength(text), 0x20)]);
  const good = '{"status":{"enabled":true}}';
  report(analyze, pad(good, LIMITS.fileBytes), recognized);
  report(analyze, pad(good, LIMITS.fileBytes + 1), unsupported('limit'));
  for (const text of ['{"status":null,"unknown":9007199254740992}', '{"unknown":9007199254740992,"status":null}']) {
    report(analyze, pad(text, LIMITS.fileBytes), invalid('json'));
    report(analyze, pad(text, LIMITS.fileBytes + 1), unsupported('limit'));
  }
  report(analyze, Buffer.alloc(LIMITS.fileBytes + 1, 0xff), unsupported('limit'));
});

test('strict JSON: parser rejects bytes, grammar, unsafe members/numbers and excessive depth before schema', async () => {
  const analyze = await analyzer();
  const cases: [string, string | Buffer][] = [
    ['empty', ''], ['trailing data', `{"status":{"enabled":true}}${marker}`],
    ['comments', `/* ${marker} */ {"status":{"enabled":true}}`], ['trailing comma', '{"status":{"enabled":true,}}'],
    ['BOM', '\ufeff{"status":{"enabled":true}}'], ['bad UTF-8', Buffer.from([0x22, 0xc0, 0xaf, 0x22])],
    ['duplicate root', '{"status":null,"status":{"enabled":true}}'],
    ['escaped duplicate nested', String.raw`{"status":{"enabled":true,"ena\u0062led":false}}`],
    ['prototype-sensitive root', '{"__proto__":null}'],
    ['prototype-sensitive nested', String.raw`{"status":{"enabled":true},"models":{"agents":{"constr\u0075ctor":"p/m"}}}`],
    ['prototype-sensitive inside wrong types', '[{"prototype":0}]'],
    ['lone surrogate', String.raw`{"status":{"enabled":true},"models":{"default":"p/\ud800"}}`],
    ['malformed escape', String.raw`{"status":{"enabled":true},"models":{"default":"p/\q"}}`],
    ['excess depth', '{"extra":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}'],
    ...['01', '+1', '1.', '.1', '1e', 'NaN', 'Infinity'].map((n): [string, string] =>
      [`bad token ${n}`, `{"status":{"enabled":true},"spawning":{"maxDepth":${n}}}`]),
  ];
  for (const [label, value] of cases) report(analyze, typeof value === 'string' ? raw(value) : value, invalid('json'), label);
});

test('strict JSON: unexpected parser exception propagates unchanged', async () => {
  const isolated = new URL(adapter.href);
  isolated.searchParams.set('acceptance', 'strict-parser-exception');
  const shim = `export * from ${JSON.stringify(strictJson.href)};
    export const sentinel = new Error('synthetic unexpected parser exception');
    export function parseJsonBytes() { throw sentinel; }`;
  const shimUrl = `data:text/javascript,${encodeURIComponent(shim)}`;
  const { sentinel } = await import(shimUrl);
  let redirects = 0;
  const hook = registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (context.parentURL !== isolated.href || result.url !== strictJson.href) return result;
    redirects++;
    return next(shimUrl, context);
  } });
  try {
    const analyze = await analyzer(isolated.href);
    assert.throws(() => analyze(config({})), (thrown: unknown) => thrown === sentinel);
    assert.ok(redirects > 0, 'adapter must route its bytes through the strict parser');
  } finally {
    hook.deregister();
  }
});

test('required status and closed keys: required only where specified; inherited-looking agent names are data', async () => {
  const analyze = await analyzer();
  for (const root of [null, false, 0, '', [], [{ status, extra: 1 }]]) {
    report(analyze, bytes(root), invalid('shape'), 'non-object root');
  }
  report(analyze, bytes({}), unsupported('key'), 'missing status');
  report(analyze, config({ status: {} }), unsupported('key'), 'missing status.enabled');
  report(analyze, config({}), recognized, 'minimal config');
  report(analyze, config({ status: { enabled: false }, outcomeLedger: false }), recognized);
  report(analyze, config({ herdr: {}, models: { agents: {} }, persistent: {}, spawning: {}, supervision: {},
    panes: {}, guidelines: {} }), recognized, 'all other section members are optional');
  report(analyze, models({ agents: { toString: reference, hasOwnProperty: reference } }), recognized);
  for (const key of ['roles', 'sidebar', 'Status', 'outcome-ledger', marker]) {
    report(analyze, config({ [key]: {} }), unsupported('key'), `root ${key}`);
  }
  for (const [section, valid] of Object.entries({ status, herdr: { backend: 'auto' }, models: {}, persistent: {},
    spawning: {}, supervision: {}, panes: {}, guidelines: {} })) {
    report(analyze, config({ [section]: { ...valid, [marker]: true } }), unsupported('key'), section);
  }
  for (const key of ['Coding', 'role', 'task:coding', marker]) {
    report(analyze, models({ tasks: { [key]: [reference] } }), unsupported('key'), 'unknown task category');
    report(analyze, models({ tasksThinking: { [key]: 'off' } }), unsupported('key'), 'unknown thinking category');
  }
  const generatedAt = '2026-11-19T12:00:00Z';
  for (const tasksMeta of [{}, { method: 'research' }, { generatedAt }, { generatedAt, method: 'research', extra: 0 }]) {
    report(analyze, models({ tasksMeta }), unsupported('key'), 'metadata object must have exactly both keys');
  }
});

test('shape: arrays/null are never key-checked objects, and every leaf type stays strict', async () => {
  const analyze = await analyzer();
  for (const section of ['status', 'herdr', 'models', 'persistent', 'spawning', 'supervision', 'panes', 'guidelines']) {
    for (const bad of [null, [], [{ extra: 0 }], true, 1, 'object']) {
      report(analyze, config({ [section]: bad }), invalid('shape'), section);
    }
  }
  for (const field of ['agents', 'tasks', 'tasksThinking', 'tasksMeta']) {
    for (const bad of [null, [], [{ extra: 0 }], true, 'map']) {
      report(analyze, models({ [field]: bad }), invalid('shape'), field);
    }
  }
  for (const [label, rest] of Object.entries({
    outcomeLedger: { outcomeLedger: {} }, enabled: { status: { enabled: 1 } },
    backend: { herdr: { backend: false } }, maxAgents: { persistent: { maxAgents: '1' } },
    maxDepth: { spawning: { maxDepth: '1' } }, forcePolling: { supervision: { forcePolling: 'true' } },
    hangWarningMinutes: { supervision: { hangWarningMinutes: '0' } }, mode: { panes: { mode: [] } },
    direction: { panes: { direction: 1 } }, maxPerTab: { panes: { maxPerTab: true } },
    launchRoster: { guidelines: { launchRoster: null } }, default: { models: { default: [reference] } },
    agentEntry: { models: { agents: { a: [reference] } } }, taskEntry: { models: { tasks: { coding: reference } } },
    mixedCandidates: { models: { tasks: { coding: [reference, null] } } },
    thinkingEntry: { models: { tasksThinking: { coding: [] } } },
    generatedAt: { models: { tasksMeta: { generatedAt: 1, method: 'research' } } },
    method: { models: { tasksMeta: { generatedAt: '2026-11-19T00:00:00Z', method: null } } },
  })) report(analyze, config(rest), invalid('shape'), label);
});

test('phase precedence: all comparable schema-phase pairs win in both member orders', async () => {
  const analyze = await analyzer();
  // Disjoint sections let every pair coexist without overwriting either fault.
  const phases: [string, Record<string, unknown>, Report][] = [
    ['key', { guidelines: { extra: true } }, unsupported('key')],
    ['shape', { spawning: { maxDepth: '1' } }, invalid('shape')],
    ['syntax', { models: { default: 'task:coding' } }, unsupported('syntax')],
    ['documented value', { panes: { direction: 'sideways' } }, invalid('value')],
    ['conservative value', { persistent: { maxAgents: 0 } }, unsupported('value')],
  ];
  const unsafeMember = '"supervision":{"hangWarningMinutes":1e999}';
  for (const [label, fault, want] of phases) {
    report(analyze, config(fault), want, label);
    const members = JSON.stringify(fault).slice(1, -1);
    for (const ordered of [`${unsafeMember},${members}`, `${members},${unsafeMember}`]) {
      report(analyze, raw(`{"status":{"enabled":true},${ordered}}`), invalid('json'), `strict JSON before ${label}`);
    }
  }
  for (const [i, [first, a, want]] of phases.entries()) {
    for (const [second, b] of phases.slice(i + 1)) {
      report(analyze, bytes({ status, ...a, ...b }), want, `${first} before ${second}: first member`);
      report(analyze, bytes({ ...b, ...a, status }), want, `${first} before ${second}: last member`);
    }
  }
  for (const badStatus of [{}, null]) {
    for (const doc of [{ status: badStatus, persistent: { maxAgents: null }, extra: 0 },
      { extra: 0, persistent: { maxAgents: null }, status: badStatus }]) {
      report(analyze, bytes(doc), unsupported('key'), 'root key check outranks malformed sections');
    }
  }
  for (const fields of [{ agents: { '!bad': reference }, tasksMeta: {} }, { tasksMeta: {}, agents: { '!bad': reference } }]) {
    report(analyze, models(fields), unsupported('key'), 'required metadata keys beat sibling agent syntax');
  }
  for (const fields of [{ agents: { '!bad': reference }, tasks: [] }, { tasks: [], agents: { '!bad': reference } }]) {
    report(analyze, models(fields), invalid('shape'), 'non-object task map beats sibling agent syntax');
  }
  for (const fields of [
    { tasksThinking: { coding: 'bogus' }, tasks: { coding: [] } },
    { tasks: { coding: [] }, tasksThinking: { coding: 'bogus' } },
  ]) report(analyze, models(fields), invalid('value'), 'invalid thinking beats empty candidates');
  for (const text of ['{"status":null,"unknown":1e999}', '{"unknown":1e999,"status":null}']) {
    report(analyze, raw(text), invalid('json'), 'strict JSON beats key and shape');
  }
  for (const rest of [{}, { spawning: { maxDepth: false } }]) {
    report(analyze, bytes(rest), unsupported('key'), 'missing status beats wrong field type');
  }
  report(analyze, config({ status: {}, models: [] }), unsupported('key'), 'missing enabled beats malformed sibling');
  report(analyze, raw('{"models":[],"status":{}}'), unsupported('key'), 'missing enabled beats earlier malformed sibling');
});

test('integer boundaries: decoded numbers including rounding, signed zero, and parser rejection', async () => {
  const analyze = await analyzer();
  const fields = [
    ['persistent', 'maxAgents', unsupported('value')],
    ['spawning', 'maxDepth', invalid('value')],
    ['supervision', 'hangWarningMinutes', unsupported('value')],
    ['panes', 'maxPerTab', invalid('value')],
  ] as const;
  for (const [section, field, rejected] of fields) {
    const doc = (lexeme: string) => raw(`{"status":{"enabled":true},"${section}":{"${field}":${lexeme}}}`);
    for (const integer of ['1', '1.0', '10e-1', '0.9999999999999999999999', '9007199254740991', '9007199254740991.1']) {
      report(analyze, doc(integer), recognized, `${field}: decoded ${integer}`);
    }
    for (const zero of ['0', '-0', '-0e5', '1e-999', '-1e-999']) {
      report(analyze, doc(zero), field === 'hangWarningMinutes' ? recognized : rejected, `${field}: ${zero}`);
    }
    for (const bad of ['-1', '-9007199254740991', '0.5', '1.25', '-0.5']) {
      report(analyze, doc(bad), rejected, `${field}: ${bad}`);
    }
    for (const unsafe of ['9007199254740992', '-9007199254740992', '9007199254740991.9', '1e999', '-1e999']) {
      report(analyze, doc(unsafe), invalid('json'), `${field}: ${unsafe}`);
    }
  }
});

test('spelling boundaries: agent names and complete references across all positions', async () => {
  const analyze = await analyzer();
  for (const name of ['A', '0', '9.A_b-c', 'A' + 'x'.repeat(63)]) {
    report(analyze, models({ agents: { [name]: reference } }), recognized, 'valid agent key');
  }
  for (const name of ['', '_a', '-a', '.a', 'A' + 'x'.repeat(64), 'a b', 'a:b', 'a/b', 'a\n', 'a\r', 'é']) {
    report(analyze, models({ agents: { [name]: reference } }), unsupported('syntax'), 'invalid agent key');
  }
  const provider64 = '9' + 'a'.repeat(63);
  const ref256 = provider64 + '/' + 'b'.repeat(188) + '/3:';
  assert.equal(ref256.length, 256);
  const positions = [
    (ref: string) => models({ default: ref }),
    (ref: string) => models({ agents: { a: ref } }),
    (ref: string) => models({ tasks: { coding: [ref] } }),
  ];
  for (const at of positions) {
    for (const ref of ['a/7', '9.A_b-c/3._:A-B/7:Z', ref256]) report(analyze, at(ref), recognized);
    for (const ref of [ref256 + 'x', provider64 + 'x/m', 'a', '/m', 'a/', 'a/m/', 'a//m', 'a/m//z', '.a/m',
      '_a/m', '-a/m', 'a:b/m', 'a/_m', 'a/:m', 'a/m/._z', 'a/m@x', 'a/m x', 'a/é', 'a/m\\x', 'a/m\n',
      'a/m\r', 'task:coding', '{{MODEL}}', 'a/{{MODEL}}']) {
      report(analyze, at(ref), unsupported('syntax'), `reject ${JSON.stringify(ref)}`);
    }
  }
});

test('fallback limits and duplicates: one to eight trimmed entries, and only ASCII space trims', async () => {
  const analyze = await analyzer();
  const eight = Array.from({ length: 8 }, (_, i) => 'p' + i + '/' + 'm'.repeat(253));
  assert.ok(eight.every(value => value.length === 256));
  for (const at of [(s: string) => models({ default: s }), (s: string) => models({ agents: { one: s } })]) {
    for (const value of [reference, `  ${reference}   `, ` ${eight.join(' ,  ')} `, 'a/B, a/b']) {
      report(analyze, at(value), recognized, 'valid fallback list');
    }
    for (const value of ['', ' ', ',a/b', 'a/b,', 'a/b,,a/c', 'a/b, ,a/c', [...eight, 'a/z'].join(','),
      '\ta/b', 'a/b\t, a/c', 'a/b, \na/c', 'a/b\u00a0', 'a/b,\u2003a/c', 'a/b\r\n']) {
      report(analyze, at(value), unsupported('syntax'), `bad fallback ${JSON.stringify(value)}`);
    }
    for (const value of ['a/b,a/b', 'a/b,  a/b  ', 'a/b,a/c,a/b']) {
      report(analyze, at(value), unsupported('value'), 'duplicate trimmed fallback');
    }
  }
  report(analyze, raw(String.raw`{"status":{"enabled":true},"models":{"default":"a/b, a/\u0062"}}`),
    unsupported('value'), 'decoded reference duplicates an unescaped reference');
  report(analyze, models({ default: reference, agents: { a: reference, b: reference }, tasks: { qa: [reference] } }),
    recognized, 'duplicate rule does not cross independent lists');
});

test('documented value and timestamp sets: exact enums and timestamp spelling, not calendar validation', async () => {
  const analyze = await analyzer();
  for (const backend of ['auto', 'legacy', 'core']) report(analyze, config({ herdr: { backend } }), recognized);
  for (const mode of ['grouped', 'tab', 'split']) {
    for (const direction of ['right', 'down']) report(analyze, config({ panes: { mode, direction } }), recognized);
  }
  for (const rest of [{ herdr: { backend: 'Auto' } }, { herdr: { backend: 'core\n' } }, { panes: { mode: 'tab ' } },
    { panes: { direction: 'left' } }]) report(analyze, config(rest), invalid('value'));
  for (const method of ['research', 'registry-only']) {
    for (const generatedAt of ['2026-11-19T14:15:43Z', '2026-11-19T14:15:43.123Z', '2026-99-99T99:99:99.999Z']) {
      report(analyze, models({ tasksMeta: { method, generatedAt } }), recognized, 'timestamp is spelling only');
    }
  }
  for (const generatedAt of ['2026-11-19', '2026-11-19t14:15:43Z', '2026-11-19T14:15:43z',
    '2026-11-19T14:15:43+00:00', '2026-11-19T14:15:43.1Z', '2026-11-19T14:15:43.1234Z',
    '2026-1-19T14:15:43Z', '２０２６-11-19T14:15:43Z', '2026-11-19T14:15:43Z\n', ' 2026-11-19T14:15:43Z']) {
    report(analyze, models({ tasksMeta: { method: 'research', generatedAt } }), unsupported('syntax'));
  }
  for (const method of ['', 'registry_only', 'Research', 'research ']) {
    report(analyze, models({ tasksMeta: { method, generatedAt: '2026-11-19T14:15:43Z' } }), invalid('value'));
  }
});

test('tasks and thinking: partial maps, untrimmed candidates, exact duplicates, and sibling coverage', async () => {
  const analyze = await analyzer();
  for (const category of categories) {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      report(analyze, models({ tasks: { [category]: [reference] }, tasksThinking: { [category]: level } }), recognized);
    }
  }
  report(analyze, models({ tasks: { coding: Array.from({ length: 9 }, (_, i) => `p/c${i}`), review: [reference] },
    tasksThinking: { review: 'max' } }), recognized, 'no fallback-list cap on task arrays, no thinking required for coding');
  report(analyze, models({ tasks: { coding: ['p/M', 'p/m'], review: ['p/m'] } }), recognized, 'exact and per-array duplicates');
  for (const bad of [` ${reference}`, `${reference} `, `${reference},x/y`, `\t${reference}`, 'task:qa']) {
    report(analyze, models({ tasks: { coding: [bad] } }), unsupported('syntax'), 'task array entry is a single untrimmed ID');
  }
  for (const fields of [{ tasks: {} }, { tasksThinking: {} }, { tasks: { coding: [reference] }, tasksThinking: {} },
    { tasks: { coding: [] } }, { tasks: { coding: [reference, 'p/m', reference] } },
    { tasksThinking: { coding: 'off' } },
    { tasks: { coding: [reference] }, tasksThinking: { coding: 'off', qa: 'high' } }]) {
    report(analyze, models(fields), unsupported('value'));
  }
  for (const level of ['auto', 'HIGH', 'max ', 'off\n', '']) {
    report(analyze, models({ tasks: { coding: [reference] }, tasksThinking: { coding: level } }), invalid('value'));
  }
});

test('redaction: closed reports and no console or stream output with synthetic payload markers', async t => {
  const analyze = await analyzer();
  const tagged = models({ default: `fixture/${marker}`, agents: { [marker]: reference }, tasksMeta: {
    generatedAt: '2026-11-19T14:15:43.123Z', method: 'registry-only',
  } });
  const output = [];
  for (const method of ['log', 'info', 'debug', 'warn', 'error', 'dir', 'trace'] as const) {
    output.push(t.mock.method(console, method, () => {}));
  }
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  try {
    report(analyze, tagged, recognized);
    report(analyze, config({ [marker]: `/${marker}/path` }), unsupported('key'));
    report(analyze, models({ default: `invalid ${marker}` }), unsupported('syntax'));
    report(analyze, config({ herdr: { backend: marker } }), invalid('value'));
    report(analyze, raw(`{"status":{"enabled":true},"${marker}":`), invalid('json'));
    for (const observed of [...output, stdout, stderr]) assert.equal(observed.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
  }
});
