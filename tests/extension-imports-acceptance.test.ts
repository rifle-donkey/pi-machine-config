import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ToolError } from '../src/errors.ts';
import type { Platform } from '../src/schema.ts';

type Input = { path: string; bytes: Uint8Array };
type Analyze = (files: readonly Input[]) => unknown;
type Kind = 'static' | 'reexport' | 'dynamic' | 'require';
type EdgeStatus = 'external' | 'missing' | 'outside-set' | 'unsupported' | 'unsupported-target' | 'resolved';
type FileReason = 'decode-error' | 'parse-error' | 'parse-limit' | 'import-limit';

// Resolve only inside the test that needs the analyzer. The public regression
// can then run against the pre-feature baseline, without stubbing the analyzer.
const src = new URL('../src/', import.meta.url);
async function analyzer(dir = src): Promise<Analyze> {
  const { analyzeExtensionImports } = await import(new URL('extension-imports.ts', dir).href);
  assert.equal(typeof analyzeExtensionImports, 'function');
  return analyzeExtensionImports;
}
function input(name: string, text: string | Uint8Array = ''): Input {
  return { path: `extensions/${name}`, bytes: typeof text === 'string' ? Buffer.from(text) : text };
}
function edge(kind: Kind, status: Exclude<EdgeStatus, 'resolved'>, typeOnly = false) {
  return { kind, typeOnly, status };
}
function resolved(kind: Kind, name: string, typeOnly = false) {
  return { kind, typeOnly, status: 'resolved', target: `extensions/${name}` };
}
function analyzed(file: Input, ...imports: unknown[]) {
  return { path: file.path, status: 'analyzed', imports };
}
function notModule(file: Input) {
  return { path: file.path, status: 'not-module' };
}
function failed(file: Input, reason: FileReason) {
  return { path: file.path, status: 'failed', reason };
}
function complete(...files: unknown[]) {
  return { status: 'complete', files };
}
const limit = { status: 'limit' };

test('analyzer: validates input paths, placement, byte entries and duplicates with one fixed error', async () => {
  const analyze = await analyzer();
  assert.deepEqual(analyze([]), complete());
  const valid = input('valid.ts', 'import "./other.ts";');
  const badEntries: unknown[] = [
    ...[
      'extensions/fixture/../marker.ts', 'extensions//marker.ts', 'extensions/./marker.ts',
      'extensions/.marker.ts', 'extensions\\marker.ts', 'extensions/marker\n.ts',
      'extensions/sessions/marker.ts', 'extensions/fixture/marker.css', 'extensions/marker.ts/',
      'extensions', 'Extensions/marker.ts', 'prompts/marker.ts', '/extensions/marker.ts',
    ].map((path) => ({ ...valid, path })),
    { ...valid, path: 42 }, { ...valid, bytes: 'synthetic-bytes-marker' },
    { path: valid.path }, null,
    // Same canonical key, but different bytes: no first/last-wins behavior.
    { ...valid, bytes: Buffer.from('export {};') },
  ];
  for (const [i, entry] of badEntries.entries()) {
    assert.throws(() => analyze([valid, entry as Input]), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.exit, 2);
      assert.equal(error.code, 'extension-import-input-invalid');
      assert.equal(error.message, 'extension-import-input-invalid');
      assert.equal(error.cause, undefined);
      return true;
    }, `invalid entry case ${i}`);
  }
});

