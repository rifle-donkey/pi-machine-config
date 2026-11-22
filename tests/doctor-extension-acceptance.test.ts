/** Independent CLI acceptance tests for the opt-in extension import doctor. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import workerThreads from 'node:worker_threads';
import { approvalDocument, captureToken, reviewDescriptor } from '../src/approval.ts';
import { APPROVAL_PATH, COMPLETE_PATH, POLICY_PATH, layerDir, payloadPath } from '../src/bundle.ts';
import * as cli from '../src/cli.ts';
import { prettyJson } from '../src/json.ts';
import { plan } from '../src/plan.ts';
import { BUNDLE_LAYERS, DISCOVERY_MODEL, completionDocument, manifestDocument, sha256Hex,
  type BundleLayer, type FileClass, type FileRecord, type FileRoot, type LayerManifest } from '../src/schema.ts';

// A dynamic lookup leaves the suite loadable on the pre-feature test-first base.
type Dispatch = (...args: Parameters<typeof cli.main>) => Promise<cli.CliOutput>;
function dispatch(): Dispatch {
  const fn: unknown = Reflect.get(cli, 'runCli');
  assert.equal(typeof fn, 'function', 'missing feature: runCli');
  return fn as Dispatch;
}

const marker = 'synthetic-private-extension-doctor-marker';
const optIn = '--extension-imports';
const MiB = 1024 * 1024;
const platform = 'linux';

function put(root: string, rel: string, bytes: string | Uint8Array) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

type Payload = Pick<FileRecord, 'root' | 'path' | 'class' | 'template'> & { body: string | Uint8Array };
const entry = (root: FileRoot, rel: string, cls: FileClass, body: Payload['body']): Payload =>
  ({ root, path: rel, class: cls, body, template: false });
const ext = (rel: string, body: Payload['body'] = '') => entry('agent', `extensions/${rel}`, 'extension-source', body);

type Layers = Partial<Record<BundleLayer, Payload[]>>;
function fixture(t: TestContext, layers: Layers = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-doctor-ext-qa-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = fs.realpathSync(temp);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const guard = { home };
  const env = {};
  const bundle = path.join(root, 'bundle');
  const targetAgent = path.join(root, 'target');
  const state = path.join(root, 'state');
  const lensConfig = path.join(root, 'lens.json');
  const overlay = path.join(root, 'overlay');
  // Build a valid recorded approval with distinct common/platform bodies at the
  // same destination. A single capture reads both layers from the same source.
  const manifests = {} as Record<BundleLayer, LayerManifest>;
  const manifestHashes = {} as Record<BundleLayer, string>;
  const prefs = { defaultModel: marker };
  const policy: Record<string, unknown> = {};
  for (const layer of BUNDLE_LAYERS) {
    const files = (layers[layer] ?? []).map(({ body, ...rule }) => {
      const bytes = typeof body === 'string' ? Buffer.from(body) : body;
      put(bundle, `${layerDir(layer)}/${payloadPath(rule)}`, bytes);
      return { ...rule, bytes: bytes.length, sha256: sha256Hex(bytes) };
    });
    const settings = layer === 'common' ? prefs : {};
    policy[layer] = { settings: Object.keys(settings), files: files.map(({ bytes: _bytes, sha256: _sha, ...rule }) => rule) };
    const m = manifests[layer] = { layer, settings, files, packages: [], packagesRemove: [] };
    const bytes = Buffer.from(prettyJson(manifestDocument(m)));
    put(bundle, `${layerDir(layer)}/manifest.json`, bytes);
    manifestHashes[layer] = sha256Hex(bytes);
  }
  const policyBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: policy }));
  put(bundle, POLICY_PATH, policyBytes);
  const policySha = sha256Hex(policyBytes);
  const desc = reviewDescriptor({ platform, policySha256: policySha, manifests });
  const approval = Buffer.from(prettyJson(approvalDocument(captureToken(desc), desc)));
  put(bundle, APPROVAL_PATH, approval);
  put(bundle, COMPLETE_PATH, prettyJson(completionDocument(policySha, sha256Hex(approval), manifestHashes)));
  const options = { bundle, platform, targetAgent, env, guard } as const;
  const args = (overrides: Partial<Record<'bundle' | 'platform' | 'target-agent' | 'overlay' | 'lens-config', string | null>> = {}) => [
    'doctor', optIn, ...Object.entries({ bundle, platform, 'target-agent': targetAgent, ...overrides })
      .flatMap(([k, v]) => v === null ? [] : [`--${k}`, v]),
  ];
  return { root, home, guard, env, bundle, targetAgent, lensConfig, state, overlay, options, args };
}
type Fixture = ReturnType<typeof fixture>;

const line = (body: unknown) => `${JSON.stringify(body)}\n`;
const complete = (files: readonly unknown[]) => ({ code: 0, stderr: '', stdout: line({
  ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files,
}) });
const unverified = (reason: string) => ({ code: 1, stderr: '', stdout: line({
  ok: false, command: 'doctor', mode: 'extension-imports', status: 'unverified', reason,
}) });
const error = (error: string, layer?: string, code = 2) => ({ code, stdout: '', stderr: line({
  ok: false, error, ...(layer === undefined ? {} : { layer }),
}) });
const counts = (resolved = 0, missing = 0, outside = 0, unsupported = 0, target = 0, external = 0) => ({
  resolved, missing, 'outside-set': outside, unsupported, 'unsupported-target': target, external,
});
const analyzed = (name: string, imports = counts()) => ({ path: `extensions/${name}`, status: 'analyzed', imports });
const notModule = (name: string) => ({ path: `extensions/${name}`, status: 'not-module' });
const failed = (name: string, reason: string) => ({ path: `extensions/${name}`, status: 'failed', reason });

// Capture file identities, metadata and bytes. Only atime is allowed to vary.
function snapshot(root: string) {
  const entries: unknown[] = [];
  function visit(file: string) {
    const st = fs.lstatSync(file, { bigint: true });
    const { dev, ino, mode, uid, gid, nlink, size, birthtimeNs, mtimeNs, ctimeNs } = st;
    entries.push([path.relative(root, file), dev, ino, mode, uid, gid, nlink, size, birthtimeNs, mtimeNs, ctimeNs,
      st.isFile() ? fs.readFileSync(file) : st.isSymbolicLink() ? fs.readlinkSync(file) : null]);
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  visit(root);
  return entries;
}

function under(arg: unknown, root: string) {
  const p = typeof arg === 'string' ? arg : Buffer.isBuffer(arg) ? arg.toString() : arg instanceof URL ? fileURLToPath(arg) : '';
  return p === root || p.startsWith(`${root}${path.sep}`);
}

// Test at Node's boundary, not through proposed internal worker/clock seams.
// These traps observe the parent thread; they do not instrument the real worker.
async function watched(t: TestContext, f: Fixture, args: string[], expectWorkers: 0 | 1,
  opts: { extraUnread?: string[]; env?: Record<string, string>; ioErrorAt?: string; failWorkerConstruction?: true } = {}) {
  const runCli = dispatch();
  const before = snapshot(f.root);
  const denied: string[] = [];
  let workers = 0;
  const deny = (operation: string): never => { denied.push(operation); throw new Error(marker); };
  const forbidTargets = (op: string, file: unknown) => {
    if ([f.targetAgent, f.lensConfig, f.state, ...(opts.extraUnread ?? [])].some((target) => under(file, target))) deny(op);
  };
  const denyMethods = (api: object, names: readonly string[]) => {
    for (const method of names) t.mock.method(api as Record<string, () => unknown>, method, () => deny(method));
  };
  try {
    const Worker = workerThreads.Worker;
    t.mock.method(workerThreads, 'Worker', class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        workers++;
        if (expectWorkers === 0) deny('worker construction');
        if (opts.failWorkerConstruction) throw new Error(marker);
        super(...args);
      }
    });
    denyMethods(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
    denyMethods(net.Socket.prototype, ['connect']);
    denyMethods(globalThis, ['fetch']);
    const writes = ['appendFile', 'chmod', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
      'symlink', 'truncate', 'unlink', 'writeFile'];
    denyMethods(fs, [...writes, ...writes.map((k) => `${k}Sync`), 'createWriteStream']);
    denyMethods(fs.promises, writes);
    const checkOpen = (file: unknown, flags: unknown = 'r') => {
      forbidTargets('target or unapproved file open', file);
      const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
      const writable = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND;
      if (typeof flags === 'number' ? flags & writable : !['r', 'rs', 'sr'].includes(String(flags))) deny('writable open');
    };
    function watch(api: object, method: string, check: (...args: unknown[]) => void) {
      const a = api as Record<string, (...args: unknown[]) => unknown>;
      const original = a[method];
      t.mock.method(a, method, (...args: unknown[]) => { check(...args); return Reflect.apply(original, api, args); });
    }
    for (const [api, suffix] of [[fs, 'Sync'], [fs, ''], [fs.promises, '']] as const) {
      watch(api, `open${suffix}`, checkOpen);
      for (const method of ['opendir', 'readdir', 'readFile']) {
        watch(api, method + suffix, (file) => {
          forbidTargets(method, file);
          if (method !== 'readFile' && under(file, f.bundle)) deny('bundle enumeration');
        });
      }
    }
    watch(fs, 'createReadStream', (file) => forbidTargets('createReadStream', file));
    if (opts.ioErrorAt) {
      watch(fs, 'lstatSync', (file) => {
        if (file === opts.ioErrorAt) throw Object.assign(new Error(marker), { code: 'EACCES' });
      });
    }
    syncBuiltinESMExports();
    return await runCli(args, opts.env ?? f.env, f.guard);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(snapshot(f.root), before, 'doctor changed the filesystem');
    assert.deepEqual(denied, [], 'doctor attempted prohibited I/O');
    assert.equal(workers, expectWorkers, 'wrong number of workers');
  }
}

test('doctor extension imports: exact usage, option combinations and synchronous refusal', async (t) => {
  const f = fixture(t);
  const valid = f.args();
  const exact = '  pi-machine-config doctor --extension-imports --bundle <dir> --platform <darwin|linux> --target-agent <dir> [--overlay <dir>] [--lens-config <file>]';
  const defaultDoctor = '  pi-machine-config doctor --bundle <dir> --platform <darwin|linux> --target-agent <dir> --state-dir <dir> --tx <id> [--overlay <dir>] [--lens-config <file>]';
  // With both transaction inputs present, main must still refuse the opt-in flag.
  const tx = ['--tx', 'a'.repeat(32)];
  const state = ['--state-dir', f.state];
  assert.deepEqual(cli.main(valid, f.env, f.guard), error('usage'));
  assert.deepEqual(cli.main([...valid, ...state, ...tx], f.env, f.guard), error('usage'));
  const runCli = dispatch();
  for (const args of [['help'], ['--help']]) {
    const h = await runCli(args, f.env, f.guard);
    assert.deepEqual(h, cli.main(args, f.env, f.guard));
    assert.equal(h.code, 0);
    assert.equal(h.stderr, '');
    assert.deepEqual(h.stdout.split('\n').filter((l) => l.startsWith('  pi-machine-config doctor ')).sort(), [exact, defaultDoctor,
      '  pi-machine-config doctor --resource-checks --bundle <dir> --platform <darwin|linux> --target-agent <dir> [--overlay <dir>] [--lens-config <file>]',
    ].sort());
  }
  const base = valid.filter((x) => x !== optIn);
  for (const args of [
    [optIn], [...valid, ...state], [...valid, ...tx], [...valid, ...state, ...tx],
    [...valid, optIn], [...valid, '--overlay'], [...valid, '--lens-config', '--other'],
    [...valid, '--bundle', f.bundle], [...valid, '--' + marker], ['doctor', `${optIn}=true`, ...base.slice(1)],
    [...valid, 'true'], f.args({ bundle: null }), f.args({ platform: null }), f.args({ 'target-agent': null }),
    f.args({ platform: marker }), f.args({ bundle: 'relative-path' }), base, [...base, ...state], [...base, ...tx],
    ['plan', ...valid.slice(1)], ['apply', ...valid.slice(1), ...state],
  ]) {
    assert.deepEqual(await watched(t, f, args, 0), error('usage'), `unexpected usage result for ${args.join(' ')}`);
  }
});

test('doctor extension imports: only winning approved extension bytes, exact counts, no target access or evaluation', async (t) => {
  const imports = [
    'import type { Value } from "./target.ts";', 'export * from "./target.ts";', 'import("../asset.JSON");',
    'import "./untracked.ts";', 'import "./target";', 'import "../../AGENTS.md";',
    'import "/fixture-absolute.ts";', 'import "#fixture-hook";', 'import "file:fixture.ts";', 'import "..";', 'import(variable);',
    'import "./notes.md";', 'import "node:path";', `import "fixture-package/${marker}";`,
  ].join('\n');
  const f = fixture(t, { common: [
    ext('nested/target.ts', 'export type Value = string;'),
    ext('nested/main.ts', `const ${marker.replaceAll('-', '_')} = ;`), // losing bytes must not influence counts
    ext('nested/notes.md'), ext('huge.ts', `//${'x'.repeat(128 * 1024 - 1)}`),
    ext('broken.js', `import "fixture-${marker}"; const = ;`),
    ext('Z.cjs', `throw new Error(${JSON.stringify(marker)}); require("fixture-inert-package");`),
    ext('asset.JSON', 'not parsed as JSON'), entry('agent', 'AGENTS.md', 'agent-context', marker),
  ], 'platform:linux': [ext('nested/main.ts', imports)], 'platform:darwin': [ext('not-selected.ts', 'import "fixture-other-platform";')] });
  assert.equal(plan(f.options).status, 'incomplete');
  put(f.targetAgent, 'extensions/nested/untracked.ts', 'export {};');
  put(f.targetAgent, 'extensions/nested/main.ts', 'export {};');
  const untracked = put(f.bundle, 'config/common/files/agent/extensions/nested/untracked.ts', 'export {};');
  const unselected = path.join(f.bundle, 'config/platforms/darwin/files');
  assert.equal(plan(f.options).status, 'conflict', 'an existing target must not authorize activation');
  const want = complete([
    analyzed('Z.cjs', counts(0, 0, 0, 0, 0, 1)), notModule('asset.JSON'), failed('broken.js', 'parse-error'),
    failed('huge.ts', 'parse-limit'), analyzed('nested/main.ts', counts(3, 2, 1, 5, 1, 2)),
    notModule('nested/notes.md'), analyzed('nested/target.ts'),
  ]);
  const args = [...f.args().filter((arg) => arg !== optIn), optIn];
  assert.deepEqual(await watched(t, f, args, 1, { extraUnread: [untracked, unselected] }), want);
});

test('doctor extension imports: overlay and lens guards still apply, without lens content access', async (t) => {
  const f = fixture(t, { common: [ext('ok.ts'), entry('lens-config', 'config.json', 'external-config', '{}')] });
  put(f.overlay, 'manifest.json', JSON.stringify({ schemaVersion: 1, layer: 'overlay', piDiscoveryModel: DISCOVERY_MODEL,
    files: [], packages: [], settings: {} }));
  assert.deepEqual(await watched(t, f, f.args({ overlay: f.overlay }), 0), error('lens-config-required'));
  const lensArgs = f.args({ overlay: f.overlay, 'lens-config': f.lensConfig });
  assert.equal(plan({ ...f.options, overlay: f.overlay, lensConfig: f.lensConfig }).status, 'incomplete');
  put(f.root, 'lens.json', marker);
  assert.deepEqual(await watched(t, f, lensArgs, 1), complete([analyzed('ok.ts')]));
});

test('doctor extension imports: empty approved set completes without worker; unused lens is invalid', async (t) => {
  const f = fixture(t, { common: [entry('agent', 'AGENTS.md', 'agent-context', marker)] });
  assert.equal(plan(f.options).status, 'ready');
  assert.deepEqual(await watched(t, f, f.args(), 0), complete([]));
  assert.deepEqual(await watched(t, f, f.args({ 'lens-config': f.lensConfig }), 0), error('lens-config-unused'));
});

test('doctor extension imports: fixed admission and guarded preparation error envelopes', async (t) => {
  const f = fixture(t, { common: [ext('entry.ts')] });
  assert.deepEqual(await watched(t, f, f.args(), 0, { env: { HOME: marker } }), unverified('live-location-unavailable'));
  assert.deepEqual(await watched(t, f, f.args({ bundle: path.join(f.home, '.pi', marker) }), 0), error('live-path-refused'));
  assert.deepEqual(await watched(t, f, f.args({ 'target-agent': path.join(f.bundle, 'target') }), 0), error('roots-overlap'));
  assert.deepEqual(await watched(t, f, f.args({ bundle: path.join(f.root, marker) }), 0), error('bundle-missing'));
  assert.deepEqual(await watched(t, f, f.args(), 0, { ioErrorAt: f.bundle }), unverified('filesystem-error'));
  fs.unlinkSync(path.join(f.bundle, APPROVAL_PATH));
  assert.deepEqual(await watched(t, f, f.args(), 0), error('inclusion-approval-missing'));
});

test('doctor extension imports: tampered approved bytes are rejected, not reported as parse errors', async (t) => {
  const f = fixture(t, { common: [ext('entry.ts', 'export {};')] });
  put(f.bundle, 'config/common/files/agent/extensions/entry.ts', `import "${marker}";`);
  assert.deepEqual(await watched(t, f, f.args(), 0), error('payload-digest-mismatch', 'common'));
});

test('doctor extension imports: exact 1024 winners pass; 1025 non-module extensions fail before worker', async (t) => {
  const names = Array.from({ length: 1025 }, (_, i) => `file-${String(i).padStart(4, '0')}.txt`);
  const accepted = fixture(t, { common: names.slice(0, -1).map((name) => ext(name)), 'platform:linux': [ext(names[0])] });
  const rejected = fixture(t, { common: names.map((name) => ext(name)) });
  assert.equal(plan(accepted.options).status, 'incomplete');
  assert.equal(plan(rejected.options).status, 'incomplete');
  assert.deepEqual(await watched(t, accepted, accepted.args(), 1), complete(names.slice(0, -1).map(notModule)));
  assert.deepEqual(await watched(t, rejected, rejected.args(), 0), unverified('analysis-limit'));
});

test('doctor extension imports: exact 8 MiB of winners pass; one more byte fails before worker', async (t) => {
  const names = Array.from({ length: 8 }, (_, i) => `block-${i}.txt`);
  const blocks = names.map((name) => ext(name, 'a'.repeat(MiB)));
  const accepted = fixture(t, { common: [...blocks, entry('agent', 'AGENTS.md', 'agent-context', 'b')],
    'platform:linux': [ext(names[0], 'c'.repeat(MiB))] });
  const rejected = fixture(t, { common: [...blocks, ext('one-more.txt', 'd')] });
  assert.equal(plan(accepted.options).status, 'incomplete');
  assert.equal(plan(rejected.options).status, 'incomplete');
  assert.deepEqual(await watched(t, accepted, accepted.args(), 1), complete(names.map(notModule)));
  assert.deepEqual(await watched(t, rejected, rejected.args(), 0), unverified('analysis-limit'));
});

test('doctor extension imports: per-file and aggregate edge bounds without partial results', async (t) => {
  const edge = 'import "x";\n';
  const atCeiling = Array.from({ length: 4 }, (_, i) => ext(`at-${i}.js`, edge.repeat(4096)));
  const accepted = fixture(t, { common: [...atCeiling, ext('too-many.js', edge.repeat(4097))] });
  const rejected = fixture(t, { common: [...atCeiling, ext('z-extra.js', edge)] });
  assert.deepEqual(await watched(t, accepted, accepted.args(), 1), complete([
    ...Array.from({ length: 4 }, (_, i) => analyzed(`at-${i}.js`, counts(0, 0, 0, 0, 0, 4096))), failed('too-many.js', 'import-limit'),
  ]));
  assert.deepEqual(await watched(t, rejected, rejected.args(), 1), unverified('analysis-limit'));
});

test('doctor extension imports: worker-construction failure is fixed and redacted', async (t) => {
  const f = fixture(t, { common: [ext('entry.ts')] });
  assert.deepEqual(await watched(t, f, f.args(), 1, { failWorkerConstruction: true }), unverified('analysis-failed'));
});

test('doctor extension imports: parser-free executable reports unavailable, without leaking to either stream', (t) => {
  const f = fixture(t, { common: [ext('entry.ts', `import "${marker}";`)] });
  const app = path.join(f.root, 'project');
  put(app, 'package.json', '{"type":"module"}');
  fs.cpSync(new URL('../src/', import.meta.url), path.join(app, 'src'), { recursive: true });
  assert.equal(fs.existsSync(path.join(app, 'node_modules')), false);
  assert.equal(plan(f.options).status, 'incomplete');
  const before = snapshot(f.root);
  const r = childProcess.spawnSync(process.execPath, [path.join(app, 'src/cli.ts'), ...f.args()], {
    env: { HOME: f.home, TMPDIR: f.root }, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  assert.deepEqual(snapshot(f.root), before, 'doctor changed the filesystem');
  assert.deepEqual({ code: r.status, stdout: r.stdout, stderr: r.stderr }, unverified('analyzer-unavailable'));
});
