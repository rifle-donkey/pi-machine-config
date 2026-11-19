/** Independent doctor CLI QA; integrate as tests/doctor-acceptance.test.ts. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture, captureReview } from '../src/capture.ts';
import { main, type CliOutput } from '../src/cli.ts';
import { failure } from '../src/errors.ts';
import { parseJsonBytes } from '../src/json.ts';
import { plan } from '../src/plan.ts';
import { restoreFromPlan } from '../src/restore.ts';
import { DISCOVERY_MODEL, type Platform } from '../src/schema.ts';

const bootId = '11111111-2222-4333-8444-555555555555';
const bootPath = '/proc/sys/kernel/random/boot_id';
const ownerPid = 4000201;
const hostname = 'fixture-host';
const privateText = 'synthetic-private-doctor-marker';
const uid = process.getuid?.() ?? 0; // Owner of the temporary fixture files, not a lock-owner probe.
type Env = Record<string, string | undefined>;

function fixture(t: TestContext, platform: Platform = 'darwin', useOverlay = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-doctor-qa-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = fs.realpathSync(temp);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  const policy = path.join(root, 'policy.json');
  const bundle = path.join(root, 'bundle');
  const target = path.join(root, 'target');
  const state = path.join(root, 'state');
  const fakeBoot = path.join(root, 'fake-boot-id');
  fs.writeFileSync(fakeBoot, `${bootId}\n`);
  fs.mkdirSync(home);
  fs.mkdirSync(source);
  const guard = { home };
  const env: Env = {};
  const captureBundle = (out: string, text: string, incomplete = false) => {
    fs.writeFileSync(path.join(source, 'AGENTS.md'), `${text}\n`);
    fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ defaultModel: privateText,
      ...(incomplete ? { prompts: ['prompts/not-approved.md'] } : {}) }));
    fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: {
      settings: incomplete ? ['defaultModel', 'prompts'] : ['defaultModel'],
      files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }],
    } } }));
    const input = { policy, sourceAgent: source, platform, env, guard };
    const review = captureReview(input);
    capture({ ...input, out, approveInclusion: review.captureReviewToken });
    return out;
  };
  captureBundle(bundle, privateText);
  const overlay = useOverlay ? path.join(root, 'overlay') : undefined;
  if (overlay) {
    fs.mkdirSync(overlay);
    fs.writeFileSync(path.join(overlay, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
      layer: 'overlay', piDiscoveryModel: DISCOVERY_MODEL, files: [], packages: [], settings: {} }));
  }
  const options = { bundle, targetAgent: target, platform, env, guard, overlay };
  const preview = plan(options);
  assert.equal(preview.status, 'ready');
  assert.ok(preview.approvalToken);
  const applied = restoreFromPlan({ ...options, stateDir: state, approveActivation: preview.approvalToken,
    deps: { platform, bootId: () => bootId, hostname: () => hostname, uid: () => uid,
      pid: () => ownerPid, probePid: () => assert.fail('unexpected fixture setup PID query') } });
  assert.equal(applied.status, 'applied');
  const { tx } = applied;
  const wrongTx = `${tx[0] === '0' ? '1' : '0'}${tx.slice(1)}`;
  const args = (overrides: Partial<Record<'bundle' | 'platform' | 'target-agent' | 'state-dir' | 'tx' | 'overlay' | 'lens-config', string | null>> = {}) => {
    const values = { bundle, platform, 'target-agent': target, 'state-dir': state, tx, overlay, ...overrides };
    return ['doctor', ...Object.entries(values).flatMap(([k, v]) => v == null ? [] : [`--${k}`, v])];
  };
  const locks = { state: path.join(state, 'lock.json'), gate: path.join(state, 'recovery-gate.json'),
    target: path.join(target, '.pi-machine-config-lock') };
  const putLock = (role: keyof typeof locks, kind = 'pi-machine-config/lock') => {
    fs.writeFileSync(locks[role], JSON.stringify({ kind, schemaVersion: 1, role, tx, pid: ownerPid, uid,
      hostname, bootId, platform }), { mode: 0o600 });
    fs.chmodSync(locks[role], 0o600);
  };
  return { root, guard, env, bundle, target, state, platform, fakeBoot, args, locks, putLock, wrongTx, captureBundle,
    journal: path.join(state, 'journal.json'), attempt: path.join(state, 'package-attempt.json'),
    ledger: path.join(state, 'package-ledger.json'), tracked: path.join(target, 'AGENTS.md') };
}
type Fixture = ReturnType<typeof fixture>;

// Preserve names, bytes, identity and metadata. Reads may change atime; only atime is omitted.
function snapshot(root: string) {
  const entries = new Map<string, unknown>();
  function visit(p: string) {
    const st = fs.lstatSync(p, { bigint: true });
    const { dev, ino, mode, uid, gid, nlink, size, rdev, blksize, blocks, birthtimeNs, mtimeNs, ctimeNs } = st;
    const contents = st.isFile() ? fs.readFileSync(p) : st.isSymbolicLink() ? fs.readlinkSync(p) : null;
    entries.set(path.relative(root, p), { dev, ino, mode, uid, gid, nlink, size, rdev, blksize, blocks, birthtimeNs, mtimeNs, ctimeNs, contents });
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name));
  }
  visit(root);
  return entries;
}

const pathArg = (p: unknown) => typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? fileURLToPath(p) : '';
const under = (p: string, root: string) => p === root || p.startsWith(`${root}${path.sep}`);
type Watch = { noBodies?: string[]; noList?: string[]; failLockStat?: string; env?: Env; control?: true };

// Trap at Node's APIs, not at doctor internals. Count before throwing, so a caught
// exception cannot hide an attempted write, prohibited read or probe.
function run(f: Fixture, args: string[], watch: Watch = {}) {
  const before = snapshot(f.root);
  const denied: string[] = [];
  const reads: string[] = [];
  const observations = { subprocess: 0, bootRead: 0, pid: 0 };
  const spies: { mock: { restore(): void } }[] = [];
  const deny = (api: string): never => { denied.push(api); throw new Error(privateText); };
  const open = fs.openSync;
  const readFile = fs.readFileSync;
  const opendir = fs.opendirSync;
  const readdir = fs.readdirSync;
  const lstat = fs.lstatSync;
  const procPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const noBodies = [...(watch.control ? [] : Object.values(f.locks)), ...(watch.noBodies ?? [])];
  const body = (api: string, p: string) => {
    reads.push(p);
    if (!under(p, f.root) || noBodies.some((root) => under(p, root))) deny(api);
  };
  const checkOpen = (p: fs.PathLike, flags: fs.OpenMode = 'r') => {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    const writeFlags = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND;
    if (typeof flags === 'number' ? (flags & writeFlags) !== 0 : !['r', 'rs', 'sr'].includes(flags)) deny('writable open');
    if (pathArg(p) === bootPath) {
      observations.bootRead++;
      if (!watch.control || f.platform !== 'linux') deny('boot identity read');
      return f.fakeBoot;
    }
    body('file open', pathArg(p));
    return p;
  };
  try {
    Object.defineProperty(process, 'platform', { ...procPlatform, value: f.platform });
    for (const key of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
      spies.push(mock.method(childProcess, key, () => deny(key)));
    }
    spies.push(mock.method(childProcess, 'spawnSync', (file: string, argv: string[]) => {
      observations.subprocess++;
      if (!watch.control || f.platform !== 'darwin' || file !== '/usr/sbin/sysctl' ||
          !Array.isArray(argv) || argv.join(' ') !== '-n kern.bootsessionuuid') deny('subprocess');
      return { status: 0, stdout: Buffer.from(`${bootId}\n`) };
    }));
    spies.push(mock.method(process, 'kill', (pid: number, signal: number) => {
      observations.pid++;
      if (!watch.control || pid !== ownerPid || signal !== 0) deny('PID or process-group query');
      throw Object.assign(new Error(privateText), { code: 'ESRCH' }); // Fake stale owner.
    }));
    spies.push(mock.method(os, 'hostname', () => hostname), mock.method(os, 'userInfo', () => deny('account lookup')),
      mock.method(net.Socket.prototype, 'connect', () => deny('network connect')),
      mock.method(globalThis, 'fetch', () => deny('fetch')));
    for (const key of ['lookup', 'resolve'] as const) {
      spies.push(mock.method(dns, key, () => deny(key)), mock.method(dns.promises, key, () => deny(key)));
    }
    for (const key of ['appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown', 'link', 'mkdir', 'mkdtemp',
      'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'lutimes', 'writeFile'] as const) {
      const syncKey = `${key}Sync` as const;
      for (const [api, name] of [[fs, key], [fs, syncKey], [fs.promises, key]] as const) {
        const methods = api as unknown as Record<string, (...args: unknown[]) => unknown>;
        if (typeof methods[name] === 'function') spies.push(mock.method(methods, name, () => deny(name)));
      }
    }
    for (const key of ['createWriteStream', 'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'ftruncate', 'ftruncateSync',
      'futimes', 'futimesSync', 'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync', 'write', 'writeSync', 'writev', 'writevSync'] as const) {
      spies.push(mock.method(fs, key, () => deny(key)));
    }
    const checkList = (p: unknown) => {
      if (watch.noList?.some((root) => under(pathArg(p), root))) deny('directory enumeration');
    };
    spies.push(
      mock.method(fs, 'openSync', (p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => open(checkOpen(p, flags), flags, mode)),
      mock.method(fs, 'readFileSync', (p: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
        if (typeof p !== 'number') body('file read', pathArg(p));
        return readFile(p, options);
      }),
      mock.method(fs, 'opendirSync', (p: fs.PathLike, options?: fs.OpenDirOptions) => { checkList(p); return opendir(p, options); }),
      mock.method(fs, 'readdirSync', ((p: fs.PathLike, options?: unknown) => {
        checkList(p);
        return Reflect.apply(readdir, fs, [p, options]);
      }) as typeof fs.readdirSync),
      mock.method(fs, 'lstatSync', ((p: fs.PathLike, options?: unknown) => {
        if (watch.failLockStat !== undefined && pathArg(p) === watch.failLockStat) {
          throw Object.assign(new Error(privateText), { code: 'EACCES' });
        }
        return Reflect.apply(lstat, fs, [p, options]);
      }) as typeof fs.lstatSync),
    );
    // main is synchronous; unexpected async I/O must not outlive the traps.
    for (const key of ['open', 'opendir', 'readdir', 'readFile'] as const) {
      spies.push(mock.method(fs, key, () => deny(key)), mock.method(fs.promises, key, () => deny(key)));
    }
    spies.push(mock.method(fs, 'createReadStream', () => deny('createReadStream')));
    syncBuiltinESMExports();
    const result = main(args, watch.env ?? f.env, f.guard);
    return { result, reads, observations };
  } finally {
    for (const spy of spies.reverse()) spy.mock.restore();
    Object.defineProperty(process, 'platform', procPlatform);
    syncBuiltinESMExports();
    assert.deepEqual(snapshot(f.root), before, 'filesystem snapshot changed');
    assert.deepEqual(denied, [], 'prohibited I/O was attempted');
    if (!watch.control) assert.deepEqual(observations, { subprocess: 0, bootRead: 0, pid: 0 });
  }
}

function expectReport(r: CliOutput, status: 'match' | 'mismatch' | 'unverified', reason?: string) {
  const ok = status === 'match';
  const expected = { ok, command: 'doctor', status, ...(reason === undefined ? {} : { reason }) };
  assert.deepEqual(r, { code: ok ? 0 : 1, stdout: `${JSON.stringify(expected)}\n`, stderr: '' });
}

function expectError(r: CliOutput, error: string, code = 2, layer?: string) {
  const expected = { ok: false, error, ...(layer === undefined ? {} : { layer }) };
  assert.deepEqual(r, { code, stdout: '', stderr: `${JSON.stringify(expected)}\n` });
}

for (const platform of ['darwin', 'linux'] as const) {
  test(`control (${platform}): recover inspect reads lock and uses fake boot and PID observations`, (t) => {
    const f = fixture(t, platform);
    f.putLock('state');
    const { result, reads, observations } = run(f, ['recover', '--state-dir', f.state, '--target-agent', f.target, '--inspect'], { control: true });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const report = parseJsonBytes(Buffer.from(result.stdout)) as { class: string; actions: string[] };
    assert.equal(report.class, 'lock-stale');
    assert.deepEqual(report.actions, ['release-lock']);
    assert.ok(reads.includes(f.locks.state), 'lock body watcher must see the positive control');
    assert.ok(observations.pid > 0);
    assert.ok((platform === 'darwin' ? observations.subprocess : observations.bootRead) > 0);
  });

  test(`doctor (${platform}): ordinary state lock blocks without the recover probes`, (t) => {
    const f = fixture(t, platform);
    f.putLock('state');
    expectReport(run(f, f.args()).result, 'unverified', 'restore-not-applied');
  });
}

test('doctor: exact match with optional overlay; untracked target files are not scanned', (t) => {
  const f = fixture(t, 'darwin', true);
  const extra = path.join(f.target, 'untracked');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(extra, 'fixture.txt'), privateText);
  const { result, reads } = run(f, f.args(), { noBodies: [extra], noList: [f.target] });
  expectReport(result, 'match');
  assert.ok(reads.includes(f.journal) && reads.includes(f.tracked), 'match must prove the recorded restore');
  expectReport(run(f, f.args({ overlay: null })).result, 'mismatch', 'restore-intent-mismatch');
});

test('doctor: only proven but different bundle/platform intent is a mismatch', (t) => {
  const f = fixture(t);
  const other = f.captureBundle(path.join(f.root, 'other-bundle'), 'Different approved instructions');
  expectReport(run(f, f.args({ bundle: other })).result, 'mismatch', 'restore-intent-mismatch');
  expectReport(run(f, f.args({ platform: 'linux' })).result, 'mismatch', 'restore-intent-mismatch');
});

test('doctor: incomplete approved intent is unverified', (t) => {
  const f = fixture(t);
  const incomplete = f.captureBundle(path.join(f.root, 'incomplete-bundle'), privateText, true);
  expectReport(run(f, f.args({ bundle: incomplete })).result, 'unverified', 'restore-intent-unverified');
});

for (const change of ['changed', 'missing'] as const) {
  test(`doctor: ${change} tracked output is unverified, not a drift diagnosis`, (t) => {
    const f = fixture(t);
    if (change === 'changed') fs.writeFileSync(f.tracked, 'Different target bytes\n');
    else fs.unlinkSync(f.tracked);
    const other = f.captureBundle(path.join(f.root, 'different'), 'Different approved intent');
    expectReport(run(f, f.args({ bundle: other }), { noBodies: [other] }).result, 'unverified', 'restore-not-applied');
  });
}

test('doctor: wrong agent or extra lens refuses before opening target bodies', (t) => {
  const f = fixture(t);
  f.putLock('state');
  const otherTarget = path.join(f.root, 'wrong-target');
  fs.mkdirSync(otherTarget);
  const lens = path.join(f.root, 'unbound-lens.json');
  fs.writeFileSync(lens, JSON.stringify({ value: privateText }));
  const noBodies = [f.target, otherTarget, lens, f.bundle];
  expectReport(run(f, f.args({ 'target-agent': otherTarget }), { noBodies }).result, 'unverified', 'target-context-mismatch');
  expectReport(run(f, f.args({ 'lens-config': lens }), { noBodies }).result, 'unverified', 'target-context-mismatch');
});

test('doctor: wrong transaction remains tx-mismatch even with a lock', (t) => {
  const f = fixture(t);
  const args = f.args({ tx: f.wrongTx });
  expectReport(run(f, args).result, 'unverified', 'tx-mismatch');
  f.putLock('gate');
  expectReport(run(f, args).result, 'unverified', 'tx-mismatch');
});

for (const kind of ['package-kind', 'malformed', 'gate', 'unjournaled target', 'non-file target', 'dangling symlink'] as const) {
  test(`doctor: ${kind} lock entry excludes proof by presence alone`, (t) => {
    const f = fixture(t);
    if (kind === 'package-kind') f.putLock('state', 'pi-machine-config/package-lock');
    else if (kind === 'malformed') fs.writeFileSync(f.locks.state, `{${privateText}`, { mode: 0o600 });
    else if (kind === 'gate') f.putLock('gate');
    else if (kind === 'unjournaled target') f.putLock('target');
    else if (kind === 'non-file target') fs.mkdirSync(f.locks.target);
    else fs.symlinkSync(path.join(f.root, 'missing-lock-target'), f.locks.target);
    expectReport(run(f, f.args()).result, 'unverified', 'restore-not-applied');
  });
}

for (const role of ['state', 'gate', 'target'] as const) {
  test(`doctor: unreadable ${role} lock metadata cannot establish absence`, (t) => {
    const f = fixture(t);
    expectReport(run(f, f.args(), { failLockStat: f.locks[role] }).result, 'unverified', 'restore-not-applied');
  });
}

for (const pending of ['attempt', 'ledger'] as const) {
  test(`doctor: unresolved package ${pending} takes precedence over lock, target and transaction mismatches`, (t) => {
    const f = fixture(t);
    f.putLock('state', 'pi-machine-config/package-lock');
    fs.writeFileSync(f[pending], `{${privateText}`, { mode: 0o600 });
    fs.chmodSync(f[pending], 0o600);
    const { result, reads } = run(f, f.args({ 'target-agent': path.join(f.root, 'wrong'), tx: f.wrongTx }), {
      noBodies: [f.attempt, f.journal, f.target, f.bundle, ...(pending === 'attempt' ? [f.ledger] : [])],
    });
    expectReport(result, 'unverified', 'state-corrupt');
    if (pending === 'ledger') assert.ok(reads.includes(f.ledger), 'must check the ledger rather than exempt a package-kind lock');
  });
}

test('doctor: corrupt journal outranks lock exclusion', (t) => {
  const f = fixture(t);
  f.putLock('gate');
  fs.writeFileSync(f.journal, `{${privateText}`);
  expectReport(run(f, f.args(), { noBodies: [f.target, f.bundle] }).result, 'unverified', 'state-corrupt');
});

test('doctor: missing state and invalid transaction are fixed exit 2 errors on stderr', (t) => {
  const f = fixture(t);
  expectError(run(f, f.args({ 'state-dir': path.join(f.root, 'missing-state') })).result, 'state-missing');
  expectError(run(f, f.args({ tx: privateText })).result, 'tx-invalid');
});

test('doctor: invalid bundle payload keeps its fixed exit 2 code and layer', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundle, 'config/common/files/agent/AGENTS.md'), `altered ${privateText}\n`);
  expectError(run(f, f.args()).result, 'payload-digest-mismatch', 2, 'common');
});

test('doctor: fixture live-path guard refuses protected input before state or target body access', (t) => {
  const f = fixture(t);
  const pretendLive = path.join(f.guard.home, '.pi', 'agent');
  expectError(run(f, f.args({ 'target-agent': pretendLive }), { noBodies: [f.state, f.target] }).result, 'live-path-refused');
});

test('doctor: required arguments and lock policy are not bypassable from argv', (t) => {
  const f = fixture(t);
  for (const flag of ['bundle', 'platform', 'target-agent', 'state-dir', 'tx'] as const) {
    expectError(run(f, f.args({ [flag]: null })).result, 'usage');
  }
  expectError(run(f, f.args({ platform: privateText })).result, 'usage');
  expectError(run(f, [...f.args(), '--lock-policy', 'recover']).result, 'usage');
  expectReport(run(f, f.args()).result, 'match'); // Unknown command would also emit usage.
});

test('doctor: operational ToolError omits layer and unexpected errors keep fixed stderr', (t) => {
  const f = fixture(t);
  let inspected = false;
  const throwingEnv = (error: Error): Env => ({ get HOME(): never { inspected = true; throw error; } });
  expectReport(run(f, f.args(), { env: throwingEnv(failure('filesystem-error', 'common')) }).result, 'unverified', 'filesystem-error');
  assert.ok(inspected, 'operational ToolError injection was reached');
  inspected = false;
  expectError(run(f, f.args(), { env: throwingEnv(new Error(privateText)) }).result, 'internal-error', 1);
  assert.ok(inspected, 'unexpected exception injection was reached');
});