test('analyzer: reports TS import-equals as require, type-only declarations and edges in source order', async () => {
  const analyze = await analyzer();
  const main = input('main.MTS', [
    '/// <reference path="./triple-slash.ts" />',
    '// import "./comment.ts";',
    'import type { Shape } from "./types.ts";',
    'import local = require("./values.ts");',
    'import type Alias = require("./types.ts");',
    'import internal = Local.Namespace;',
    'import "./values.ts";',
    'import { value as imported } from "./values.ts";',
    'export type { Shape } from "./types.ts";',
    'export { value } from "./values.ts";',
    'export * from "./values.ts";',
    'export { local };',
    'type FromType = import("./type-expression.ts").Shape;',
    'declare module "fixture-ambient" { import Ambient = require("./ambient.ts"); }',
    'const decoy = "require(\'./text.ts\')";',
    'const later = () => import("./values.ts");',
  ].join('\n'));
  const types = input('types.ts', 'export type Shape = { size: number };');
  const values = input('values.ts', 'export const value = 1;');
  const script = input('Z.CJS', [
    'require("./values.ts");',
    'function syntactic(require) { return require("./values.ts"); }',
    'other.require("./ignored.ts");',
    'require.resolve("./ignored.ts");',
    'require?.("./values.ts");',
    'require();',
    'require(...["./values.ts"]);',
    'require(name);',
    'require(`./values.ts`);',
    'import(`./values.ts`);',
    'import(name);',
    'import("./values.ts");',
  ].join('\n'));
  const want = complete(
    analyzed(script,
      resolved('require', 'values.ts'), resolved('require', 'values.ts'),
      ...Array.from({ length: 5 }, () => edge('require', 'unsupported')),
      edge('dynamic', 'unsupported'), edge('dynamic', 'unsupported'), resolved('dynamic', 'values.ts')),
    analyzed(main,
      resolved('static', 'types.ts', true), resolved('require', 'values.ts'), resolved('require', 'types.ts', true),
      resolved('static', 'values.ts'), resolved('static', 'values.ts'), resolved('reexport', 'types.ts', true),
      resolved('reexport', 'values.ts'), resolved('reexport', 'values.ts'),
      resolved('dynamic', 'values.ts')),
    analyzed(types), analyzed(values),
  );
  const files = Object.freeze([values, main, script, types].map((file) => Object.freeze(file)));
  assert.deepEqual(analyze(files), want);
  assert.deepEqual(analyze([...files].reverse()), want);
});

test('analyzer: each supported suffix is parsed, scripts count as analyzed and only other suffixes are not-module', async () => {
  const analyze = await analyzer();
  const js = input('a.js', 'function trivial() { return 0; }');
  const mjs = input('b.MJS', 'import "fixture-module-name";');
  const cjs = input('c.cJs', 'module.exports = 0;');
  const ts = input('d.Ts', 'const fixture: number = 1;');
  const mts = input('e.mts', 'export type Fixture = string;');
  const cts = input('f.CTS', 'const fixture: number = 1;');
  const boundedView = Uint8Array.from([255, ...Buffer.from('\uFEFFimport "./a.js";'), 255]);
  const bom = input('g.js', boundedView.subarray(1, -1));
  const json = input('h.JSON', '{ not parsed }');
  const note = input('i.md', Uint8Array.of(255));
  const jsTyped = input('j.js', 'const fixture: number = 1;');
  const jsModuleStrict = input('k.mjs', 'with ({}) {}');
  const tsModuleStrict = input('l.mts', 'with ({}) {}');
  const jsUnambiguous = input('m.js', 'with ({}) {}');
  const tsUnambiguous = input('n.cts', 'with ({}) {}');
  const fixtures = [js, mjs, cjs, ts, mts, cts, bom, json, note,
    jsTyped, jsModuleStrict, tsModuleStrict, jsUnambiguous, tsUnambiguous];
  assert.deepEqual(analyze(fixtures.reverse()), complete(
    analyzed(js), analyzed(mjs, edge('static', 'external')), analyzed(cjs), analyzed(ts), analyzed(mts), analyzed(cts),
    analyzed(bom, resolved('static', 'a.js')), notModule(json), notModule(note), failed(jsTyped, 'parse-error'),
    failed(jsModuleStrict, 'parse-error'), failed(tsModuleStrict, 'parse-error'), analyzed(jsUnambiguous), analyzed(tsUnambiguous),
  ));
});

