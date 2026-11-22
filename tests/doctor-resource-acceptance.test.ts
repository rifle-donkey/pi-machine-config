/** Independent acceptance tests for the offline doctor resource report and trim semantics. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import workerThreads from 'node:worker_threads';
import { approvalDocument, captureToken, reviewDescriptor } from '../src/approval.ts';
import { APPROVAL_PATH, COMPLETE_PATH, POLICY_PATH, layerDir, payloadPath } from '../src/bundle.ts';
import type { CliOutput } from '../src/cli.ts';
import { parseJsonBytes, isObject, type JsonObject } from '../src/json.ts';
import { BUNDLE_LAYERS, completionDocument, manifestDocument, sha256Hex,
  type BundleLayer, type FileRecord, type LayerManifest, type Platform } from '../src/schema.ts';

const mode = 'resource-checks';
const flag = `--${mode}`;
const marker = 'synthetic-resource-marker';
const tx = ['--tx', 'a'.repeat(32)];
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const error = (error: string, layer?: BundleLayer) => ({ code: 2, stdout: '', stderr: line({ ok: false, error, layer }) });
const usage = error('usage');
const unverified = (reason: string) => ({ ok: false, command: 'doctor', mode, status: 'unverified', reason });
const metadata = (entries: readonly unknown[] = [], missingEntries = 0) => ({ status: 'complete', entries, missingEntries });
const discovery = (entries: readonly unknown[] = [], nameCheck = 'complete', collisions: readonly string[][] = []) =>
  ({ status: 'complete', entries, nameCheck, collisions });
const complete = (skillMetadata = metadata(), skillDiscovery = discovery(), toolConfigs: readonly unknown[] = []) =>
  ({ ok: true, command: 'doctor', mode, status: 'complete', skillMetadata, skillDiscovery, toolConfigs });

function report(r: CliOutput, code: number, expected: object) {
  assert.equal(r.code, code, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(parseJsonBytes(Buffer.from(r.stdout)), parseJsonBytes(Buffer.from(line(expected))));
}

function preview(r: CliOutput, expectedStatus: string) {
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stderr, '');
  const body = parseJsonBytes(Buffer.from(r.stdout));
  if (!isObject(body)) throw new TypeError('plan must emit a JSON object');
  assert.equal(body.status, expectedStatus, 'fixture must pass ordinary preparation');
  assert.equal(body.approvalToken, null);
}

const frontmatter = (...lines: string[]) => ['---', ...lines, '---', 'Inert fixture body.', ''].join('\n');
const skillPath = (name: string) => `skills/${name}/SKILL.md`;
const recognized = (path: string, flags: Partial<{ manualOnly: boolean; nameSource: 'directory' | 'frontmatter';
  nameValid: boolean; nameMatchesDirectory: boolean; descriptionTooLong: boolean }> = {}) =>
  ({ path, status: 'recognized', manualOnly: false, nameSource: 'directory', nameValid: true,
    nameMatchesDirectory: true, descriptionTooLong: false, ...flags });
const candidate = (path: string) => ({ path, status: 'candidate' });
const notDiscovered = (path: string, reason: string) => ({ path, status: 'unverified', reason });

function put(root: string, rel: string, bytes: string | Uint8Array) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

type Payload = Pick<FileRecord, 'root' | 'path' | 'class' | 'template'> & { body: string };
const skill = (path: string, body = frontmatter(`description: ${marker}`)): Payload =>
  ({ root: 'agent', path, class: 'skill-source', template: false, body });
const tool = (path: string, value: unknown, template = false): Payload =>
  ({ root: 'agent', path, class: 'tool-config', template, body: line(value) });
const agentContext = { root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false, body: marker } as const;
type Layer = { files?: readonly Payload[]; settings?: JsonObject };
function fixture(t: TestContext, define: (home: string) => Partial<Record<BundleLayer | 'overlay', Layer>> = () => ({})) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-doctor-resource-qa-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = fs.realpathSync(temp);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const guard = { home };
  const env = {};
  const bundle = path.join(root, 'bundle');
  const target = path.join(root, 'target');
  const state = path.join(root, 'state');
  const overlay = path.join(root, 'overlay');
  const lens = path.join(root, 'lens.json');
  const layers = define(home);
  const manifests = {} as Record<BundleLayer, LayerManifest>;
  const hashes = {} as Record<BundleLayer, string>;
  const manifestInputs = new Set<string>();
  const payloadInputs = new Map<BundleLayer | 'overlay', Set<string>>();
  const policyLayers: Record<string, unknown> = {};
  // Distinct, separately approved bodies at one destination model a layer replacement.
  // A capture of a single source tree would read the same body for both layers.
  function writeLayer(layer: BundleLayer | 'overlay', base: string, spec: Layer = {}) {
    const inputs = new Set<string>();
    payloadInputs.set(layer, inputs);
    const files = (spec.files ?? []).map(({ body, ...rule }) => {
      const bytes = Buffer.from(body);
      inputs.add(put(base, payloadPath(rule), bytes));
      return { ...rule, bytes: bytes.length, sha256: sha256Hex(bytes) };
    });
    const manifest: LayerManifest = { layer, settings: spec.settings ?? {}, files, packages: [], packagesRemove: [] };
    const bytes = Buffer.from(line(manifestDocument(manifest)));
    manifestInputs.add(put(base, 'manifest.json', bytes));
    const policy = { settings: Object.keys(manifest.settings), files: files.map(({ bytes: _bytes, sha256: _sha, ...rule }) => rule) };
    return { manifest, hash: sha256Hex(bytes), policy };
  }
  for (const layer of BUNDLE_LAYERS) {
    const { manifest, hash, policy } = writeLayer(layer, path.join(bundle, layerDir(layer)), layers[layer]);
    manifests[layer] = manifest;
    hashes[layer] = hash;
    policyLayers[layer] = policy;
  }
  const overlayPolicy = layers.overlay && { files: writeLayer('overlay', overlay, layers.overlay).policy.files };
  const policyBytes = Buffer.from(line({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: policyLayers, overlay: overlayPolicy }));
  const policySha = sha256Hex(policyBytes);
  const descriptor = reviewDescriptor({ platform: 'linux', policySha256: policySha, manifests });
  const approval = Buffer.from(line(approvalDocument(captureToken(descriptor), descriptor)));
  manifestInputs.add(put(bundle, POLICY_PATH, policyBytes));
  manifestInputs.add(put(bundle, APPROVAL_PATH, approval));
  manifestInputs.add(put(bundle, COMPLETE_PATH, line(completionDocument(policySha, sha256Hex(approval), hashes))));
  const inputs = (platform: Platform, withOverlay: boolean) => new Set([...manifestInputs,
    ...payloadInputs.get('common')!, ...payloadInputs.get(`platform:${platform}`)!,
    ...(withOverlay ? payloadInputs.get('overlay') ?? [] : [])]);
  const base = (platform: Platform = 'linux') => ['--bundle', bundle, '--platform', platform, '--target-agent', target];
  const args = (platform: Platform = 'linux') => ['doctor', ...base(platform), flag];
  return { root, home, guard, env, bundle, target, state, overlay, lens, base, args, inputs };
}
type Fixture = ReturnType<typeof fixture>;

// Compare identity, content and metadata, excluding access time. I/O traps also
// catch attempted reads and transient writes that a final snapshot cannot see.
function snapshot(root: string) {
  const entries: unknown[] = [];
  function visit(file: string) {
    const stat = fs.lstatSync(file, { bigint: true });
    const { dev, ino, mode, nlink, uid, gid, size, birthtimeNs, mtimeNs, ctimeNs } = stat;
    entries.push([path.relative(root, file), dev, ino, mode, nlink, uid, gid, size, birthtimeNs, mtimeNs, ctimeNs,
      stat.isFile() ? fs.readFileSync(file) : stat.isSymbolicLink() ? fs.readlinkSync(file) : null]);
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
  }
  visit(root);
  return entries;
}

async function watched(t: TestContext, f: Fixture, call: () => CliOutput | Promise<CliOutput>,
  options: { noAccess?: boolean; platform?: Platform; overlay?: boolean; failBundleLookup?: boolean } = {}) {
  const before = snapshot(f.root);
  const allowed = f.inputs(options.platform ?? 'linux', options.overlay ?? false);
  const denied: string[] = [];
  const deny = (op: string): never => { denied.push(op); throw new Error(marker); };
  const asPath = (v: unknown) => typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString() : v instanceof URL ? fileURLToPath(v) : '';
  const inFixture = (v: unknown) => asPath(v) === f.root || asPath(v).startsWith(`${f.root}${path.sep}`);
  function watch(api: object, method: string, check: (...args: unknown[]) => void) {
    const methods = api as Record<string, (...args: unknown[]) => unknown>;
    const original = methods[method];
    t.mock.method(methods, method, (...args: unknown[]) => { check(...args); return Reflect.apply(original, api, args); });
  }
  const block = (api: object, names: readonly string[]) => {
    for (const name of names) t.mock.method(api as Record<string, () => unknown>, name, () => deny(name));
  };
  const checkMeta = (file: unknown, op: string) => {
    if (options.noAccess || !inFixture(file)) deny(op);
  };
  let loadingPath: string | undefined;
  const checkRead = (file: unknown, op: string) => {
    const filePath = asPath(file);
    if (options.noAccess || (!allowed.has(filePath) && filePath !== loadingPath)) deny(op);
  };
  const checkOpen = (file: unknown, flags: unknown = 'r') => {
    checkRead(file, 'unapproved open');
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    const writable = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND;
    if (typeof flags === 'number' ? flags & writable : !['r', 'sr', 'rs'].includes(String(flags))) deny('writable open');
  };
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  let resolvingModule = false;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const wasResolving = resolvingModule;
      resolvingModule = true;
      try {
        const result = next(specifier, context);
        if (result.url.startsWith('file:') && inFixture(new URL(result.url))) deny('fixture module execution');
        return result;
      } finally {
        resolvingModule = wasResolving;
      }
    },
    load(url, context, next) {
      const previous = loadingPath;
      const sourcePath = url.startsWith('file:') ? fileURLToPath(url) : '';
      // Allow the module loader's source read, not arbitrary filesystem access by the module.
      loadingPath = sourcePath.startsWith(src) ? sourcePath : undefined;
      try { return next(url, context); }
      finally { loadingPath = previous; }
    },
  });
  try {
    block(os, ['userInfo', 'homedir']);
    block(process, ['kill']);
    block(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
    block(workerThreads, ['Worker']);
    block(net.Socket.prototype, ['connect']);
    block(globalThis, ['fetch']);
    const writes = ['appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
      'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];
    block(fs, [...writes, ...writes.map(name => `${name}Sync`), 'createWriteStream', 'write', 'writeSync']);
    block(fs.promises, writes);
    for (const [api, suffix] of [[fs, 'Sync'], [fs, ''], [fs.promises, '']] as const) {
      watch(api, `open${suffix}`, checkOpen);
      watch(api, `readFile${suffix}`, file => checkRead(file, 'unapproved readFile'));
      for (const method of ['stat', 'lstat', 'access', 'readlink']) {
        watch(api, method + suffix, file => {
          checkMeta(file, method);
          if (options.failBundleLookup && method === 'lstat' && file === f.bundle) {
            throw Object.assign(new Error(marker), { code: 'EACCES' });
          }
        });
      }
      for (const method of ['opendir', 'readdir']) watch(api, method + suffix, file => {
        // Guarded preparation can check sibling names in the supplied target's parent.
        if (options.noAccess || asPath(file) !== f.root) deny(method);
      });
    }
    watch(fs, 'existsSync', file => checkMeta(file, 'existsSync'));
    watch(fs, 'createReadStream', file => checkRead(file, 'unapproved stream'));
    watch(fs, 'openAsBlob', file => checkRead(file, 'unapproved blob'));
    watch(fs.promises, 'realpath', file => checkMeta(file, 'realpath'));
    const realpath = fs.realpathSync;
    t.mock.method(fs, 'realpathSync', Object.assign((...args: Parameters<typeof realpath>) => {
      // Node uses this API while resolving lazy imports from the checkout.
      if (options.noAccess || !resolvingModule || !asPath(args[0]).startsWith(src)) checkMeta(args[0], 'realpathSync');
      return realpath(...args);
    }, { native: (...args: Parameters<typeof realpath.native>) => {
      checkMeta(args[0], 'realpathSync.native');
      return realpath.native(...args);
    } }));
    syncBuiltinESMExports();
    return await call();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    hook.deregister();
    assert.deepEqual(denied, [], 'doctor attempted prohibited access');
    assert.deepEqual(snapshot(f.root), before, 'doctor changed the fixture tree');
  }
}

test('baseline: cold CLI, plan and existing doctor modes do not load the resource adapters', async t => {
  const f = fixture(t, () => ({ common: { files: [skill(skillPath('sample')), tool('keybindings.json', {})] } }));
  const attempts: string[] = [];
  const check = (name: string) => {
    if (/(?:^|\/)(skill-metadata|skill-discovery|herdr-config|devkit-models|keybindings)\.ts(?:[?#]|$)/.test(name)) {
      attempts.push('resource adapter resolution');
      throw new Error(marker);
    }
  };
  const hook = registerHooks({ resolve(specifier, context, next) {
    check(specifier);
    const result = next(specifier, context);
    check(result.url);
    return result;
  } });
  try {
    const { runCli } = await import('../src/cli.ts');
    const run = (args: string[]) => watched(t, f, () => runCli(args, f.env, f.guard));
    preview(await run(['plan', ...f.base()]), 'incomplete');
    assert.deepEqual(await run(['doctor', ...f.base(), '--state-dir', f.state, ...tx]), error('state-missing'));
    report(await run(['doctor', ...f.base(), '--extension-imports']), 0,
      { ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files: [] });
  } finally {
    hook.deregister();
    assert.deepEqual(attempts, []);
  }
});

test('resource checks: invalid combinations and synchronous main refuse before access', async t => {
  const f = fixture(t);
  const { main, runCli } = await import('../src/cli.ts');
  const state = ['--state-dir', f.state];
  const valid = f.args();
  const noAccess = { noAccess: true };
  for (const args of [valid, [...valid, ...state, ...tx]]) {
    assert.deepEqual(await watched(t, f, () => main(args, f.env, f.guard), noAccess), usage);
  }
  const extension = '--extension-imports';
  const omit = (option: string) => valid.filter((_, i) => i !== valid.indexOf(option) && i !== valid.indexOf(option) + 1);
  const invalid = [
    [...valid, ...state], [...valid, ...tx], [...valid, ...state, ...tx], [...valid, extension],
    ['doctor', extension, ...valid.slice(1)], [...valid, flag], [...valid, '--bundle', f.bundle],
    [...valid, '--overlay'], [...valid, '--lens-config', flag], [...valid, 'true'],
    [...valid.slice(0, -1), `${flag}=true`], omit('--bundle'), omit('--target-agent'), omit('--platform'),
    [...omit('--platform'), '--platform', marker], ['plan', ...valid.slice(1)],
  ];
  for (const [index, args] of invalid.entries()) {
    assert.deepEqual(await watched(t, f, () => runCli(args, f.env, f.guard), noAccess), usage, `invalid invocation ${index + 1}`);
  }
});

test('resource checks: absent resources complete with empty reports and no synthetic paths', async t => {
  const f = fixture(t, () => ({ common: { files: [agentContext] } }));
  const { runCli } = await import('../src/cli.ts');
  report(await watched(t, f, () => runCli(f.args(), f.env, f.guard)), 0, complete());
});

function routing(home: string, workWhen = '{{HOME}}') {
  const profile = (provider: string, when: string) => ({ providers: [provider], roles: Object.fromEntries(
    ['architect', 'developer', 'reviewer', 'qa', 'researcher', 'reviewer-alternate'].map(role => {
      const model = `${provider}/${role === 'reviewer-alternate' ? 'gpt' : 'claude'}-${marker}`;
      return [role, { model, thinking: 'low', ...(role === 'developer' ? { upgrade: { when, model, thinking: 'high' } } : {}) }];
    }),
  ) });
  return { schemaVersion: 1, hostTasksProfile: 'private', profiles: {
    work: profile('fixture-work', workWhen), private: profile('fixture-private', home),
  } };
}

test('resource checks: final rendered winners only, fixed redaction and no target or unapproved reads', async t => {
  const alpha = skillPath('alpha'), beta = skillPath('beta'), broken = skillPath('broken'), nested = skillPath('alpha/nested');
  const devkit = 'dev-kit/models.json', herdr = 'herdr-agents/config.json', keys = 'keybindings.json';
  const f = fixture(t, home => ({
    common: { settings: { skills: ['+skills/beta/SKILL.md'], defaultModel: marker }, files: [
      tool(keys, { 'app.interrupt': 'ctrl+c', 'app.clear': [] }), skill(beta, frontmatter('name: shared-fixture-name', `description: ${marker}`)),
      tool(herdr, { status: { enabled: marker } }), skill(alpha, marker), skill(nested),
      skill('skills/notes/guide.md', marker), skill(broken, frontmatter(`description: ${marker}`, 'disable-model-invocation: TRUE')),
      tool(devkit, { schemaVersion: 2 }), { root: 'lens-config', path: 'config.json', class: 'external-config', template: false, body: '{}' },
      { root: 'agent', path: 'extensions/ignored.ts', class: 'extension-source', template: false, body: 'export {};' },
    ] },
    'platform:linux': { settings: { skills: [] }, files: [
      skill(alpha, frontmatter('name: shared-fixture-name', `description: ${marker}`, 'disable-model-invocation: true')),
      // The two trigger strings are unequal before rendering, equal after replacing the fixture HOME token.
      tool(devkit, routing(home), true),
    ] },
    'platform:darwin': { files: [skill(skillPath('not-selected'))] },
    overlay: { files: [tool('sandbox.json', { marker })] },
  }));
  put(f.target, 'skills/notes/SKILL.md', frontmatter(`description: ${marker}`));
  put(f.target, keys, line({ 'app.clear': 'x' }));
  put(f.root, 'lens.json', marker);
  put(f.bundle, 'config/common/files/agent/skills/notes/SKILL.md', frontmatter('description: Unapproved entry'));
  const { runCli } = await import('../src/cli.ts');
  const opts = ['--overlay', f.overlay, '--lens-config', f.lens];
  const run = (args: string[]) => watched(t, f, () => runCli(args, f.env, f.guard), { overlay: true });
  preview(await run(['plan', ...f.base(), ...opts]), 'conflict');
  const { analyzeDevKitModels } = await import('../src/devkit-models.ts');
  assert.deepEqual(analyzeDevKitModels(Buffer.from(line(routing(f.home)))), { status: 'invalid', reason: 'rule' });
  assert.deepEqual(analyzeDevKitModels(Buffer.from(line(routing(f.home, f.home)))), { status: 'recognized' });
  const got = await run([...f.args(), ...opts]);
  report(got, 0, complete(metadata([
    recognized(alpha, { nameSource: 'frontmatter', nameMatchesDirectory: false, manualOnly: true }),
    { path: nested, status: 'unsupported', reason: 'entry-location' },
    recognized(beta, { nameSource: 'frontmatter', nameMatchesDirectory: false }),
    { path: broken, status: 'invalid', reason: 'manual-only-invalid' },
  ], 1), discovery([
    candidate(alpha), { path: nested, status: 'shadowed' }, candidate(beta), notDiscovered(broken, 'metadata'),
  ], 'unverified', [[alpha, beta]]), [
    { path: devkit, status: 'recognized' }, { path: herdr, status: 'invalid', reason: 'shape' },
    { path: keys, status: 'recognized', actions: 2 },
  ]));
  for (const secret of [marker, 'shared-fixture-name', 'fixture-private', 'ctrl+c', 'app.interrupt', f.root, 'sha256:']) {
    assert.ok(!got.stdout.includes(secret) && !got.stderr.includes(secret), 'report exposed a fixture-only value');
  }
});

test('resource checks: nonempty winning skills selection changes discovery but not metadata', async t => {
  const entry = skillPath('sample');
  const f = fixture(t, () => ({ common: { files: [skill(entry)], settings: { skills: [] } },
    'platform:linux': { settings: { skills: [`+${skillPath(marker)}`] } } }));
  const { runCli } = await import('../src/cli.ts');
  report(await watched(t, f, () => runCli(f.args(), f.env, f.guard)), 0,
    complete(metadata([recognized(entry)]), discovery([notDiscovered(entry, 'settings')], 'unverified')));
});

test('resource checks: guarded preparation keeps fixed errors and checks approved bytes', async t => {
  const entry = 'keybindings.json';
  const f = fixture(t, () => ({ common: { files: [tool(entry, {})] } }));
  const { runCli } = await import('../src/cli.ts');
  const call = (args: string[]) => runCli(args, f.env, f.guard);
  const liveTarget = f.args().map(arg => arg === f.target ? path.join(f.home, '.pi', 'unused') : arg);
  const errors = [
    { args: liveTarget, expect: error('live-path-refused') },
    { args: [...f.args(), '--lens-config', f.lens], expect: error('lens-config-unused') },
  ];
  const priorMode = (args: string[]) => args.map(arg => arg === flag ? '--extension-imports' : arg);
  for (const { args, expect } of errors) {
    assert.deepEqual(await watched(t, f, () => call(priorMode(args))), expect);
  }
  const failBundleLookup = { failBundleLookup: true };
  report(await watched(t, f, () => call(priorMode(f.args())), failBundleLookup), 1,
    { ...unverified('filesystem-error'), mode: 'extension-imports' });
  const observed = [];
  for (const { args } of errors) observed.push(await watched(t, f, () => call(args)));
  observed.push(await watched(t, f, () => call(f.args()), failBundleLookup));
  const badEnv = { get HOME(): string { throw new Error(marker); } };
  observed.push(await watched(t, f, () => runCli(f.args(), badEnv, f.guard)));
  put(f.bundle, `config/common/files/agent/${entry}`, line({ [marker]: marker }));
  const digestMismatch = error('payload-digest-mismatch', 'common');
  assert.deepEqual(await watched(t, f, () => call(priorMode(f.args()))), digestMismatch);
  observed.push(await watched(t, f, () => call(f.args())));
  assert.deepEqual(observed, [...errors.map(({ expect }) => expect),
    { code: 1, stdout: line(unverified('filesystem-error')), stderr: '' },
    { code: 1, stdout: '', stderr: line({ ok: false, error: 'internal-error' }) }, digestMismatch]);
});

for (const [label, left, right] of [
  ['case-folded directory spellings', 'skills/Example/a.txt', 'skills/example/b.txt'],
  ['file/directory overlap', 'skills/example/guide.txt', 'skills/example/guide.txt/b.txt'],
] as const) {
  test(`resource checks: no partial report for merged ${label}`, async t => {
    const f = fixture(t, () => ({ common: { files: [skill(left, marker), skill(skillPath('ready'))] },
      'platform:linux': { files: [skill(right, marker), tool('keybindings.json', {})] } }));
    const { runCli } = await import('../src/cli.ts');
    const run = (args: string[]) => watched(t, f, () => runCli(args, f.env, f.guard));
    preview(await run(['plan', ...f.base()]), 'incomplete');
    report(await run(f.args()), 1, unverified('skill-namespace-conflict'));
  });
}

test('resource checks: 4096 winning rows complete; one extra row takes precedence over namespace conflict', async t => {
  const key = skillPath('rows');
  const notes = Array.from({ length: 4095 }, (_, i) =>
    skill(`skills/rows/notes-${Math.floor(i / 128)}/note-${i}.txt`, 'Ordinary resource note.\n'));
  const f = fixture(t, () => ({
    common: { files: [skill(key), ...notes] },
    'platform:darwin': { files: [skill(key)] }, // An exact replacement must not count as another winner.
    'platform:linux': { files: [skill('skills/Rows/extra.txt', 'Extra resource note.\n')] },
  }));
  const { runCli } = await import('../src/cli.ts');
  const run = (args: string[], platform: Platform) => watched(t, f, () => runCli(args, f.env, f.guard), { platform });
  for (const platform of ['darwin', 'linux'] as const) {
    preview(await run(['plan', ...f.base(platform)], platform), 'incomplete');
  }
  const at = await run(f.args('darwin'), 'darwin');
  const over = await run(f.args(), 'linux');
  report(at, 0, complete(metadata([recognized(key)]), discovery([candidate(key)])));
  report(over, 1, unverified('analysis-limit'));
});

test('Herdr fallback trim: ASCII spaces only and existing error precedence', async () => {
  const { analyzeHerdrConfig } = await import('../src/herdr-config.ts');
  const analyze = (record: object) => analyzeHerdrConfig(Buffer.from(line({ status: { enabled: true }, ...record })));
  const fallback = (value: string) => ({ models: { default: value } });
  const first = 'fixture/first', second = 'fixture/second';
  const valid = { status: 'recognized' };
  const syntax = { status: 'unsupported', reason: 'syntax' };
  assert.deepEqual(analyze(fallback(`   ${first} ,  ${second}   `)), valid);
  assert.deepEqual(analyze({ models: { agents: { helper: `   ${first} , ${second}  ` } } }), valid);
  assert.deepEqual(analyze(fallback(`   ${first} , ${first}  `)), { status: 'unsupported', reason: 'value' });
  assert.deepEqual(analyze({ models: { tasks: { coding: [` ${first}`] } } }), syntax);
  for (const whitespace of ['\u00a0', '\u2003', '\t', '\n', '\u007f']) {
    assert.deepEqual(analyze(fallback(` ${whitespace}${first} , ${second} `)), syntax);
    assert.deepEqual(analyze(fallback(` ${first}${whitespace}, ${second} `)), syntax);
    assert.deepEqual(analyze(fallback(` ${first}, ${second}${whitespace} `)), syntax);
  }
  const wrongValue = { herdr: { backend: 'unknown-fixture-mode' } };
  const wrongSyntax = fallback(`${first}\u00a0, ${second}`);
  assert.deepEqual(analyze(wrongValue), { status: 'invalid', reason: 'value' });
  assert.deepEqual(analyze({ ...wrongSyntax, ...wrongValue }), syntax);
  assert.deepEqual(analyze({ ...wrongValue, ...wrongSyntax }), syntax);

  // Several ordinary, distinct model paths near the upper end of their spelling range.
  const refs = Array.from({ length: 8 }, (_, i) => `fixture/organization/team/${'portable-model-'.repeat(10)}${i}`);
  assert.deepEqual(analyze(fallback(refs.map(ref => `   ${ref}  `).join(','))), valid);
  assert.deepEqual(analyze(fallback([...refs.slice(0, -1), `${refs.at(-1)} extra`].join(', '))), syntax);
});

test('skill metadata trim: preserve non-ASCII spaces, controls and syntax-before-duplicate precedence', async () => {
  const { analyzeSkillEntries } = await import('../src/skill-metadata.ts');
  const key = skillPath('sample');
  const analyze = (...lines: string[]) => analyzeSkillEntries([{ path: key, bytes: Buffer.from(frontmatter(...lines)) }]);
  const result = (row: object) => ({ status: 'complete', entries: [{ path: key, ...row }] });
  const syntax = result({ status: 'unsupported', reason: 'syntax' });
  const desc = 'description: Inert fixture description';
  assert.deepEqual(analyze(desc, 'name:    "sample"   ', 'disable-model-invocation:   true  '), {
    status: 'complete', entries: [recognized(key, { nameSource: 'frontmatter', manualOnly: true })],
  });
  assert.deepEqual(analyze(desc, 'name: sample\u00a0 '), {
    status: 'complete', entries: [recognized(key, { nameSource: 'frontmatter', nameValid: false, nameMatchesDirectory: false })],
  });
  assert.deepEqual(analyze('description: "\u00a0" '), result({ status: 'missing', reason: 'description-missing' }));
  assert.deepEqual(analyze(desc, 'name: "sample"', 'name: sample'), result({ status: 'invalid', reason: 'frontmatter-invalid' }));
  for (const trailing of ['\u00a0', '\u2003', '\t', '\u0085']) {
    const malformed = `description: "Inert description"${trailing} `;
    assert.deepEqual(analyze(desc, desc, malformed), syntax);
    assert.deepEqual(analyze(malformed, desc, desc), syntax);
  }
  const paragraph = 'A sample sentence for the fixture. '.repeat(35).trimEnd();
  assert.deepEqual(analyze(`description:    "${paragraph}"   `), {
    status: 'complete', entries: [recognized(key, { descriptionTooLong: true })],
  });
  assert.deepEqual(analyze(`description: "${paragraph}"\u00a0 `), syntax);
});
