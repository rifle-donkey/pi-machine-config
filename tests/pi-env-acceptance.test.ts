import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const catalog = ['node', 'npm', 'gh', 'git', 'uv', 'python3', 'brew', 'typescript-language-server'];
const remote = 'ssh://git@example.invalid/team/memory.git';
const machineKeys = {
  deviceId: 'destination-device', lastChangelogVersion: '2.0.0',
  extensionChangelogVersions: { 'fixture-extension': '2.0.0' },
};
const rawStream = 'PRIVATE-FAKE-SUBPROCESS-STREAM';
const globalPackage = {
  version: '4.5.6',
  resolved: 'https://registry.npmjs.org/@fixture/global/-/global-4.5.6.tgz',
};

// The launcher uses no inherited PATH, credentials, npm config, or Node options.
const trampoline = '#!/bin/sh\nexec "$FIX_NODE" "$FIX_SCRIPT" "$0" "$@"\n';
const fake = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const [exe, ...args] = process.argv.slice(2);
const tool = basename(exe), cwd = process.cwd(), home = process.env.HOME;
const agent = process.env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
const prefix = join(home, 'fake-global'), globalsFile = join(prefix, 'packages.json');
const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const save = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const event = (action, extra = {}) => appendFileSync(process.env.FIX_LOG,
  JSON.stringify({ tool, args, cwd, action, ...extra }) + '\n');