test('analyzer: relative matching is lexical, exact, case sensitive and bounded to the supplied set', async () => {
  const analyze = await analyzer();
  const specifiers = [
    './inside/../value.ts', '../asset.JSON', '././value.ts', './Value.ts', './value', './value.js', './dir',
    './note.md', '../../outside-fixture.ts', 'fixture-package/submodule', 'node:path', '/fixture-only.ts',
    './value.ts?fixture-query', './value.ts#fixture-fragment', './value%2Ets', './inside//../value.ts', './dir/',
    './inside\\value.ts', './fixture\u0000value.ts',
  ];
  const main = input('nested/main.js', specifiers.map((s) => `import ${JSON.stringify(s)};`).join('\n'));
  const data = input('asset.JSON', 'not read as JSON');
  const index = input('nested/dir/index.ts');
  const note = input('nested/note.md');
  // Matching is independent of target parse success.
  const target = input('nested/value.ts', 'export const fixture_broken_syntax = ;');
  assert.deepEqual(analyze([target, main, index, note, data]), complete(
    notModule(data), analyzed(index), analyzed(main,
      resolved('static', 'nested/value.ts'), resolved('static', 'asset.JSON'), resolved('static', 'nested/value.ts'),
      ...Array.from({ length: 4 }, () => edge('static', 'missing')),
      edge('static', 'unsupported-target'), edge('static', 'outside-set'),
      ...Array.from({ length: 3 }, () => edge('static', 'external')),
      ...Array.from({ length: 7 }, () => edge('static', 'unsupported'))),
    notModule(note), failed(target, 'parse-error'),
  ));
});

test('analyzer: fatal decoding and parse errors expose fixed failed reports with no partial imports', async () => {
  const analyze = await analyzer();
  const decode = input('decode.ts', Buffer.concat([Buffer.from('// fixture-decode-marker '), Buffer.of(0xff)]));
  const syntax = input('syntax.ts', 'import "fixture-redacted-specifier";\nconst fixture_parse_marker = ;');
  const jsx = input('jsx.ts', 'const inert = <FixtureLabel />;');
  const decorator = input('decorator.ts', '@fixtureDecorator class Fixture {}');
  const good = input('ok.ts', 'export {};');
  assert.deepEqual(analyze([syntax, jsx, good, decode, decorator]), complete(
    failed(decode, 'decode-error'), failed(decorator, 'parse-error'), failed(jsx, 'parse-error'),
    analyzed(good), failed(syntax, 'parse-error'),
  ));
});

test('analyzer: input count and aggregate bytes include exact boundaries, with no partial aggregate result', async () => {
  const analyze = await analyzer();
  const entries = Array.from({ length: 1024 }, (_, i) => input(`entry-${String(i).padStart(4, '0')}.txt`));
  assert.deepEqual(analyze(entries), complete(...entries.map(notModule)));
  assert.deepEqual(analyze([...entries, input('one-more.txt')]), limit);
  const block = new Uint8Array(128 * 1024);
  const blocks = Array.from({ length: 64 }, (_, i) => input(`block-${String(i).padStart(2, '0')}.txt`, block));
  assert.deepEqual(analyze(blocks), complete(...blocks.map(notModule)));
  assert.deepEqual(analyze([...blocks, input('z-extra.txt', Uint8Array.of(65))]), limit);
});

test('analyzer: per-script byte boundary counts UTF-8 bytes and preserves healthy siblings', async () => {
  const analyze = await analyzer();
  const body = '//' + 'é'.repeat((128 * 1024 - 2) / 2);
  const exact = input('a.js', body);
  const tooBig = input('b.js', `${body}\n`);
  const good = input('c.js');
  const text = input('d.txt', tooBig.bytes);
  assert.deepEqual(analyze([tooBig, good, exact, text]), complete(
    analyzed(exact), failed(tooBig, 'parse-limit'), analyzed(good), notModule(text),
  ));
});

test('analyzer: exact edge caps keep duplicate occurrences, discard partial failed files and limit the aggregate', async () => {
  const analyze = await analyzer();
  const statement = 'require("fixture-edge");\n';
  const exact = Buffer.from(statement.repeat(4096));
  const atCap = Array.from({ length: 4 }, (_, i) => input(`at-${i}.cjs`, exact));
  const tooMany = input('over.cjs', Buffer.concat([exact, Buffer.from(statement)]));
  const expected = atCap.map((file) => analyzed(file, ...Array.from({ length: 4096 }, () => edge('require', 'external'))));
  assert.deepEqual(analyze([tooMany, ...atCap]), complete(...expected, failed(tooMany, 'import-limit')));
  assert.deepEqual(analyze([input('one.cjs', statement), ...atCap]), limit);
});

