/** Account-home protection is never replaced by Pi's environment-home selection. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { guardLiveLexical, liveLocations } from '../src/fsafe.ts';
import { main } from '../src/cli.ts';
import { applyRestore, type RestorePacket, type TxOptions } from '../src/transaction.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-homes-'));
  roots.push(root);
  const account = path.join(root, 'account');
  const environment = path.join(root, 'environment');
  fs.mkdirSync(account);
  fs.mkdirSync(environment);
  return { root, account, environment };
}
function refused(fn: () => unknown) {
  assert.throws(fn, (e: unknown) => e instanceof ToolError && e.code === 'live-path-refused');
}

test('account and HOME-selected Pi and lens roots are protected together', () => {
  const f = fixture();
  const live = liveLocations({ HOME: f.environment }, { home: f.account });
  for (const home of [f.account, f.environment]) {
    for (const leaf of ['.pi', '.pi-lens']) refused(() => guardLiveLexical(path.join(home, leaf, 'child'), live));
  }
});

test('HOME aliases protect their physical future roots', () => {
  const f = fixture();
  const alias = path.join(f.root, 'environment-alias');
  fs.symlinkSync(f.environment, alias);
  const live = liveLocations({ HOME: alias }, { home: f.account });
  refused(() => guardLiveLexical(path.join(f.environment, '.pi', 'agent'), live));
  refused(() => guardLiveLexical(path.join(f.environment, '.pi-lens', 'config.json'), live));
});

test('capture review cannot read a Pi source selected by HOME', () => {
  const f = fixture();
  const agent = path.join(f.environment, '.pi', 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'settings.json'), '{"theme":"dark"}');
  const policy = path.join(f.root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common: { settings: ['theme'] } } }));
  const args = ['capture-review', '--policy', policy, '--source-agent', agent, '--platform', 'linux'];
  assert.equal(main(args, {}, { home: f.account }).code, 0);
  const result = main(args, { HOME: f.environment }, { home: f.account });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'live-path-refused' });
});

test('HOME-selected physical Pi targets cannot be created', () => {
  const f = fixture();
  const parent = path.join(f.environment, '.pi');
  fs.mkdirSync(parent);
  const platform = process.platform as Platform;
  const packet: RestorePacket = { planToken: `sha256:${'a'.repeat(64)}`, platform,
    state: path.join(f.root, 'state'), agentTarget: path.join(parent, 'agent'), lensTarget: null,
    settings: { defaultProvider: 'anthropic' }, packages: [], files: [], protectedRoots: [] };
  const options: TxOptions = { env: { HOME: f.environment }, guard: { home: f.account }, deps: {
    platform, bootId: () => '11111111-2222-4333-8444-555555555555', hostname: () => 'fixture-host',
    uid: () => process.getuid?.() ?? 0, pid: () => process.pid, probePid: () => 'alive',
  } };
  const control = applyRestore({ ...packet, state: path.join(f.root, 'control-state'), agentTarget: path.join(f.root, 'control-agent') }, options);
  assert.equal(control.status, 'applied');
  refused(() => applyRestore(packet, options));
  assert.equal(fs.existsSync(packet.state), false);
  assert.equal(fs.existsSync(packet.agentTarget), false);
});

for (const home of ['', 'relative-home', '/tmp/invalid\0home']) {
  test(`unresolvable HOME is refused (${home === '' ? 'empty' : home.includes('\0') ? 'NUL' : 'relative'})`, () => {
    const f = fixture();
    assert.throws(() => liveLocations({ HOME: home }, { home: f.account }),
      (e: unknown) => e instanceof ToolError && e.code === 'live-location-unavailable' && e.exit === 1);
  });
}
