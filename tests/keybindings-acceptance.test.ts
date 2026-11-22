/** Independent offline acceptance tests for the standalone keybindings adapter. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import workerThreads from 'node:worker_threads';

const src = new URL('../src/', import.meta.url);
const adapter = new URL('keybindings.ts', src);
const json = new URL('json.ts', src);
const marker = 'SYNTHETIC-KEYBINDINGS-QA';
const actions = ['app.interrupt', 'app.clear', 'app.exit', 'app.thinking.cycle', 'app.model.select',
  'app.tools.expand', 'tui.editor.cursorUp', 'tui.editor.cursorDown'] as const;
const [interrupt, clear, exit, thinking, select, tools, up, down] = actions;
const bases = ['escape', 'tab', 'enter', 'backspace', 'delete', 'home', 'end', 'space', 'up', 'down', 'left', 'right'];
const modifiers = ['ctrl', 'shift', 'alt', 'super'];
const alphanumeric = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const count32 = [...alphanumeric.slice(0, 32)];
const count33 = [...alphanumeric.slice(0, 33)];
const sameKey = ['ctrl+alt+k', 'alt+ctrl+k'];
const recognized = (actions: number) => ({ status: 'recognized', actions });
const invalid = (reason: 'json' | 'shape') => ({ status: 'invalid', reason });
const unsupported = (reason: 'action' | 'key' | 'limit' | 'duplicate') => ({ status: 'unsupported', reason });
const bytes = (input: unknown) => Buffer.from(JSON.stringify(input));
type Analyze = (input: Uint8Array) => unknown;
type Rejection = ReturnType<typeof invalid | typeof unsupported>;
type Report = ReturnType<typeof recognized> | Rejection;
type Member = readonly [string, unknown];

async function analyzer(url = adapter.href): Promise<Analyze> {
  // Keep the baseline test runnable even when the adapter does not exist yet.
  const { analyzeKeybindings } = await import(url);
  assert.equal(typeof analyzeKeybindings, 'function');
  return analyzeKeybindings;
}
function check(analyze: Analyze, input: Uint8Array, want: Report, label?: string) {
  const actual = analyze(input);
  assert.deepEqual(actual, want, label);
  const keys = Reflect.ownKeys(actual as object);
  assert.equal(keys.length, Object.keys(want).length, label);
  assert.ok(keys.every((key) => Object.hasOwn(want, key)), label);
}
function* orderedSubsets<T>(items: readonly T[]): Generator<T[]> {
  yield [];
  for (const [i, item] of items.entries()) {
    for (const rest of orderedSubsets(items.filter((_, j) => j !== i))) yield [item, ...rest];
  }
}
function* permutations<T>(items: readonly T[]): Generator<T[]> {
  for (const order of orderedSubsets(items)) if (order.length === items.length) yield order;
}

// Run first, with cold imports in the public graph. Count denied resolution
// attempts even when a public route catches the error. Workers need their own hook.
test('baseline: capture approval, plan gate, apply and both CLI doctors stay isolated', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-keybindings-qa-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const forbidden = String.raw`(?:^|/)keybindings\.ts(?:[?#]|$)`;
  const matcher = new RegExp(forbidden);
  let publicAttempts = 0;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const deny = (): never => { publicAttempts++; throw new Error('adapter is test-only'); };
    if (matcher.test(specifier)) deny();
    const result = next(specifier, context);
    if (matcher.test(result.url)) deny();
    return result;
  } });
  const observer = 'pmc-keybindings-qa-worker-observer';
  const counts = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const preload = `import { registerHooks } from 'node:module';
    import { getEnvironmentData } from 'node:worker_threads';
    const counts = getEnvironmentData(${JSON.stringify(observer)});
    const matcher = new RegExp(${JSON.stringify(forbidden)});
    Atomics.add(counts, 0, 1);
    registerHooks({ resolve(specifier, context, next) {
      const deny = () => { Atomics.add(counts, 1, 1); throw new Error('adapter is test-only'); };
      if (matcher.test(specifier)) deny();
      const result = next(specifier, context);
      if (matcher.test(result.url)) deny();
      if (result.url.endsWith('/src/extension-imports.ts')) Atomics.add(counts, 2, 1);
      return result;
    } });`;
  try {
    const Worker = workerThreads.Worker;
    workerThreads.setEnvironmentData(observer, counts);
    t.mock.method(workerThreads, 'Worker', class extends Worker {
      constructor(entry: ConstructorParameters<typeof Worker>[0], opts?: ConstructorParameters<typeof Worker>[1]) {
        super(entry, { ...opts, execArgv: [...(opts?.execArgv ?? []), '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`] });
      }
    });
    syncBuiltinESMExports();
    const { main, runCli } = await import('../src/cli.ts');
    const { parseJsonBytes } = await import('../src/json.ts');
    const { plan } = await import('../src/plan.ts');
    const { restoreFromPlan } = await import('../src/restore.ts');
    const root = fs.realpathSync(temp);
    const home = path.join(root, 'home');
    const source = path.join(root, 'source');
    const targetAgent = path.join(root, 'target');
    const stateDir = path.join(root, 'state');
    const policy = path.join(root, 'policy.json');
    const rel = 'keybindings.json';
    const extension = 'extensions/inert.ts';
    const bindings = path.join(source, rel);
    const env = {};
    const guard = { home };
    const platform = 'darwin' as const;
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(source, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(source, extension), '// Synthetic data for static parsing only.\nexport {};\n');
    fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Inert fixture instructions.\n');
    const captureArgs = ['--policy', policy, '--source-agent', source, '--platform', platform];
    const argsFor = (bundle: string) => ['--bundle', bundle, '--platform', platform, '--target-agent', targetAgent];
    const decode = (stdout: string) => parseJsonBytes(Buffer.from(stdout));
    type CliOutput = Awaited<ReturnType<typeof runCli>>;
    const response = (actual: CliOutput, code: number, body: unknown) => {
      assert.equal(actual.stderr, '');
      assert.equal(actual.code, code, 'unexpected CLI result status');
      assert.deepEqual(decode(actual.stdout), decode(JSON.stringify(body)));
    };
    const refusal = (code: number, error: string) => ({ code, stdout: '', stderr: `${JSON.stringify({ ok: false, error })}\n` });
    const tokenField = (output: CliOutput, field: 'captureReviewToken' | 'approvalToken'): string => {
      assert.equal(output.code, 0);
      assert.equal(output.stderr, '');
      assert.ok(!output.stdout.includes(marker));
      const body = decode(output.stdout);
      assert.ok(body && typeof body === 'object' && !Array.isArray(body));
      const token = body[field];
      assert.ok(typeof token === 'string' && /^sha256:[0-9a-f]{64}$/.test(token));
      return token;
    };
    const setPolicy = (files: object[]) => fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1,
      kind: 'pi-machine-config/inclusion', layers: { common: { files } } }));
    const rule = (path: string, cls: string, template = false) => ({ root: 'agent', path, class: cls, template });
    const take = (bundle: string, token: string) => runCli(['capture', ...captureArgs, '--out', bundle,
      '--approve-inclusion', token], env, guard);
    const review = () => runCli(['capture-review', ...captureArgs], env, guard);
    const wrongToken = `sha256:${'0'.repeat(64)}`;

    for (const [name, text, template, withExtension] of [
      ['recognized', '{"app.interrupt":"shift+ctrl+k","app.clear":[]}\n', false, false],
      ['outside-subset', JSON.stringify({ [marker]: marker }) + '\n', false, true],
      ['template', '{"app.clear":"{{HOME}}"}\n', true, false],
    ] as const) {
      const bundle = path.join(root, name);
      const args = argsFor(bundle);
      setPolicy([rule(rel, 'tool-config', template), ...(withExtension ? [rule(extension, 'extension-source')] : [])]);
      fs.writeFileSync(bindings, '{"app.clear":"a","app.clear":"b"}');
      assert.deepEqual(await review(), refusal(2, 'json-duplicate-key'), 'generic strict capture remains active');
      fs.writeFileSync(bindings, text);
      const reviewed = await review();
      const token = tokenField(reviewed, 'captureReviewToken');
      assert.deepEqual(await review(), reviewed, 'same input produces the same capture review and token');
      assert.equal(fs.existsSync(bundle), false);
      fs.appendFileSync(bindings, ' ');
      assert.notEqual(tokenField(await review(), 'captureReviewToken'), token, 'capture binds exact payload bytes');
      assert.deepEqual(await take(bundle, token), refusal(1, 'inclusion-approval-mismatch'));
      assert.equal(fs.existsSync(bundle), false);
      fs.writeFileSync(bindings, text);
      response(await take(bundle, token), 0, { ok: true, command: 'capture', layers: {
        common: { settings: 0, packages: 0, files: withExtension ? 2 : 1 },
        [`platform:${platform}`]: { settings: 0, packages: 0, files: 0 },
      }, skipped: { settings: 0, packages: 0 } });
      assert.deepEqual(fs.readFileSync(path.join(bundle, 'config/common/files/agent', rel)), Buffer.from(text));
      const expected = { status: 'incomplete', platform, overlay: false, approvalToken: null, items: [
        { kind: 'file', root: 'agent', path: rel, class: 'tool-config', operation: 'incomplete', reason: 'schema-adapter-unavailable' },
        ...(withExtension ? [{ kind: 'file', root: 'agent', path: extension, class: 'extension-source',
          operation: 'incomplete', reason: 'dependency-analysis-unavailable' }] : []),
        { kind: 'target', target: 'agent', operation: 'create' },
      ] };
      assert.deepEqual(plan({ bundle, targetAgent, platform, env, guard }), expected);
      response(await runCli(['plan', ...args], env, guard), 1, { ok: false, command: 'plan', ...expected });
      assert.deepEqual(await runCli(['apply', ...args, '--state-dir', stateDir, '--approve-activation', wrongToken],
        env, guard), refusal(1, 'plan-not-ready'));
      if (withExtension) response(await runCli(['doctor', '--extension-imports', ...args], env, guard), 0, {
        ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files: [
          { path: extension, status: 'analyzed', imports: { resolved: 0, missing: 0, 'outside-set': 0,
            unsupported: 0, 'unsupported-target': 0, external: 0 } },
        ],
      });
      assert.equal(fs.existsSync(targetAgent), false);
      assert.equal(fs.existsSync(stateDir), false);
      assert.deepEqual(fs.readFileSync(bindings), Buffer.from(text));
    }
    assert.equal(Atomics.load(counts, 0), 1, 'worker observation must be active');
    assert.ok(Atomics.load(counts, 2) > 0, 'worker hook must see the extension analyzer');

    // Ready fixture has no keybindings rule. Successful restore exercises locked
    // recompilation; regular doctor checks the applied fixture with no adapter.
    setPolicy([rule('AGENTS.md', 'agent-context')]);
    const bundle = path.join(root, 'ready');
    const args = argsFor(bundle);
    assert.equal((await take(bundle, tokenField(await review(), 'captureReviewToken'))).code, 0);
    const preview = main(['plan', ...args], env, guard);
    const approvalToken = tokenField(preview, 'approvalToken');
    assert.deepEqual(await runCli(['plan', ...args], env, guard), preview);
    const applied = restoreFromPlan({ bundle, targetAgent, stateDir, platform, env, guard, approveActivation: approvalToken,
      deps: { platform, bootId: () => '11111111-2222-4333-8444-555555555555', hostname: () => 'fixture-host',
        pid: () => 4000201, probePid: () => assert.fail('unexpected PID probe') } });
    assert.equal(applied.status, 'applied');
    response(await runCli(['doctor', ...args, '--state-dir', stateDir, '--tx', applied.tx], env, guard), 0,
      { ok: true, command: 'doctor', status: 'match' });
    const help = await runCli(['help'], env, guard);
    assert.equal(help.code, 0);
    assert.equal(help.stderr, '');
    assert.doesNotMatch(help.stdout, /keybindings|analyzeKeybindings/i);
    for (const cmd of [['keybindings', ...args], ['doctor', '--keybindings', ...args], ['plan', '--keybindings', ...args]]) {
      assert.deepEqual(main(cmd, env, guard), refusal(2, 'usage'));
      assert.deepEqual(await runCli(cmd, env, guard), refusal(2, 'usage'));
    }
  } finally {
    hooks.deregister();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    workerThreads.setEnvironmentData(observer, undefined);
    assert.equal(publicAttempts, 0, 'public graph attempted to load the keybindings adapter');
    assert.equal(Atomics.load(counts, 1), 0, 'doctor worker attempted to load the keybindings adapter');
  }
});

test('input: rejects non-Uint8Array with a fixed invalid ToolError and accepts byte views', async () => {
  const analyze = await analyzer();
  const { ToolError } = await import('../src/errors.ts');
  for (const input of [undefined, null, false, 1, marker, [123, 125], new Uint16Array(2),
    new Int8Array(2), new Uint8ClampedArray(2), new ArrayBuffer(2), new DataView(new ArrayBuffer(2)),
    { 0: 123, 1: 125, length: 2, byteLength: 2 }, { length: Number.MAX_SAFE_INTEGER, byteLength: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => analyze(input as Uint8Array), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      const code = 'keybindings-input-invalid';
      assert.equal(error.exit, 2);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.layer, undefined);
      assert.equal(error.cause, undefined);
      assert.equal(String(error), `ToolError: ${code}`);
      return true;
    }, 'type validation wins before byte limit or parsing');
  }
  check(analyze, new Uint8Array([123, 125]), recognized(0));
  const framed = Buffer.from([0xff, 123, 125, 0xff]);
  check(analyze, framed.subarray(1, 3), recognized(0), 'read only the given byte view');
});

test('strict JSON: decode and parser ToolErrors collapse before any schema checks', async () => {
  const analyze = await analyzer();
  const cases = [
    ['empty bytes', ''], ['non-JSON trailing text', `{} ${marker}`], ['trailing comma', '{"app.clear":"a",}'],
    ['comment', `/*${marker}*/ {}`], ['BOM', '\ufeff{}'],
    ['invalid UTF-8', Buffer.from([123, 34, 0xff, 34, 58, 34, 97, 34, 125])],
    ['exact action member repeated', '{"app.clear":"a","app.clear":"b"}'],
    ['escaped action member repeated', String.raw`{"app.clear":"a","app.\u0063lear":"b"}`],
    ['unsafe key', '{"__proto__":"a"}'], ['unsafe nested key', '{"app.clear":{"constructor":"a"}}'],
    ['unsafe key in wrong root shape', '[{"prototype":"a"}]'],
    ['unsafe integer before value shape', '{"app.clear":9007199254740992}'],
    ['non-finite number', '{"app.clear":1e999}'], ['escaped lone surrogate', String.raw`{"app.clear":"\ud800"}`],
    ['too deep', `${'['.repeat(66)}0${']'.repeat(66)}`],
  ] as const;
  for (const [label, input] of cases) {
    check(analyze, typeof input === 'string' ? Buffer.from(input) : input, invalid('json'), label);
  }
  // A strict error in a later member wins even if earlier members could already
  // be rejected by a schema phase. Reverse so no source-order shortcut passes.
  const members = [`"${marker}":false`, '"app.clear":null', '"app.exit":1e999'];
  for (const order of permutations(members)) check(analyze, Buffer.from(`{${order.join(',')}}`), invalid('json'));
});

test('strict JSON: unexpected parser exception propagates without rewrapping', async () => {
  const isolated = new URL(adapter.href);
  isolated.searchParams.set('qa', 'parser-exception');
  const code = `export * from ${JSON.stringify(json.href)};
    export const sentinel = new Error('synthetic unexpected parser failure');
    export function parseJsonBytes() { throw sentinel; }`;
  const facade = `data:text/javascript,${encodeURIComponent(code)}`;
  const { sentinel } = await import(facade);
  let redirected = 0;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (context.parentURL === isolated.href && result.url === json.href) {
      redirected++;
      return next(facade, context);
    }
    return result;
  } });
  try {
    const analyze = await analyzer(isolated.href);
    assert.throws(() => analyze(bytes({})), (error: unknown) => error === sentinel);
    assert.ok(redirected > 0, 'the test must exercise the actual adapter parser import');
  } finally {
    hooks.deregister();
  }
});

test('shape and action: exact object root, value shapes and closed action vocabulary', async () => {
  const analyze = await analyzer();
  for (const input of [null, false, 0, '', 'a', [], ['a'], [{ [clear]: 'a' }]]) {
    check(analyze, bytes(input), invalid('shape'), 'valid JSON with a non-object root');
  }
  for (const value of [null, false, 1, {}, { keys: ['a'] }, [null], ['a', false], ['a', 0], ['a', {}], ['a', []]]) {
    check(analyze, bytes({ [clear]: value }), invalid('shape'), 'only strings or arrays of strings');
  }
  for (const action of ['$schema', 'clear', 'interrupt', 'cursorUp', 'app.model.cycle', 'tui.editor.cursorLeft',
    'app.Clear', ' app.clear', 'app.clear ', 'app.clear\n', '', 'toString', `extension.${marker}`]) {
    check(analyze, bytes({ [action]: 'a' }), unsupported('action'), 'permit only exact listed IDs');
  }
});

test('recognized: all actions, base IDs, ordered modifier subsets and explicit unbindings', async () => {
  const analyze = await analyzer();
  for (const action of actions) check(analyze, bytes({ [action]: 'a' }), recognized(1), 'each listed action is admitted');
  const document: Member[] = [[interrupt, alphanumeric.slice(0, 26)], [clear, alphanumeric.slice(26)], [exit, bases],
    [thinking, []], [select, 'ctrl+shift+alt+super+backspace'], [tools, 'super+alt+shift+ctrl+backspace'],
    [up, 'up'], [down, []]];
  check(analyze, bytes(Object.fromEntries(document)), recognized(8));
  check(analyze, bytes(Object.fromEntries([...document].reverse())), recognized(8));
  check(analyze, Buffer.from(String.raw` { "app.\u0063lear" : "\u0061" } `), recognized(1), 'validate decoded IDs and keys');
  for (const mods of orderedSubsets(modifiers)) {
    check(analyze, bytes({ [clear]: [...mods, 'z'].join('+') }), recognized(1), 'modifier order is not required');
  }
  check(analyze, bytes({ [clear]: [] }), recognized(1), 'explicit unbinding still counts as an action');
});

test('key spelling: closed ASCII grammar, no trimming, aliases, controls or templates', async () => {
  const analyze = await analyzer();
  for (const value of ['', 'ab', 'A', 'é', '１', '😀', '0x1', 'f1', '/', '+', 'esc', 'return', 'del', 'pageUp', 'insert',
    'Ctrl+a', 'ctrl+A', 'control+a', 'meta+a', 'cmd+a', 'alt+ctrl+alt+a', 'ctrl+shift+alt+super+ctrl+a',
    'ctrl', 'ctrl+', '+a', 'ctrl++a', 'a+ctrl', 'ctrl+a+shift', 'a ', ' a', '\ta', 'a\n', 'a\r', 'ctrl+ a',
    'a\0', 'a\u007f', 'a\u2028', 'ctrl\u00a0+a', '{{HOME}}', '{{AGENT_DIR}}', `${marker}\nopaque`,
    'a'.repeat(64), 'a'.repeat(65), '😀'.repeat(33)]) {
    check(analyze, bytes({ [clear]: value }), unsupported('key'), 'invalid scalar key spelling');
    check(analyze, bytes({ [clear]: ['z', value] }), unsupported('key'), 'invalid member in an otherwise valid key list');
  }
});

test('limits: exact file-byte and per-action key-count boundaries, counting repeats', async () => {
  const analyze = await analyzer();
  const { LIMITS } = await import('../src/schema.ts');
  const backing = Buffer.alloc(LIMITS.fileBytes + 2, 0x20);
  backing.write('{}', 1);
  check(analyze, backing.subarray(1, -1), recognized(0), 'inclusive byte limit using the view, not the backing buffer');
  check(analyze, backing.subarray(1), unsupported('limit'), 'valid JSON one byte over');
  backing[1] = 0xff;
  check(analyze, backing.subarray(1, -1), invalid('json'), 'parse failure at the exact limit');
  check(analyze, backing.subarray(1), unsupported('limit'), 'byte cap wins even over undecodable input');
  check(analyze, bytes({ [clear]: count32, [exit]: count32 }), recognized(2), 'cap is per action, not aggregate');
  check(analyze, bytes({ [clear]: count33 }), unsupported('limit'));
  check(analyze, bytes({ [clear]: Array.from({ length: 32 }, () => 'a') }), unsupported('duplicate'));
  check(analyze, bytes({ [clear]: Array.from({ length: 33 }, () => 'a') }), unsupported('limit'));
});

test('duplicates: compare base and unordered modifier set within each action only', async () => {
  const analyze = await analyzer();
  for (const keys of [['a', 'a'], sameKey, [...sameKey].reverse(),
    ['ctrl+shift+alt+super+enter', 'super+ctrl+shift+alt+enter']]) {
    check(analyze, bytes({ [clear]: ['z', ...keys] }), unsupported('duplicate'));
  }
  check(analyze, Buffer.from(String.raw`{"app.clear":["a","\u0061"]}`), unsupported('duplicate'), 'compare decoded keys');
  check(analyze, bytes({ [clear]: ['a', 'ctrl+a', 'shift+a', 'ctrl+shift+a', 'ctrl+shift+b'],
    [exit]: ['shift+ctrl+a', 'a'] }), recognized(2), 'distinct pairs and cross-action reuse are allowed');
});

test('B2-R1: every document phase wins in both member orders, never the first bad action', async () => {
  const analyze = await analyzer();
  const faults: readonly (readonly [Member, Rejection])[] = [
    [[`extension.${marker}`, 'a'], unsupported('action')],
    [[clear, ['a', null]], invalid('shape')],
    [[exit, ['a', `${marker}\nopaque`]], unsupported('key')],
    [[thinking, count33], unsupported('limit')],
    [[select, sameKey], unsupported('duplicate')],
  ];
  for (const [i, [earlier, want]] of faults.entries()) {
    for (const [later, lowerPriority] of faults.slice(i + 1)) {
      for (const members of [[earlier, later], [later, earlier]]) {
        check(analyze, bytes(Object.fromEntries([[up, 'up'], ...members, [down, []]])), want,
          `${want.reason} must win over ${lowerPriority.reason} regardless of member order`);
      }
    }
  }
  for (const members of permutations(faults.map(([entry]) => entry))) {
    check(analyze, bytes(Object.fromEntries(members)), unsupported('action'));
  }
  // Same-member/list priority as well as whole-document priority across actions.
  for (const value of [[`${marker}`, null], [null, `${marker}`]]) {
    check(analyze, bytes({ [clear]: value }), invalid('shape'));
  }
  for (const keys of [[...count32, `${marker}`], [`${marker}`, ...count32]]) {
    check(analyze, bytes({ [clear]: keys }), unsupported('key'));
  }
  for (const keys of [['q', 'q', `${marker}`], [`${marker}`, 'q', 'q']]) {
    check(analyze, bytes({ [clear]: keys }), unsupported('key'));
  }
});
