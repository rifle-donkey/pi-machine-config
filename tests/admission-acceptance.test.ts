import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { main } from '../src/cli.ts';

function fixture(fn: (f: {
  root: string; home: string; agent: string; policy: string;
}) => void) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pmc-admission-qa-'));
  const home = path.join(root, 'home');
  const agent = path.join(root, 'source');
  const policy = path.join(root, 'policy.json');
  try {
    fs.mkdirSync(home);
    fs.mkdirSync(agent);
    fs.writeFileSync(path.join(agent, 'settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(policy, JSON.stringify({
      schemaVersion: 1,
      kind: 'pi-machine-config/inclusion',
      layers: { common: { settings: ['theme'] }, 'platform:linux': {} },
    }));
    fn({ root, home, agent, policy });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function review(f: { home: string; agent: string; policy: string },
  env: Record<string, string | undefined> = {}) {
  return main([
    'capture-review', '--policy', f.policy,
    '--source-agent', f.agent, '--platform', 'linux',
  ], env, { home: f.home });
}

test('missing default roots permit a valid review', () => fixture(f => {
  const result = review(f);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(JSON.parse(result.stdout).captureReviewToken, /^sha256:[a-f0-9]{64}$/);
}));

test('unavailable default lens metadata stops review before input body opens', () => fixture(f => {
  const lens = path.join(f.home, '.pi-lens');
  const beforePolicy = fs.readFileSync(f.policy);
  const settings = path.join(f.agent, 'settings.json');
  const beforeSettings = fs.readFileSync(settings);
  const beforeEntries = fs.readdirSync(f.root).sort();
  const original = fs.realpathSync.native;
  const lookup = mock.method(fs.realpathSync, 'native', (p: fs.PathLike) => {
    if (p === lens) throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
    return original(p);
  });
  const opens = mock.method(fs, 'openSync');
  try {
    const result = review(f);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'live-location-unavailable' });
    assert.equal(opens.mock.calls.filter(c => c.arguments[0] === f.policy ||
      c.arguments[0] === settings).length, 0);
  } finally {
    opens.mock.restore();
    lookup.mock.restore();
  }
  assert.deepEqual(fs.readFileSync(f.policy), beforePolicy);
  assert.deepEqual(fs.readFileSync(settings), beforeSettings);
  assert.deepEqual(fs.readdirSync(f.root).sort(), beforeEntries);
}));

test('an absolute configured root protects its physical destination through an alias', () => fixture(f => {
  const alias = path.join(f.root, 'configured-alias');
  fs.symlinkSync(f.agent, alias);
  const control = review(f);
  assert.equal(control.code, 0, control.stderr);
  const result = review(f, { PI_CODING_AGENT_DIR: alias });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'live-path-refused' });
}));

test('HOME alias adds protection without replacing account-home protection', () => fixture(f => {
  const envHome = path.join(f.root, 'environment-home');
  const homeAlias = path.join(f.root, 'environment-home-alias');
  const accountAgent = path.join(f.home, '.pi', 'agent');
  const envAgent = path.join(envHome, '.pi', 'agent');

  for (const agent of [accountAgent, envAgent]) {
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, 'settings.json'), '{"theme":"dark"}');
  }
  fs.symlinkSync(envHome, homeAlias);
  const env = { HOME: homeAlias };

  const control = review(f, env);
  assert.equal(control.code, 0, control.stderr);
  assert.equal(control.stderr, '');
  assert.match(JSON.parse(control.stdout).captureReviewToken, /^sha256:[a-f0-9]{64}$/);

  for (const agent of [accountAgent, envAgent]) {
    const result = review({ ...f, agent }, env);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: 'live-path-refused',
    });
  }
}));
