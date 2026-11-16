/** Fail-closed protection for unresolved live roots; only owned temporary fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { guardLiveLexical, liveLocations } from '../src/fsafe.ts';
import { applyRestore, type RestorePacket, type TxOptions } from '../src/transaction.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-admission-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const data = path.join(root, 'pi-data');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  return { root, home, data };
}
function expectUnavailable(fn: () => unknown) {
  assert.throws(fn, (e: unknown) => e instanceof ToolError && e.code === 'live-location-unavailable' && e.exit === 1);
}
function withDeniedLookup(subject: string, code: string, fn: () => void) {
  const original = fs.realpathSync.native;
  const patch = mock.method(fs.realpathSync, 'native', (p: fs.PathLike) => {
    if (p === subject) throw Object.assign(new Error('synthetic lookup failure'), { code });
    return original(p);
  });
  try { fn(); } finally { patch.mock.restore(); }
}

test('absent protected roots retain lexical protection, including an empty override', () => {
  const f = fixture();
  const live = liveLocations({}, { home: f.home });
  assert.deepEqual(liveLocations({ PI_CODING_AGENT_DIR: '' }, { home: f.home }), live);
  assert.throws(() => guardLiveLexical(path.join(f.home, '.pi', 'agent'), live),
    (e: unknown) => e instanceof ToolError && e.code === 'live-path-refused');
});

test('a resolvable protected alias guards its physical destination', () => {
  const f = fixture();
  fs.symlinkSync(f.data, path.join(f.home, '.pi'));
  const live = liveLocations({}, { home: f.home });
  assert.throws(() => guardLiveLexical(path.join(f.data, 'agent'), live),
    (e: unknown) => e instanceof ToolError && e.code === 'live-path-refused');
});

test('a missing configured root is protected through a resolved ancestor alias', () => {
  const f = fixture();
  const alias = path.join(f.home, 'alias');
  fs.symlinkSync(f.data, alias);
  const live = liveLocations({ PI_CODING_AGENT_DIR: path.join(alias, 'future-agent') }, { home: f.home });
  assert.throws(() => guardLiveLexical(path.join(f.data, 'future-agent'), live),
    (e: unknown) => e instanceof ToolError && e.code === 'live-path-refused');
});

test('a missing default root is protected through a home ancestor alias', () => {
  const f = fixture();
  const alias = path.join(f.root, 'home-alias');
  fs.symlinkSync(f.home, alias);
  const live = liveLocations({}, { home: alias });
  assert.throws(() => guardLiveLexical(path.join(f.home, '.pi', 'agent'), live),
    (e: unknown) => e instanceof ToolError && e.code === 'live-path-refused');
});

test('a dangling protected alias is not mistaken for a missing directory', () => {
  const f = fixture();
  fs.symlinkSync(path.join(f.data, 'not-created'), path.join(f.home, '.pi'));
  expectUnavailable(() => liveLocations({}, { home: f.home }));
});

test('an unavailable ancestor of a missing root fails closed', () => {
  const f = fixture();
  withDeniedLookup(f.home, 'EACCES', () => expectUnavailable(() => liveLocations({}, { home: f.home })));
});

for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO']) {
  test(`protected-root ${code} is not treated as absence`, () => {
    const f = fixture();
    const alias = path.join(f.home, '.pi');
    fs.symlinkSync(f.data, alias);
    withDeniedLookup(alias, code, () => expectUnavailable(() => liveLocations({}, { home: f.home })));
  });
}

for (const value of ['relative-agent', '/tmp/invalid\0agent']) {
  test(`an ambiguous configured agent root is refused (${value.includes('\0') ? 'NUL' : 'relative'})`, () => {
    const f = fixture();
    expectUnavailable(() => liveLocations({ PI_CODING_AGENT_DIR: value }, { home: f.home }));
  });
}

test('an inaccessible live alias cannot permit physical target creation', () => {
  const f = fixture();
  const alias = path.join(f.home, '.pi');
  fs.symlinkSync(f.data, alias);
  const platform = process.platform as Platform;
  const packet: RestorePacket = {
    planToken: `sha256:${'a'.repeat(64)}`, platform,
    state: path.join(f.root, 'state'), agentTarget: path.join(f.data, 'new-agent'),
    lensTarget: null, settings: { defaultProvider: 'anthropic' }, packages: [], files: [], protectedRoots: [],
  };
  const options: TxOptions = { env: {}, guard: { home: f.home }, deps: {
    platform, bootId: () => '11111111-2222-4333-8444-555555555555',
    hostname: () => 'fixture-host', uid: () => process.getuid?.() ?? 0,
    pid: () => process.pid, probePid: () => 'alive',
  } };
  const control = applyRestore({ ...packet, state: path.join(f.root, 'control-state'), agentTarget: path.join(f.root, 'control-agent') }, options);
  assert.equal(control.status, 'applied');
  assert.throws(() => applyRestore(packet, options),
    (e: unknown) => e instanceof ToolError && e.code === 'live-path-refused');
  withDeniedLookup(alias, 'EACCES', () => expectUnavailable(() => applyRestore(packet, options)));
  assert.equal(fs.existsSync(packet.state), false);
  assert.equal(fs.existsSync(packet.agentTarget), false);
});