test('analyzer: no evaluated source and no extra I/O through monitored APIs after parser load', async (t) => {
  const analyze = await analyzer();
  const marker = Symbol.for('pmc-extension-imports-qa-inert-marker');
  const source = input('main.cjs', [
    'globalThis[Symbol.for("pmc-extension-imports-qa-inert-marker")] = true;',
    'require("./fixture-absent.js");',
    'require("fixture-absent-package");',
    'require("./in-memory.ts");',
  ].join('\n'));
  const memory = input('in-memory.ts', 'const value: number = 1;');
  assert.deepEqual(analyze([input('warm.js', 'export {};')]), complete(analyzed(input('warm.js'))));
  assert.equal(Object.hasOwn(globalThis, marker), false);
  const calls: string[] = [];
  function block(label: string, api: object, names: readonly string[]) {
    for (const name of names) t.mock.method(api as Record<string, (...args: unknown[]) => unknown>, name, () => {
      calls.push(`${label}.${name}`);
      throw new Error('fixture I/O sentinel');
    });
  }
  let report: unknown;
  let executed = false;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (/(?:fixture-absent|in-memory\.ts)/.test(specifier)) {
        calls.push('fixture module resolution');
        throw new Error('fixture resolution sentinel');
      }
      return next(specifier, context);
    },
  });
  try {
    const fsMethods = ['access', 'lstat', 'stat', 'realpath', 'open', 'readFile', 'readdir', 'readlink',
      'writeFile', 'appendFile', 'mkdir', 'rm', 'rename'];
    block('fs', fs, [...fsMethods, ...fsMethods.map((name) => `${name}Sync`),
      'existsSync', 'readSync', 'writeSync', 'createReadStream', 'createWriteStream', 'opendir', 'opendirSync']);
    block('fs.promises', fs.promises, [...fsMethods, 'opendir']);
    block('child_process', childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
    block('net', net, ['connect', 'createConnection']);
    block('socket', net.Socket.prototype, ['connect']);
    block('dns', dns, ['lookup', 'resolve']);
    block('dns.promises', dns.promises, ['lookup', 'resolve']);
    block('http', http, ['request', 'get']);
    block('https', https, ['request', 'get']);
    block('globalThis', globalThis, ['fetch']);
    syncBuiltinESMExports();
    report = analyze([source, memory]);
  } finally {
    hooks.deregister();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    executed = Object.hasOwn(globalThis, marker);
    Reflect.deleteProperty(globalThis, marker);
  }
  assert.equal(executed, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(report, complete(analyzed(memory), analyzed(source,
    edge('require', 'missing'), edge('require', 'external'), resolved('require', 'in-memory.ts'))));
});

function copiedApp(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-ext-diag-qa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'project');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
  fs.cpSync(src, path.join(app, 'src'), { recursive: true });
  return { root, app, modules: pathToFileURL(path.join(app, 'src') + path.sep) };
}

test('analyzer: refuses ancestor Babel fallback when the copied project has no local parser', async (t) => {
  const { root, app, modules } = copiedApp(t);
  const entry = new URL('extension-imports.ts', modules);
  assert.ok(fs.existsSync(entry), 'missing feature: src/extension-imports.ts');
  const ancestor = path.join(root, 'node_modules', '@babel', 'parser');
  const stub = path.join(ancestor, 'index.cjs');
  fs.mkdirSync(ancestor, { recursive: true });
  fs.writeFileSync(path.join(ancestor, 'package.json'), '{"main":"index.cjs"}');
  fs.writeFileSync(stub, 'module.exports = {};\n');
  const stubUrl = pathToFileURL(stub).href;
  const ancestorUrl = pathToFileURL(ancestor + path.sep).href;
  const attempts: string[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith(ancestorUrl)) attempts.push('ancestor resolution');
      return result;
    },
    load(url, context, next) {
      if (url === stubUrl) attempts.push('ancestor load');
      return next(url, context);
    },
  });
  try {
    try {
      const { analyzeExtensionImports } = await import(entry.href);
      analyzeExtensionImports([input('entry.js', 'export {};')]);
    } catch {
      // Missing-parser standalone behavior is not specified. Falling back is forbidden.
    }
  } finally {
    hooks.deregister();
  }
  assert.equal(createRequire(path.join(app, 'package.json')).resolve('@babel/parser'), stub);
  assert.deepEqual(attempts, []);
});

