/** Independent metadata-only preflight QA. Integrate as tests/preflight-acceptance.test.ts. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import projectPackage from '../package.json' with { type: 'json' };
import { main, type CliOutput } from '../src/cli.ts';
import type { GuardContext } from '../src/fsafe.ts';
import { DISCOVERY_MODEL } from '../src/schema.ts';

const PI = '@earendil-works/pi-coding-agent';
const modelVersion = DISCOVERY_MODEL.replace(/^pi@/, '');
const npmVersion = '12.0.0-rc.0.x-01+build.007';
const sentinel = 'fixture-metadata-not-for-output';
const engine = /^>=(\d+)$/.exec(projectPackage.engines.node);
assert.ok(engine, 'update the baseline oracle if the engines.node policy changes');
const runtimeVersion = process.versions.node;
const baselineMet = Number(runtimeVersion.split('.')[0]) >= Number(engine[1]);

type Env = Record<string, string | undefined>;
type PackageCheck = {
  status: 'not-checked' | 'reported' | 'missing' | 'invalid' | 'protected-location';
  version: string | null;
};
const unchecked: PackageCheck = { status: 'not-checked', version: null };
const missing: PackageCheck = { status: 'missing', version: null };
const invalid: PackageCheck = { status: 'invalid', version: null };
const protectedLocation: PackageCheck = { status: 'protected-location', version: null };
const reported = (version: string): PackageCheck => ({ status: 'reported', version });

function fixture(t: TestContext) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-preflight-qa-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = fs.realpathSync(temp);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const guard: GuardContext = { home };
  return { root, guard };
}
type Fixture = ReturnType<typeof fixture>;

function manifest(dir: string, contents: string | Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, contents);
  return file;
}
function metadata(name: unknown, version: unknown): string {
  return JSON.stringify({ name, version, description: sentinel, scripts: { install: sentinel } });
}

// Operate only through main. Boundary traps record attempts even if the CLI catches the throw.
function run(f: Fixture, args: string[] = [], env: Env = {}, guard: GuardContext = f.guard) {
  const spies: { mock: { calls: readonly unknown[]; restore(): void } }[] = [];
  const forbid = () => { throw new Error('unexpected external operation in fixture test'); };
  try {
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
      spies.push(mock.method(childProcess, key, forbid));
    }
    spies.push(mock.method(process, 'kill', forbid));
    spies.push(mock.method(globalThis, 'fetch', forbid));
    spies.push(mock.method(net.Socket.prototype, 'connect', forbid));
    for (const client of [http, https]) {
      spies.push(mock.method(client, 'request', forbid), mock.method(client, 'get', forbid));
    }
    spies.push(mock.method(dns, 'lookup', forbid), mock.method(dns, 'resolve', forbid));
    syncBuiltinESMExports();
    return main(['preflight', ...args], env, guard);
  } finally {
    try {
      assert.equal(spies.reduce((n, spy) => n + spy.mock.calls.length, 0), 0, 'no process or network calls');
    } finally {
      for (const spy of spies.reverse()) spy.mock.restore();
      syncBuiltinESMExports();
    }
  }
}

// Observe host boundaries, not preflight helpers or the order/count of permitted operations.
function traceFs<T>(fn: () => T) {
  const lookup = mock.method(fs.realpathSync, 'native');
  const paths = ['lstatSync', 'statSync', 'accessSync', 'existsSync', 'readlinkSync', 'opendirSync', 'readdirSync'] as const;
  const bodies = ['readFileSync', 'openSync'] as const;
  const pathSpies = paths.map(key => mock.method(fs, key));
  const bodySpies = bodies.map(key => mock.method(fs, key));
  const writes = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'unlinkSync',
    'rmSync', 'rmdirSync', 'chmodSync', 'truncateSync', 'writeSync', 'ftruncateSync', 'fsyncSync'] as const;
  const writeSpies = writes.map(key => mock.method(fs, key, () => { throw new Error('unexpected fixture write'); }));
  const spies = [lookup, ...pathSpies, ...bodySpies, ...writeSpies];
  syncBuiltinESMExports();
  try {
    const result = fn();
    assert.equal(writeSpies.reduce((n, spy) => n + spy.mock.calls.length, 0), 0, 'no write API calls');
    const targets = (spy: { mock: { calls: readonly { arguments: readonly unknown[] }[] } }) =>
      spy.mock.calls.map(call => call.arguments[0]);
    return { result, paths: [lookup, ...pathSpies, ...bodySpies].flatMap(targets),
      bodies: bodySpies.flatMap(targets) };
  } finally {
    for (const spy of spies.reverse()) spy.mock.restore();
    syncBuiltinESMExports();
  }
}

function expectReport(r: CliOutput, npm: PackageCheck = unchecked, pi: PackageCheck = unchecked) {
  const passed = (tool: PackageCheck) => tool.status === 'reported' || tool.status === 'not-checked';
  const ok = baselineMet && passed(npm) && passed(pi);
  assert.equal(r.stderr, '');
  assert.equal(r.code, ok ? 0 : 1);
  const body = JSON.parse(r.stdout);
  // Accept the usual Node version spelling with or without the leading `v`.
  const nodeVersions = [runtimeVersion, `v${runtimeVersion}`];
  assert.ok(nodeVersions.includes(body.node?.version), 'report the running Node version');
  assert.deepEqual(body, {
    ok, command: 'preflight',
    node: { version: body.node.version, status: baselineMet ? 'baseline-met' : 'below-baseline' },
    npm,
    pi: { ...pi, discoveryModel: DISCOVERY_MODEL, modelStatus: pi.status !== 'reported' ? null :
      pi.version === modelVersion ? 'match' : 'discovery-model-stale' },
  });
}

function expectError(r: CliOutput, code: 1 | 2, error?: string, rejected?: string) {
  assert.equal(r.code, code);
  assert.equal(r.stdout, '');
  const body = JSON.parse(r.stderr);
  if (error !== undefined) {
    assert.deepEqual(body, { ok: false, error });
  } else {
    // The design leaves the requireAbsolute error identifier unspecified.
    assert.match(body.error, /^[a-z][a-z0-9-]*$/);
    assert.deepEqual(body, { ok: false, error: body.error });
    if (rejected) assert.ok(!r.stderr.includes(rejected));
  }
}

const npmFlag = (dir: string) => ['--npm-package', dir];
const piFlag = (dir: string) => ['--pi-package', dir];

test('no package flags: running Node versus engines.node; no protected-root or package lookup', t => {
  const f = fixture(t);
  const trace = traceFs(() => run(f, [], { HOME: 'relative-home', PI_CODING_AGENT_DIR: 'relative-agent' },
    { home: 'unavailable-home' }));
  expectReport(trace.result);
  assert.deepEqual(trace.paths, []);
});

test('npm only: validated SemVer, no Pi check', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  manifest(npm, metadata('npm', npmVersion));
  expectReport(run(f, npmFlag(npm)), reported(npmVersion));
});

for (const suffix of ['', '-rc.0', '+local.001']) {
  test(`Pi only: exact discovery comparison (${suffix || 'no suffix'})`, t => {
    const f = fixture(t);
    const pi = path.join(f.root, 'pi');
    const version = `${modelVersion}${suffix}`;
    manifest(pi, metadata(PI, version));
    expectReport(run(f, piFlag(pi)), unchecked, reported(version));
  });
}

test('both flags, Pi first: both versions reported; 64-character version is accepted', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  const pi = path.join(f.root, 'pi');
  const version = `0.0.0+${'a'.repeat(58)}`;
  assert.equal(version.length, 64);
  manifest(npm, metadata('npm', version));
  manifest(pi, metadata(PI, modelVersion));
  expectReport(run(f, [...piFlag(pi), ...npmFlag(npm)]), reported(version), reported(modelVersion));
});

test('both flags: independent statuses even when the first package fails', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  const pi = path.join(f.root, 'pi');
  manifest(pi, metadata(PI, modelVersion));
  expectReport(run(f, [...npmFlag(npm), ...piFlag(pi)]), missing, reported(modelVersion));
  manifest(npm, metadata('npm', npmVersion));
  manifest(pi, metadata('npm', modelVersion));
  expectReport(run(f, [...npmFlag(npm), ...piFlag(pi)]), reported(npmVersion), invalid);
});

test('malformed invocation wins over unusable protected roots and never looks up a supplied path', t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'candidate');
  const badEnv = { HOME: 'relative-home' };
  const badGuard = { home: 'unavailable-home' };
  for (const args of [
    ['--npm-package'], ['--pi-package', '--npm-package', dir], ['--unknown', dir],
    [...npmFlag(dir), ...npmFlag(dir)], [...piFlag(dir), ...piFlag(dir)], ['positional'],
    ['--gh-package', dir], ['--state-dir', dir],
  ]) {
    const trace = traceFs(() => run(f, args, badEnv, badGuard));
    expectError(trace.result, 2, 'usage');
    assert.deepEqual(trace.paths, []);
  }
  for (const rejected of ['relative-path-fixture', '', `${dir}\0extra`]) {
    for (const args of [[...npmFlag(dir), ...piFlag(rejected)], npmFlag(rejected)]) {
      const trace = traceFs(() => run(f, args, badEnv, badGuard));
      expectError(trace.result, 2, undefined, rejected);
      assert.deepEqual(trace.paths, []);
    }
  }
  // Positive routing control: an unregistered command would also reject all bad invocations.
  expectError(run(f, npmFlag(dir), {}, badGuard), 1, 'home-unavailable');
});

test('F1: global protected-root setup errors use stderr; no supplied manifest is read', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  manifest(npm, metadata('npm', npmVersion));
  const dangling = path.join(f.root, 'dangling-root');
  fs.symlinkSync(path.join(f.root, 'absent'), dangling);
  const cases: [Env, GuardContext, string][] = [
    [{ HOME: 'relative-home' }, f.guard, 'live-location-unavailable'],
    [{ PI_CODING_AGENT_DIR: dangling }, f.guard, 'live-location-unavailable'],
    [{}, { home: 'unavailable-home' }, 'home-unavailable'],
  ];
  for (const [env, guard, error] of cases) {
    const trace = traceFs(() => run(f, npmFlag(npm), env, guard));
    expectError(trace.result, 1, error);
    assert.deepEqual(trace.bodies, []);
  }
});

test('F1: missing directory, missing ancestors and missing manifest use stdout missing', t => {
  const f = fixture(t);
  const empty = path.join(f.root, 'empty');
  fs.mkdirSync(empty);
  expectReport(run(f, [...npmFlag(path.join(f.root, 'absent')), ...piFlag(empty)]), missing, missing);
  expectReport(run(f, piFlag(path.join(f.root, 'absent', 'nested'))), unchecked, missing);
});

test('F1: raw protected descendants, including absent paths, are refused before candidate lookup', t => {
  const f = fixture(t);
  const otherHome = path.join(f.root, 'env-home');
  const agentEnv = path.join(f.root, 'override');
  const env = { HOME: otherHome, PI_CODING_AGENT_DIR: agentEnv };
  for (const root of [path.join(f.guard.home, '.pi'), path.join(otherHome, '.pi'),
    path.join(f.guard.home, '.pi-lens'), path.join(otherHome, '.pi-lens'), agentEnv]) {
    const present = path.join(root, 'present');
    manifest(present, metadata('npm', npmVersion));
    for (const dir of [present, path.join(root, 'absent')]) {
      const trace = traceFs(() => run(f, npmFlag(dir), env));
      expectReport(trace.result, protectedLocation);
      assert.ok(!trace.paths.some(p => typeof p === 'string' && (p === dir || p.startsWith(`${dir}/`))),
        'do not look up the raw package candidate or its manifest');
      assert.deepEqual(trace.bodies, []);
    }
  }
});

test('F1: canonical protected target and positive control through symlinked ancestors', t => {
  const f = fixture(t);
  const protectedRoot = path.join(f.guard.home, '.pi');
  const outside = path.join(f.root, 'outside');
  const protectedFile = manifest(path.join(protectedRoot, 'pkg'), metadata(PI, modelVersion));
  const outsideFile = manifest(path.join(outside, 'pkg'), metadata(PI, modelVersion));
  const intoLive = path.join(f.root, 'live-alias');
  const intoOutside = path.join(f.root, 'outside-alias');
  fs.symlinkSync(protectedRoot, intoLive);
  fs.symlinkSync(outside, intoOutside);
  const trace = traceFs(() => run(f, piFlag(path.join(intoLive, 'pkg'))));
  expectReport(trace.result, unchecked, protectedLocation);
  assert.deepEqual(trace.bodies, []);
  assert.ok(!trace.paths.includes(protectedFile) && !trace.paths.includes(path.join(intoLive, 'pkg', 'package.json')));
  expectReport(run(f, piFlag(path.join(intoOutside, 'pkg'))), unchecked, reported(modelVersion));
  // The guard must also know the canonical destination of an environment-selected root.
  const fromEnv = traceFs(() => run(f, piFlag(path.join(outside, 'pkg')), { PI_CODING_AGENT_DIR: intoOutside }));
  expectReport(fromEnv.result, unchecked, protectedLocation);
  assert.deepEqual(fromEnv.bodies, []);
  assert.ok(!fromEnv.paths.includes(outsideFile));
});

test('F1: existing wrong type, final symlink, dangling symlink and hard-linked manifest are invalid', t => {
  const f = fixture(t);
  const regular = path.join(f.root, 'regular');
  const file = manifest(regular, metadata('npm', npmVersion));
  const rootLink = path.join(f.root, 'root-link');
  fs.symlinkSync(regular, rootLink);
  const dangling = path.join(f.root, 'dangling');
  fs.symlinkSync(path.join(f.root, 'absent'), dangling);
  const dirManifest = path.join(f.root, 'dir-manifest');
  fs.mkdirSync(path.join(dirManifest, 'package.json'), { recursive: true });
  const linkedManifest = path.join(f.root, 'linked-manifest');
  fs.mkdirSync(linkedManifest);
  fs.symlinkSync(file, path.join(linkedManifest, 'package.json'));
  const danglingManifest = path.join(f.root, 'dangling-manifest');
  fs.mkdirSync(danglingManifest);
  fs.symlinkSync(path.join(f.root, 'absent'), path.join(danglingManifest, 'package.json'));
  const hardManifest = path.join(f.root, 'hard-manifest');
  fs.mkdirSync(hardManifest);
  fs.linkSync(file, path.join(hardManifest, 'package.json'));
  for (const dir of [file, rootLink, dangling, dirManifest, linkedManifest, danglingManifest, hardManifest]) {
    const trace = traceFs(() => run(f, npmFlag(dir)));
    expectReport(trace.result, invalid);
    assert.deepEqual(trace.bodies, []);
  }
});

test('F1: non-missing filesystem denial is invalid, not a global failure or missing', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  const file = manifest(npm, metadata('npm', npmVersion));
  const original = fs.openSync;
  let denied = false;
  const spy = mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === file) {
      denied = true;
      throw Object.assign(new Error(sentinel), { code: 'EACCES' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    expectReport(run(f, npmFlag(npm)), invalid);
    assert.ok(denied, 'reach the injected denial');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('F1: 64 KiB manifest limit is inclusive and measured in bytes', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  const base = metadata('npm', npmVersion);
  const prefix = `${base.slice(0, -1)},"note":"é`;
  const exact = `${prefix}${'a'.repeat(65536 - Buffer.byteLength(prefix) - 2)}"}`;
  assert.equal(Buffer.byteLength(exact), 65536);
  manifest(npm, exact);
  expectReport(run(f, npmFlag(npm)), reported(npmVersion));
  manifest(npm, `${exact} `);
  expectReport(run(f, npmFlag(npm)), invalid);
});

for (const [name, body] of Object.entries({
  'wrong package name': metadata('NPM', npmVersion),
  'non-string name': metadata(['npm'], npmVersion),
  'non-string version': metadata('npm', 5),
  'missing version': '{"name":"npm"}',
  'missing name': '{"version":"1.2.3"}',
  'wrong top-level type': '[{"name":"npm","version":"1.2.3"}]',
  'malformed JSON': '{"name":"npm",',
  'duplicate consumed key': '{"name":"npm","name":"npm","version":"1.2.3"}',
  'duplicate ignored key': '{"name":"npm","version":"1.2.3","other":{"a":0,"a":1}}',
  'unsafe object key': '{"name":"npm","version":"1.2.3","other":{"constructor":0}}',
  'unsafe ignored number': '{"name":"npm","version":"1.2.3","other":9007199254740992}',
  'BOM': `\ufeff${metadata('npm', npmVersion)}`,
  'malformed UTF-8': Buffer.concat([Buffer.from('{"name":"npm","version":"1.2.3","note":"'),
    Buffer.from([0xff]), Buffer.from('"}')]),
})) {
  test(`F1: invalid metadata (${name})`, t => {
    const f = fixture(t);
    const npm = path.join(f.root, 'npm');
    manifest(npm, body);
    expectReport(run(f, npmFlag(npm)), invalid);
  });
}

for (const [name, version] of Object.entries({
  'only two components': '1.2', 'non-SemVer prefix': 'v1.2.3', 'leading zero in core': '01.2.3',
  'leading zero in numeric prerelease': '1.2.3-rc.01', 'empty prerelease identifier': '1.2.3-rc..1',
  'empty build suffix': '1.2.3+', 'leading whitespace': ' 1.2.3', 'trailing newline': '1.2.3\n',
  'non-ASCII identifier': '1.2.3+é', '65 characters': `1.2.3+${'a'.repeat(59)}`,
})) {
  test(`F1: invalid SemVer (${name})`, t => {
    const f = fixture(t);
    const pi = path.join(f.root, 'pi');
    manifest(pi, metadata(PI, version));
    expectReport(run(f, piFlag(pi)), unchecked, invalid);
  });
}

test('only supplied manifest bodies: no PATH search, state/bundle reads, or fixture changes', t => {
  const f = fixture(t);
  const npm = path.join(f.root, 'npm');
  const file = manifest(npm, metadata('npm', npmVersion));
  const bin = path.join(f.root, 'bin');
  const managed = path.join(f.guard.home, '.pi', 'agent');
  const canaries = [path.join(npm, 'index.js'), path.join(npm, 'bundle', 'package.json'),
    path.join(f.guard.home, 'state', 'journal.json'), path.join(managed, 'settings.json'),
    ...['node', 'npm', 'pi', 'gh'].map(name => path.join(bin, name))];
  for (const canary of canaries) {
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, sentinel); // inert, non-executable files
  }
  manifest(managed, metadata(PI, modelVersion));
  function snapshot(dir: string): unknown {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      const p = path.join(dir, entry.name);
      const st = fs.lstatSync(p, { bigint: true });
      return [entry.name, st.ino, st.mode, st.mtimeNs, st.ctimeNs,
        entry.isDirectory() ? snapshot(p) : fs.readFileSync(p)];
    });
  }
  const before = snapshot(f.root);
  const env = { HOME: f.guard.home, PATH: bin, PI_CODING_AGENT_DIR: managed };
  const trace = traceFs(() => run(f, npmFlag(npm), env));
  expectReport(trace.result, reported(npmVersion));
  assert.ok(trace.bodies.includes(file), 'read the supplied manifest');
  assert.ok(trace.bodies.every(p => p === file), 'no unrelated file body reads');
  assert.ok(!trace.paths.some(p => typeof p === 'string' && (p === bin || p.startsWith(`${bin}/`))),
    'do not look up executable candidates in PATH');
  assert.deepEqual(snapshot(f.root), before);
});

test('CLI help lists preflight and keeps existing command entries', t => {
  const f = fixture(t);
  const r = main(['--help'], {}, f.guard);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /\bpreflight\b[^\n]*--npm-package[^\n]*--pi-package/);
  for (const command of ['capture-review', 'capture', 'plan', 'apply', 'rollback', 'recover']) {
    assert.match(r.stdout, new RegExp(`\\b${command} --`));
  }
});

test('existing capture-review works offline; package flags are not shared and gh stays manual', t => {
  const f = fixture(t);
  const policy = path.join(f.root, 'policy.json');
  const agent = path.join(f.root, 'source');
  fs.mkdirSync(agent);
  fs.writeFileSync(path.join(agent, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(policy, JSON.stringify({
    schemaVersion: 1, kind: 'pi-machine-config/inclusion',
    layers: { common: { settings: ['theme'] }, 'platform:linux': {} },
  }));
  const args = ['capture-review', '--policy', policy, '--source-agent', agent, '--platform', 'linux'];
  const env = { PATH: path.join(f.root, 'empty-path') };
  const r = main(args, env, f.guard);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const result = JSON.parse(r.stdout);
  assert.equal(result.command, 'capture-review');
  assert.match(result.captureReviewToken, /^sha256:[0-9a-f]{64}$/);
  expectError(main([...args, ...npmFlag(agent)], env, f.guard), 2, 'usage');
  expectError(main(['gh'], env, f.guard), 2, 'usage');
});