const print = (value) => console.log(value);
const [verb, ...rest] = args;
const global = args.includes('-g') || args.includes('--global');
if (tool === 'pi') {
  if (verb !== 'install' || rest.length !== 1) { event('pi-other'); process.exit(83); }
  const spec = rest[0];
  const [, name, version] = /^npm:((?:@[a-z]+\/)?[a-z0-9-]+)(?:@(\d+\.\d+\.\d+))?$/.exec(spec) || [];
  const settingsFile = join(agent, 'settings.json');
  const settings = read(settingsFile, null);
  const backupRoot = join(home, '.pi-env-backup');
  event('pi-install', { settings, otherFileReady: existsSync(join(agent, 'prompts', 'ready.md')),
    hasBackup: existsSync(backupRoot) && readdirSync(backupRoot).length > 0 });
  console.log('${rawStream}');
  console.error('${rawStream}');
  if (!(name in ${JSON.stringify({ 'pi-lens': true, '@fixture/filtered': true, 'fixture-tail': true })})) process.exit(84);
  if (existsSync(process.env.FIX_FAIL) && readFileSync(process.env.FIX_FAIL, 'utf8') === name) process.exit(19);
  const installed = { 'pi-lens': '1.2.3', '@fixture/filtered': '2.3.4', 'fixture-tail': '3.4.5' };
  save(join(agent, 'npm', 'node_modules', name, 'package.json'), { name, version: version || installed[name] });
  save(settingsFile, { ...settings, packages: [...settings.packages, spec] });
} else if (tool === 'npm') {
  if (args.includes('--version') || args.includes('-v')) { event('version'); print('10.8.2'); }
  else if (verb === 'ls' && global) { event('npm-list'); print(JSON.stringify({ dependencies: read(globalsFile, {}) })); }
  else if ((verb === 'prefix' && global) || (verb === 'config' && rest.includes('prefix'))) {
    event('npm-prefix'); print(prefix);
  } else if (verb === 'root' && global) { event('npm-root'); print(join(prefix, 'node_modules')); }
  else if (verb === 'install' && global) {
    event('npm-global-install');
    if (!args.includes('@fixture/global@4.5.6')) process.exit(85);
    save(globalsFile, { ...read(globalsFile, {}), '@fixture/global': ${JSON.stringify(globalPackage)} });
  } else if (verb === 'install' && cwd === join(home, '.pi-lens', 'tools')) {
    const pkg = read(join(cwd, 'package.json'), null);
    event('npm-lens-install', { manifest: pkg });
    for (const [name, version] of Object.entries(pkg?.dependencies ?? {})) {
      if (name !== 'fixture-lens-tool') process.exit(86);
      save(join(cwd, 'node_modules', name, 'package.json'), { name, version });
    }
  } else { event('npm-other'); process.exit(87); }
} else if (tool === 'git') {
  let repo = cwd;
  if (verb === '-C') repo = resolve(rest.shift());
  const command = verb === '-C' ? rest.shift() : verb;
  if (command === '--version' || command === '-v') { event('version'); print('git version 2.48.1'); }
  else if (command === 'clone') {
    event('git-clone');
    if (!rest.includes('${remote}')) process.exit(88);
    const path = resolve(repo, rest.at(-1) === '${remote}' ? 'memory' : rest.at(-1));
    if (path !== join(agent, 'memory') || existsSync(path)) process.exit(89);
    mkdirSync(path);
    writeFileSync(join(path, 'cloned.txt'), 'fake clone');
  } else if (existsSync(join(repo, '.git')) && command === 'remote') {
    event('git-probe');
    print(rest.includes('-v') ? 'origin\t${remote} (fetch)' : rest.includes('get-url') ? '${remote}' : 'origin');
  } else if (existsSync(join(repo, '.git')) && command === 'config') {
    event('git-probe'); print('${remote}');
  } else if (existsSync(join(repo, '.git')) && ['branch', 'symbolic-ref', 'rev-parse'].includes(command)) {
    event('git-probe'); print(rest.includes('--show-toplevel') ? repo : rest.includes('--is-inside-work-tree') ? 'true' : 'main');
  } else { event('git-other'); process.exit(90); }
} else if (tool === 'ps') {
  event('ps');
  if (existsSync(process.env.FIX_ACTIVE)) {
    const path = join(agent, 'bin', 'pi');
    const format = args.join(' ').replace(/=/g, '');
    print(format.includes('comm') ? (format.includes('args') ? '4242 pi ' + path : '4242 pi') : '4242 ' + path);
  }
} else if (${JSON.stringify(catalog)}.includes(tool)) {
  event('version');
  print(({ node: 'v24.1.0', gh: 'gh version 2.65.0', uv: 'uv 0.9.0', python3: 'Python 3.13.1',
    brew: 'Homebrew 4.6.1', 'typescript-language-server': '4.0.0' })[tool]);
} else { event('unexpected'); process.exit(91); }
`;

type ManifestFile = {
  root: 'agent' | 'pi-lens'; path: string; size: number; sha256: string; mode: number; templated: boolean;
};
type Event = {
  tool: string; action: string; args: string[]; cwd: string; otherFileReady?: boolean;
  hasBackup?: boolean; settings?: { packages: unknown[] }; manifest?: { private: boolean; dependencies: unknown };
};

function put(path: string, bytes: string | Buffer, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  chmodSync(path, mode);
}
function json(path: string, value: unknown) { put(path, JSON.stringify(value)); }
function readJson(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }
function mode(path: string) { return lstatSync(path).mode & 0o7777; }

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pi-env-qa-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  const bin = join(root, 'bin'), script = join(root, 'fake.mjs');
  put(script, fake);
  for (const name of [...catalog, 'ps', 'pi']) put(join(bin, name), trampoline, 0o700);
  // System tar is an archive utility, not a probe or installer. Expose no other system tools on PATH.
  const tar = ['/usr/bin/tar', '/bin/tar'].find(existsSync);
  if (tar) symlinkSync(tar, join(bin, 'tar'));
  function host(id: string, homeName: string, override: boolean) {
    const home = join(root, homeName), lens = join(home, '.pi-lens');
    const agent = override ? join(root, `${id}-custom-agent`) : join(home, '.pi', 'agent');
    const log = join(root, `${id}.jsonl`), fail = join(root, `${id}-fail`), active = join(root, `${id}-active`);
    const launcher = join(agent, 'bin', 'pi');
    const prefix = join(home, 'fake-global');
    put(launcher, trampoline, 0o700);
    json(join(agent, 'settings.json'), { packages: [] });
    json(join(prefix, 'packages.json'), { npm: { version: '10.8.2' } });
    const env = { HOME: home, ...(override ? { PI_CODING_AGENT_DIR: agent } : {}), PATH: bin,
      TMPDIR: root, LANG: 'C', FIX_NODE: process.execPath, FIX_SCRIPT: script, FIX_LOG: log,
      FIX_FAIL: fail, FIX_ACTIVE: active };
    function spawn(exe: string, args: string[]) {
      const result = spawnSync(exe, args, { env, cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 ** 20 });
      assert.ifError(result.error);
      assert.equal(result.signal, null, `${args[0]} terminated by a signal`);
      return { status: result.status, text: result.stdout + result.stderr };
    }
    return { home, lens, agent, prefix, launcher, fail, active, spawn,
      run: (...args: string[]) => spawn(process.execPath, [cli, ...args]),
      events: (): Event[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [],
    };
  }
  const source = host('source', 'source', true);
  const target = host('target', 'target "home\\path', true);
  const archive = join(root, 'fixture.tar.gz');
  return { root, bin, source, target, archive, defaultTarget: () => host('default', 'default-home', false) };
}

type Run = ReturnType<ReturnType<typeof fixture>['source']['run']>;
function exit(result: Run, expected: number, context: string) {
  assert.equal(result.status, expected, `${context}: ${result.text.slice(0, 240)}`);
}
function scan(f: ReturnType<typeof fixture>, ...args: string[]) {
  exit(f.source.run('scan', '--out', f.archive, ...args), 0, 'valid scan must publish the fixture archive');
  assert.equal(f.source.events().some((e) => e.tool === 'pi'), false, 'scan invoked Pi');
  assert.equal(mode(f.archive), 0o600);
  return tarEntries(f.archive);
}

// Read regular tar records independently of the product. Keep offsets for benign corruption cases.
function tarEntries(path: string) {
  const raw = gunzipSync(readFileSync(path), { maxOutputLength: 8 * 1024 * 1024 });
  const entries = new Map<string, { bytes: Buffer; start: number; data: number; end: number }>();
  const field = (header: Buffer, start: number, end: number) => header.toString('utf8', start, end).split('\0', 1)[0];
  let at = 0;
  for (; at + 512 <= raw.length;) {
    const header = raw.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 500);
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
    assert.ok(header[156] === 0 || header[156] === 48, `not a regular member: ${name}`);
    assert.ok(!entries.has(name), `duplicate member: ${name}`);
    const octal = field(header, 124, 136).trim();
    assert.match(octal, /^[0-7]+$/);
    const size = Number.parseInt(octal, 8), data = at + 512, end = data + Math.ceil(size / 512) * 512;
    assert.ok(end <= raw.length, `truncated member: ${name}`);
    entries.set(name, { bytes: raw.subarray(data, data + size), start: at, data, end });
    at = end;
  }
  assert.ok(at < raw.length && raw.subarray(at).every((byte) => byte === 0), 'missing tar terminator');
  assert.equal(entries.keys().next().value, 'manifest.json');
  const manifest = JSON.parse(entries.get('manifest.json')!.bytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1);
  return { manifest, entries, raw };
}

function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const rows: Record<string, string> = {};
  function visit(path: string, key: string) {
    const meta = lstatSync(path);
    if (meta.isSymbolicLink()) rows[key] = `link:${readlinkSync(path)}`;
    else if (meta.isDirectory()) {
      rows[key] = `dir:${mode(path)}`;
      for (const child of readdirSync(path)) visit(join(path, child), `${key}/${child}`);
    } else rows[key] = `${mode(path)}:${readFileSync(path).toString('base64')}`;
  }
  visit(root, '.');
  return rows;
}
function destination(f: ReturnType<typeof fixture>) {
  return [snapshot(f.target.home), snapshot(f.target.agent)];
}
function actions(events: Event[]) {
  return events.filter((e) => ['npm-global-install', 'pi-install', 'git-clone', 'npm-lens-install'].includes(e.action));
}
function localChecksOnly(events: Event[]) {
  for (const e of events) {
    assert.ok(['ps', 'version', 'npm-list', 'npm-prefix', 'npm-root', 'git-probe'].includes(e.action),
      `unexpected command during read-only operation: ${e.tool} ${e.args.join(' ')}`);
  }
}
function backup(f: ReturnType<typeof fixture>, oldBytes: Buffer) {
  const root = join(f.target.home, '.pi-env-backup');
  const match = Object.entries(snapshot(root)).find(([, value]) => value.split(':')[1] === oldBytes.toString('base64'));
  assert.ok(match, 'backup did not preserve original bytes');
  const path = join(root, match[0]);
  let privatePath = (mode(path) & 0o077) === 0;
  for (let dir = dirname(path); dir.startsWith(root); dir = dirname(dir)) privatePath ||= (mode(dir) & 0o011) === 0;
  assert.ok(privatePath, 'backup bytes are accessible to group or others');
  return path;
}

function packageFixture(f: ReturnType<typeof fixture>) {
  const { source, target } = f;
  const specs = { 'pi-lens': '1.2.3', '@fixture/filtered': '2.3.4', 'fixture-tail': '3.4.5' };
  const filtered = { source: 'npm:@fixture/filtered', extensions: ['extensions/fixture.ts'], skills: [] };
  const packages = ['npm:pi-lens', filtered, './local-package', 'npm:fixture-tail'];
  json(join(source.agent, 'settings.json'), { packages });
  json(join(source.agent, 'npm', 'package.json'), { private: true, dependencies: specs });
  const lock: Record<string, unknown> = { '': { dependencies: specs } };
  for (const [name, version] of Object.entries(specs)) {
    const path = `node_modules/${name}`;
    json(join(source.agent, 'npm', path, 'package.json'), { name, version });
    lock[path] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz` };
  }
  json(join(source.agent, 'npm', 'package-lock.json'), { lockfileVersion: 3, packages: lock });
  put(join(source.agent, 'local-package', 'README.md'), 'manual local package');
  put(join(source.agent, 'prompts', 'ready.md'), 'already written before Pi installs');
  put(join(source.agent, 'memory', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  put(join(source.agent, 'memory', '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`);
  put(join(source.agent, 'memory', 'untracked.md'), 'untracked memory bytes');
  json(join(source.prefix, 'packages.json'), { npm: { version: '10.8.2' }, '@fixture/global': globalPackage });
  json(join(source.lens, 'tools', 'package.json'), { private: true, dependencies: { 'fixture-lens-tool': '5.6.7' } });
  json(join(source.lens, 'tools', 'node_modules', 'fixture-lens-tool', 'package.json'), { name: 'fixture-lens-tool', version: '5.6.7' });
  json(join(target.agent, 'settings.json'), { packages: ['npm:@fixture/filtered', 'npm:destination-only'], ...machineKeys });
  return { packages, filtered };
}

test('fixture smoke: isolated PATH commands and launcher are executable', (t) => {
  const f = fixture(t);
  exit(f.target.spawn(join(f.bin, 'ps'), ['-eo', 'pid,args']), 0, 'fake ps');
  exit(f.target.spawn(join(f.bin, 'npm'), ['ls', '-g', '--depth=0', '--json']), 0, 'fake npm');
  exit(f.target.spawn(join(f.bin, 'git'), ['--version']), 0, 'fake git');
  exit(f.target.spawn(f.target.launcher, ['--version']), 83, 'fake launcher rejects probes');
  assert.deepEqual(f.target.events().map((e) => e.action), ['ps', 'npm-list', 'version', 'pi-other']);
});

test('A1/A2: scan stores only permitted regular files and checks stored byte metadata', (t) => {
  const f = fixture(t), { source } = f;
  const accepted = ['AGENTS.md', 'keybindings.json', 'models.json', 'sandbox.json', 'extensions/demo.ts',
    'skills/demo/SKILL.md', 'prompts/demo.md', 'themes/demo.json', 'dev-kit/models.json', 'herdr-agents/config.json'];
  for (const path of accepted) put(join(source.agent, path), path.endsWith('.json') ? '{}' : 'fixture\n');
  put(join(source.lens, 'config.json'), '{}');
  const ignored = ['auth.json', 'INGKA_PAT', 'models-store.json', '.npmrc', '.netrc', 'skills/demo/.env.local',
    'skills/demo/node_modules/demo/index.js', 'skills/demo/.git/config', 'skills/demo/run.log', 'skills/demo/run.jsonl',
    'skills/demo/run.lock', 'skills/demo/script.bak-copy', 'sessions/session.jsonl'];
  for (const path of ignored) put(join(source.agent, path), 'excluded fixture bytes');
  put(join(source.home, '.pi', 'agent', 'AGENTS.md'), 'wrong agent root');
  put(join(source.lens, 'notes.md'), 'not a lens config');
  put(join(source.agent, 'unknown.md'), 'unknown top-level bytes');
  put(join(source.agent, 'extra', 'approved.md'), 'explicit inclusion');
  put(join(source.agent, 'extra', 'excluded', 'nested.md'), 'exclude beats include');
  put(join(f.root, 'unused.txt'), 'ordinary non-captured bytes');
  symlinkSync(join(f.root, 'unused.txt'), join(source.agent, 'extensions', 'alias.ts'));
  linkSync(join(f.root, 'unused.txt'), join(source.agent, 'extensions', 'hardlink.ts'));
  const { manifest, entries } = scan(f, '--include', 'extra', '--include', '.npmrc',
    '--allow-secret', '.npmrc', '--exclude', 'extra/excluded');
  const expected = [...accepted, 'settings.json', 'extra/approved.md'].map((path) => `files/agent/${path}`);
  expected.push('files/pi-lens/config.json');
  assert.deepEqual([...entries.keys()].slice(1).sort(), expected.sort());
  assert.deepEqual((manifest.files as ManifestFile[]).map((e) => `files/${e.root}/${e.path}`).sort(), expected);
  for (const file of manifest.files as ManifestFile[]) {
    const { bytes } = entries.get(`files/${file.root}/${file.path}`)!;
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.mode, 0o600);
    assert.equal(file.templated, false);
  }
  assert.match(JSON.stringify(manifest.skipped), /unknown\.md/);
  for (const path of ['auth.json', 'INGKA_PAT', 'models-store.json', '.npmrc', '.netrc']) {
    assert.ok(!JSON.stringify(manifest.skipped).includes(path), `skipped report exposed ${path}`);
  }
  assert.equal(entries.get('files/agent/AGENTS.md')!.bytes.toString(), 'fixture\n');
});

test('A1/A3: secret content, oversize files and ambiguous templates block publication', (t) => {
  const f = fixture(t);
  const bad = 'extensions/demo.json', dummy = 'non-sensitive-fixture-placeholder';
  json(join(f.source.agent, bad), { password: dummy });
  const secret = f.source.run('scan', '--out', f.archive);
  exit(secret, 2, 'secret content');
  assert.ok(!existsSync(f.archive));
  assert.ok(secret.text.includes(bad), `secret diagnostic did not identify the file (usage only: ${secret.text.includes('usage')})`);
  assert.match(secret.text, /password|literal|secret/i);
  assert.ok(!secret.text.includes(dummy));
  put(join(f.source.agent, 'skills', 'large.md'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  exit(f.source.run('scan', '--out', f.archive, '--allow-secret', bad), 2, 'per-file size limit');
  assert.ok(!existsSync(f.archive));
  put(join(f.source.agent, 'prompts', 'ambiguous.md'), 'literal {{HOME}}');
  exit(f.source.run('scan', '--out', f.archive, '--exclude', 'skills', '--allow-secret', bad), 2, 'ambiguous template');
  assert.ok(!existsSync(f.archive));
  const { entries } = scan(f, '--exclude', 'skills', '--exclude', 'prompts', '--allow-secret', bad);
  assert.deepEqual(JSON.parse(entries.get(`files/agent/${bad}`)!.bytes.toString()), { password: dummy });
  assert.ok(!entries.has('files/agent/skills/large.md'));
});

test('A1/A6: malformed flags and paths, symlinked root, and occupied archive output are rejected', (t) => {
  const f = fixture(t);
  for (const [flag, value] of [
    ['--include', join(f.source.agent, 'settings.json')], ['--include', 'skills//fixture'],
    ['--exclude', 'skills/./fixture'], ['--include', 'skills/../settings.json'],
    ['--allow-secret', 'skills\\fixture'], ['--exclude', 'skills/line\nend'],
  ]) exit(f.source.run('scan', '--out', f.archive, flag, value), 2, `invalid path for ${flag}`);
  exit(f.source.run('scan', '--out'), 2, 'missing scan output value');
  exit(f.target.run('deploy', f.archive, '--unknown'), 2, 'unknown deploy option');
  assert.ok(!existsSync(f.archive));
  const moved = join(f.root, 'moved-source');
  mkdirSync(moved);
  put(join(moved, 'config.json'), '{}');
  symlinkSync(moved, f.source.lens);
  exit(f.source.run('scan', '--out', f.archive), 2, 'symlinked lens root');
  assert.ok(!existsSync(f.archive));
  rmSync(f.source.lens);
  put(f.archive, 'pre-existing non-archive');
  assert.notEqual(f.source.run('scan', '--out', f.archive).status, 0);
  assert.equal(readFileSync(f.archive, 'utf8'), 'pre-existing non-archive');
  rmSync(f.archive);
  scan(f);
});

test('A2: deploy rejects digest, membership and duplicate metadata errors before writes', (t) => {
  const f = fixture(t);
  put(join(f.source.agent, 'AGENTS.md'), 'ordinary fixture data');
  const { raw, entries } = scan(f);
  const file = entries.get('files/agent/AGENTS.md')!;
  const changed = Buffer.from(raw);
  changed[file.data] ^= 1;
  const missing = Buffer.concat([raw.subarray(0, file.start), raw.subarray(file.end)]);
  const duplicate = Buffer.concat([raw.subarray(0, entries.get('manifest.json')!.end), raw]);
  const before = destination(f);
  exit(f.target.run('deploy', f.archive), 0, 'valid archive preview control');
  for (const [name, variant] of [
    ['bad-digest', changed], ['missing-member', missing], ['duplicate-manifest', duplicate],
  ] as const) {
    const path = join(f.root, `${name}.tar.gz`);
    put(path, gzipSync(variant));
    for (const flags of [[], ['--yes']]) {
      exit(f.target.run('deploy', path, ...flags), 2, name);
      assert.deepEqual(destination(f), before);
    }
  }
  localChecksOnly(f.target.events());
});

test('A3/A4: preview is read-only; apply renders, preserves machine keys and backs up replacements', (t) => {
  const f = fixture(t), { source, target } = f;
  json(join(source.agent, 'settings.json'), {
    packages: [], theme: 'fixture', deviceId: 'source-device', lastChangelogVersion: '1.0.0',
    extensionChangelogVersions: { 'fixture-extension': '1.0.0' },
  });
  const note = `path=${source.home}/config\nneighbor=${source.home}-other/file\njoined=/prefix${source.home}/config\n`;
  put(join(source.agent, 'prompts', 'note.md'), note);
  put(join(source.agent, 'AGENTS.md'), 'identical bytes and mode');
  put(join(target.agent, 'AGENTS.md'), 'identical bytes and mode');
  const sameInode = lstatSync(join(target.agent, 'AGENTS.md')).ino;
  const binary = Buffer.concat([Buffer.from(`${source.home}/binary`), Buffer.from([0xff, 0x00])]);
  put(join(source.agent, 'extensions', 'data.bin'), binary);
  put(join(source.agent, 'skills', 'fixture', 'mode.sh'), '#!/bin/sh\n', 0o775);
  put(join(target.agent, 'skills', 'fixture', 'mode.sh'), '#!/bin/sh\n', 0o644);
  json(join(source.lens, 'config.json'), { paths: [`${source.home}/commands`, `${source.home}-other/a`] });
  json(join(target.lens, 'config.json'), { paths: ['old-value'] });
  const lensOld = readFileSync(join(target.lens, 'config.json'));
  json(join(target.agent, 'settings.json'), { packages: ['npm:destination-only'], ...machineKeys });
  const settingsOld = readFileSync(join(target.agent, 'settings.json'));
  put(join(source.agent, 'extra', 'approved.md'), 'explicit inclusion');
  json(join(source.lens, 'tools', 'package.json'), { private: true, dependencies: { 'fixture-lens-tool': '5.6.7' } });
  const { manifest, entries } = scan(f, '--include', 'extra/approved.md');
  const captured = JSON.parse(entries.get('files/agent/settings.json')!.bytes.toString());
  for (const key of Object.keys(machineKeys)) assert.ok(!(key in captured), `captured machine key: ${key}`);
  assert.equal(entries.get('files/agent/prompts/note.md')!.bytes.toString(), note.replace(source.home, '{{HOME}}'));
  assert.deepEqual(entries.get('files/agent/extensions/data.bin')!.bytes, binary);
  for (const [path, flag] of [['prompts/note.md', true], ['extensions/data.bin', false]] as const) {
    assert.equal((manifest.files as ManifestFile[]).find((file) => file.path === path)?.templated, flag);
  }
  const before = destination(f);
  const preview = target.run('deploy', f.archive);
  exit(preview, 0, 'preview');
  for (const label of [/\bcreate\b/i, /\bsame\b/i, /\breplace\b/i, /destination-only/]) assert.match(preview.text, label);
  assert.deepEqual(destination(f), before);
  assert.ok(target.events().some((e) => e.tool === 'ps'), 'no process preflight');
  localChecksOnly(target.events());
  const applied = target.run('deploy', f.archive, '--yes');
  exit(applied, 0, 'confirmed deployment');
  for (const label of [/\bcreate\b/i, /\bsame\b/i, /\breplace\b/i]) assert.match(applied.text, label);
  assert.equal(readFileSync(join(target.agent, 'prompts', 'note.md'), 'utf8'), note.replace(source.home, target.home));
  assert.equal(lstatSync(join(target.agent, 'AGENTS.md')).ino, sameInode);
  assert.deepEqual(readFileSync(join(target.agent, 'extensions', 'data.bin')), binary);
  const executable = mode(join(target.agent, 'skills', 'fixture', 'mode.sh'));
  assert.equal(executable & 0o100, 0o100);
  assert.equal(executable & 0o7022, 0);
  assert.deepEqual(readJson(join(target.lens, 'config.json')), { paths: [`${target.home}/commands`, `${source.home}-other/a`] });
  assert.deepEqual(readJson(join(target.agent, 'settings.json')), { packages: [], theme: 'fixture', ...machineKeys });
  assert.equal(readFileSync(join(target.agent, 'extra', 'approved.md'), 'utf8'), 'explicit inclusion');
  assert.ok(!existsSync(join(target.lens, 'tools')), 'lens tools require installed pi-lens');
  localChecksOnly(target.events());
  backup(f, lensOld);
  backup(f, settingsOld);
});

test('A3/A4/R5: preflight refuses missing launcher, active Pi and symlinked target parents', (t) => {
  const f = fixture(t), { target } = f;
  put(join(f.source.agent, 'extensions', 'demo.ts'), '// fixture');
  scan(f);
  const defaultTarget = f.defaultTarget();
  exit(defaultTarget.run('deploy', f.archive), 0, 'preview with default agent root');
  localChecksOnly(defaultTarget.events());
  const blocked = (context: string) => {
    const before = destination(f);
    const result = target.run('deploy', f.archive, '--yes');
    assert.notEqual(result.status, 0, context);
    assert.deepEqual(destination(f), before);
    localChecksOnly(target.events());
  };
  rmSync(target.launcher);
  blocked('missing local launcher despite a fake pi on PATH');
  put(target.launcher, trampoline, 0o700);
  put(target.active, 'active');
  blocked('active Pi');
  rmSync(target.active);
  const referent = join(f.root, 'symlink-referent');
  mkdirSync(referent);
  symlinkSync(referent, join(target.agent, 'extensions'));
  const before = snapshot(referent);
  blocked('symlinked target parent');
  assert.deepEqual(snapshot(referent), before);
});

test('A5/A6: install failure stops the plan; retry uses local evidence and keeps completed work', (t) => {
  const f = fixture(t), { target } = f;
  const { packages } = packageFixture(f);
  const { manifest, entries } = scan(f);
  for (const id of catalog) assert.ok(manifest.tools.some((tool: { id: string }) => tool.id === id), `missing tool: ${id}`);
  assert.ok(![...entries.keys()].some((name) => name.includes('/memory/') || name.includes('/npm/')));
  const old = readFileSync(join(target.agent, 'settings.json'));
  const before = destination(f);
  const preview = target.run('deploy', f.archive);
  exit(preview, 0, 'package preview');
  for (const label of [/\binstall\b/i, /\bmanual\b/i, /local-package/, /destination-only/, /2\.3\.4/]) assert.match(preview.text, label);
  assert.deepEqual(destination(f), before);
  localChecksOnly(target.events());
  put(target.fail, '@fixture/filtered');
  const failed = target.run('deploy', f.archive, '--yes');
  exit(failed, 1, 'fake Pi failure');
  assert.match(failed.text, /\.pi-env-backup/);
  assert.ok(!failed.text.includes(rawStream));
  const first = actions(target.events());
  assert.deepEqual(first.map((e) => e.action), ['npm-global-install', 'pi-install', 'pi-install']);
  assert.deepEqual(first.slice(1).map((e) => e.args), [['install', 'npm:pi-lens'], ['install', 'npm:@fixture/filtered']]);
  assert.equal(first[1].otherFileReady, true);
  assert.equal(first[1].hasBackup, true);
  assert.deepEqual(first[1].settings?.packages, []);
  const intermediate = readJson(join(target.agent, 'settings.json'));
  assert.deepEqual(intermediate.packages, ['npm:pi-lens']);
  assert.ok(!existsSync(join(target.agent, 'memory')));
  assert.ok(!existsSync(join(target.lens, 'tools', 'package.json')));
  const oldBackup = backup(f, old);
  const keptFile = join(target.agent, 'prompts', 'ready.md');
  const keptInode = lstatSync(keptFile).ino;
  rmSync(target.fail);
  let eventOffset = target.events().length;
  const retry = target.run('deploy', f.archive, '--yes');
  exit(retry, 0, 'retry after fake Pi failure');
  assert.ok(!retry.text.includes(rawStream));
  const later = actions(target.events().slice(eventOffset));
  assert.deepEqual(later.map((e) => e.action), ['pi-install', 'pi-install', 'git-clone', 'npm-lens-install']);
  assert.deepEqual(later.slice(0, 2).map((e) => e.args), [
    ['install', 'npm:@fixture/filtered'], ['install', 'npm:fixture-tail'],
  ]);
  assert.ok(later[2].args.includes(remote));
  assert.equal(later[3].cwd, join(target.lens, 'tools'));
  assert.equal(later[3].manifest?.private, true);
  assert.deepEqual(later[3].manifest?.dependencies, { 'fixture-lens-tool': '5.6.7' });
  assert.deepEqual(readJson(join(target.agent, 'settings.json')), { packages, ...machineKeys });
  assert.deepEqual(readFileSync(oldBackup), old);
  assert.equal(lstatSync(keptFile).ino, keptInode);
  const clone = join(target.agent, 'memory', 'cloned.txt');
  assert.equal(readFileSync(clone, 'utf8'), 'fake clone');
  put(clone, 'destination-owned content');
  eventOffset = target.events().length;
  exit(target.run('deploy', f.archive, '--yes'), 0, 'rerun complete deployment');
  assert.deepEqual(actions(target.events().slice(eventOffset)), []);
  assert.equal(readFileSync(clone, 'utf8'), 'destination-owned content');
  assert.deepEqual(readFileSync(oldBackup), old);
});

test('A5: pinning modifies only registry sources and preserves ordered resource filters', (t) => {
  const f = fixture(t);
  const { filtered } = packageFixture(f);
  scan(f);
  const applied = f.target.run('deploy', f.archive, '--yes', '--pin-versions');
  exit(applied, 0, 'pinned apply');
  assert.ok(!applied.text.includes(rawStream));
  const expected = ['npm:pi-lens@1.2.3', 'npm:@fixture/filtered@2.3.4', 'npm:fixture-tail@3.4.5'];
  assert.deepEqual(actions(f.target.events()).filter((e) => e.action === 'pi-install').map((e) => e.args[1]), expected);
  assert.deepEqual(readJson(join(f.target.agent, 'settings.json')).packages,
    [expected[0], { ...filtered, source: expected[1] }, './local-package', expected[2]]);
});