test('public baseline: parser-free plan/CLI keep extension bundles incomplete and refuse apply without writes', async (t) => {
  const { root, modules } = copiedApp(t);
  const attempted: string[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.includes('extension-imports') || specifier.includes('@babel/parser')) {
        attempted.push('diagnostic dependency');
        throw new Error('fixture unavailable diagnostic dependency');
      }
      return next(specifier, context);
    },
  });
  try {
    const { captureReview, capture }: typeof import('../src/capture.ts') = await import(new URL('capture.ts', modules).href);
    const { plan }: typeof import('../src/plan.ts') = await import(new URL('plan.ts', modules).href);
    const { main }: typeof import('../src/cli.ts') = await import(new URL('cli.ts', modules).href);
    const home = path.join(root, 'home');
    const sourceAgent = path.join(root, 'source');
    const targetAgent = path.join(root, 'target');
    const state = path.join(root, 'state');
    const bundle = path.join(root, 'bundle');
    const policy = path.join(root, 'policy.json');
    const platform = process.platform as Platform;
    const env = {};
    const guard = { home };
    const ext = ['extensions/helper.ts', 'extensions/main.ts'];
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(sourceAgent, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(sourceAgent, 'settings.json'), '{}');
    fs.writeFileSync(path.join(sourceAgent, ext[0]), 'export const value = 1;\n');
    fs.writeFileSync(path.join(sourceAgent, ext[1]), 'import { value } from "./helper.ts"; export { value };\n');
    fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: {
      common: { files: ext.map((path) => ({ root: 'agent', path, class: 'extension-source', template: false })) },
    } }));
    const opts = { policy, sourceAgent, platform, env, guard };
    const review = captureReview(opts);
    capture({ ...opts, out: bundle, approveInclusion: review.captureReviewToken });
    const expected = {
      status: 'incomplete', platform, overlay: false, approvalToken: null,
      items: [
        ...ext.map((path) => ({ kind: 'file', path, root: 'agent', class: 'extension-source',
          operation: 'incomplete', reason: 'dependency-analysis-unavailable' })),
        { kind: 'target', target: 'agent', operation: 'create' },
      ],
    };
    assert.deepEqual(plan({ bundle, targetAgent, platform, env, guard }), expected);
    const args = ['--bundle', bundle, '--target-agent', targetAgent, '--platform', platform];
    const preview = main(['plan', ...args], env, guard);
    assert.equal(preview.code, 1);
    assert.equal(preview.stderr, '');
    assert.deepEqual(JSON.parse(preview.stdout), { ok: false, command: 'plan', ...expected });
    const apply = main(['apply', ...args, '--state-dir', state, '--approve-activation', `sha256:${'0'.repeat(64)}`], env, guard);
    assert.equal(apply.code, 1);
    assert.equal(apply.stdout, '');
    assert.deepEqual(JSON.parse(apply.stderr), { ok: false, error: 'plan-not-ready' });
    assert.equal(fs.existsSync(targetAgent), false);
    assert.equal(fs.existsSync(state), false);
    assert.doesNotMatch(main(['help'], env, guard).stdout, /extension-imports/);
    const unsupported = main(['extension-imports'], env, guard);
    assert.equal(unsupported.code, 2);
    assert.equal(unsupported.stdout, '');
    assert.deepEqual(JSON.parse(unsupported.stderr), { ok: false, error: 'usage' });
  } finally {
    hooks.deregister();
  }
  assert.deepEqual(attempted, []);
});
