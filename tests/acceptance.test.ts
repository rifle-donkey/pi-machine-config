import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const marker = 'excluded-value-qa-58c12';
function fixture(fn: (f: { root: string; agent: string; policy: string; bundle: string }) => void) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pi-machine-qa-'));
  const f = { root, agent: path.join(root, 'agent'), policy: path.join(root, 'policy.json'), bundle: path.join(root, 'bundle') };
  fs.mkdirSync(f.agent);
  try { fn(f); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function runWithEnv(override: Record<string, string | undefined>, ...args: string[]) {
  const env = { ...process.env, ...override };
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, env });
  assert.equal(r.error, undefined, 'CLI child timed out or could not start');
  assert.ok(!`${r.stdout}${r.stderr}`.includes(marker), 'excluded value leaked');
  return r;
}
function run(...args: string[]) { return runWithEnv({ PI_CODING_AGENT_DIR: undefined }, ...args); }
function expectError(r: ReturnType<typeof run>, code: string, status = 2) {
  assert.equal(r.status, status, r.stderr);
  assert.equal(JSON.parse(r.stderr).error, code);
  assert.ok(!r.stdout.includes('approvalToken'));
}
function scan(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(p);
    else assert.ok(!fs.readFileSync(p).includes(Buffer.from(marker)), 'excluded marker in bundle');
  }
}
function policy(f: { policy: string }, common: object, platform: object = {}) {
  fs.writeFileSync(f.policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: { common, 'platform:linux': platform } }));
}
function review(f: { policy: string; agent: string }) {
  return run('capture-review', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'linux');
}
function captureWithToken(f: { policy: string; agent: string; bundle: string }, token: string) {
  return run('capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'linux', '--out', f.bundle, '--approve-inclusion', token);
}
function capture(f: { policy: string; agent: string; bundle: string }) {
  const r = review(f);
  if (r.status !== 0) return r; // Invalid fixtures exercise review, not capture.
  return captureWithToken(f, JSON.parse(r.stdout).captureReviewToken);
}
function plan(f: { bundle: string; root: string }, target = 'target', platform = 'linux') {
  return run('plan', '--bundle', f.bundle, '--platform', platform, '--target-agent', path.join(f.root, target));
}
function snapshot(dir: string): unknown {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isDirectory() ? snapshot(path.join(dir,e.name)) : fs.readFileSync(path.join(dir,e.name)).toString('base64')]);
}

test('capture projects only approved values; ready plan is stable, read-only and target-bound', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ theme: 'dark', httpProxy: marker, packages: ['npm:alpha@latest', 'npm:ignored'] }));
  const auth = path.join(f.agent, 'auth.json'); fs.writeFileSync(auth, marker);
  fs.mkdirSync(path.join(f.agent, 'sessions')); fs.writeFileSync(path.join(f.agent, 'sessions/runtime.json'), marker);
  if (process.getuid?.() !== 0) fs.chmodSync(auth, 0);
  policy(f, { settings: ['theme'], packages: ['npm:alpha'] });
  let c: ReturnType<typeof capture>;
  try { c = capture(f); } finally { fs.chmodSync(auth, 0o600); }
  assert.equal(c.status, 0, c.stderr); scan(f.bundle);
  assert.deepEqual(JSON.parse(c.stdout).skipped, { settings: 1, packages: 1 });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.bundle, 'config/common/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.settings, { theme: 'dark' }); assert.deepEqual(manifest.packages, ['npm:alpha']);
  const before = snapshot(f.root);
  const a = plan(f), b = plan(f), changed = plan(f, 'other');
  assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0); assert.equal(changed.status, 0);
  const aa = JSON.parse(a.stdout), bb = JSON.parse(b.stdout), cc = JSON.parse(changed.stdout);
  assert.equal(aa.status, 'ready'); assert.match(aa.approvalToken, /^sha256:[0-9a-f]{64}$/);
  assert.equal(aa.approvalToken, bb.approvalToken); assert.notEqual(aa.approvalToken, cc.approvalToken);
  assert.deepEqual(snapshot(f.root), before);
  fs.mkdirSync(path.join(f.root, 'target'));
  const conflict = plan(f); assert.equal(conflict.status, 1); const result = JSON.parse(conflict.stdout);
  assert.equal(result.status, 'conflict'); assert.ok(!result.approvalToken);
  assert.ok(result.items.some((x: any) => x.kind === 'target' && x.reason === 'target-exists'));
}));

test('unsupported local resource yields incomplete without token', () => fixture(f => {
  fs.mkdirSync(path.join(f.agent, 'extensions')); fs.writeFileSync(path.join(f.agent, 'extensions/x.ts'), 'export default 1;\n');
  policy(f, { files: [{ root: 'agent', path: 'extensions/x.ts', class: 'extension-source', template: false }] });
  const c = capture(f); assert.equal(c.status, 0, c.stderr);
  const p = plan(f); assert.equal(p.status, 1); const result = JSON.parse(p.stdout);
  assert.equal(result.status, 'incomplete'); assert.ok(!result.approvalToken);
  assert.ok(result.items.some((x: any) => x.reason === 'dependency-analysis-unavailable'));
}));

test('strict JSON rejects ambiguous settings and BOM policy on valid fixtures', () => {
  fixture(f => { policy(f, { settings: ['theme'] }); fs.writeFileSync(path.join(f.agent, 'settings.json'), '{"theme":"dark"}'); assert.equal(capture(f).status, 0); });
  for (const [input, code] of [
    ['{"theme":"dark","theme":"light"}', 'json-duplicate-key'],
    ['{"theme":"dark","__proto__":{}}', 'json-unsafe-key'],
    ['{"theme":"dark","ignored":9007199254740993}', 'json-unsafe-number'],
  ]) fixture(f => {
    policy(f, { settings: ['theme'] }); fs.writeFileSync(path.join(f.agent, 'settings.json'), input);
    expectError(capture(f), code); assert.equal(fs.existsSync(f.bundle), false);
  });
  fixture(f => {
    policy(f, { settings: ['theme'] }); fs.writeFileSync(path.join(f.agent, 'settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(f.policy, '\ufeff' + fs.readFileSync(f.policy, 'utf8'));
    expectError(capture(f), 'json-bom'); assert.equal(fs.existsSync(f.bundle), false);
  });
});

test('traversal, symlink and hardlink selected inputs are refused', () => {
  fixture(f => {
    fs.mkdirSync(path.join(f.agent, 'extensions')); fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), 'harmless');
    policy(f, { files: [{ root: 'agent', path: 'extensions/../AGENTS.md', class: 'extension-source', template: false }] });
    expectError(capture(f), 'path-invalid'); assert.equal(fs.existsSync(f.bundle), false);
  });
  for (const kind of ['symlink', 'hardlink']) fixture(f => {
    const original = path.join(f.root, 'original'); fs.writeFileSync(original, 'hello');
    const selected = path.join(f.agent, 'AGENTS.md');
    if (kind === 'symlink') fs.symlinkSync(original, selected); else fs.linkSync(original, selected);
    policy(f, { files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
    expectError(capture(f), kind === 'symlink' ? 'symlink-refused' : 'hardlink-refused'); assert.equal(fs.existsSync(f.bundle), false);
  });
});

test('oversized selected text is refused', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), 'x'.repeat(1024 * 1024 + 1));
  policy(f, { files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
  expectError(capture(f), 'file-too-large'); assert.equal(fs.existsSync(f.bundle), false);
}));

test('tampering with independently captured bundle components blocks planning', () => {
  for (const [part, code] of [['payload', 'payload-digest-mismatch'], ['manifest', 'manifest-digest-mismatch'], ['completion', 'bundle-incomplete']]) fixture(f => {
    fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), 'original context');
    policy(f, { files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
    assert.equal(capture(f).status, 0);
    if (part === 'payload') fs.writeFileSync(path.join(f.bundle, 'config/common/files/agent/AGENTS.md'), 'Original context');
    if (part === 'manifest') fs.appendFileSync(path.join(f.bundle, 'config/common/manifest.json'), ' ');
    if (part === 'completion') fs.unlinkSync(path.join(f.bundle, 'manifests/complete.json'));
    const before = snapshot(f.root); expectError(plan(f), code);
    assert.equal(fs.existsSync(path.join(f.root, 'target')), false); assert.deepEqual(snapshot(f.root), before);
  });
});

test('ready plan classifies activation and non-activation explicitly', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ theme: 'dark', defaultTools: ['read'], packages: ['npm:alpha'] }));
  fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), 'context');
  policy(f, { settings: ['theme', 'defaultTools'], packages: ['npm:alpha'], files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
  assert.equal(capture(f).status, 0); const p = plan(f); assert.equal(p.status, 0, p.stderr);
  const result = JSON.parse(p.stdout); assert.equal(result.status, 'ready'); assert.match(result.approvalToken, /^sha256:[0-9a-f]{64}$/);
  for (const expected of [
    { kind: 'setting', key: 'theme', operation: 'create' },
    { kind: 'setting', key: 'defaultTools', operation: 'activation-required' },
    { kind: 'package', source: 'npm:alpha', operation: 'activation-required' },
    { kind: 'file', path: 'AGENTS.md', operation: 'activation-required' },
    { kind: 'target', target: 'agent', operation: 'create' },
  ]) assert.ok(result.items.some((item: any) => Object.entries(expected).every(([k, v]) => item[k] === v)));
}));

test('explicit live agent environment guard refuses a fixture source', () => fixture(f => {
  policy(f, {});
  const token = JSON.parse(review(f).stdout).captureReviewToken;
  const r = runWithEnv({ PI_CODING_AGENT_DIR: f.agent }, 'capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'linux', '--out', f.bundle, '--approve-inclusion', token);
  expectError(r, 'live-path-refused'); assert.equal(fs.existsSync(f.bundle), false);
}));

test('unsupported git package is rejected even when not selected', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ theme: 'dark', packages: ['git:example/repo'] }));
  policy(f, { settings: ['theme'] }); expectError(capture(f), 'package-unsupported'); assert.equal(fs.existsSync(f.bundle), false);
}));

test('exactly one MiB of selected text is accepted', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), 'x'.repeat(1024 * 1024));
  policy(f, { files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
  const c = capture(f); assert.equal(c.status, 0, c.stderr); assert.equal(plan(f).status, 0);
}));

test('approval is explicit, stable, read-only, and records consent', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'settings.json'), '{"theme":"dark"}'); policy(f, { settings: ['theme'] });
  const before = snapshot(f.root), a = review(f), b = review(f);
  assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
  const token = JSON.parse(a.stdout).captureReviewToken;
  assert.match(token, /^sha256:[0-9a-f]{64}$/); assert.equal(token, JSON.parse(b.stdout).captureReviewToken);
  assert.deepEqual(snapshot(f.root), before);
  expectError(run('capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'linux', '--out', f.bundle), 'inclusion-approval-required');
  expectError(captureWithToken(f, 'bad'), 'approval-token-invalid'); assert.equal(fs.existsSync(f.bundle), false);
  const c = captureWithToken(f, token); assert.equal(c.status, 0, c.stderr);
  const record = fs.readFileSync(path.join(f.bundle, 'manifests/inclusion-approval.json'), 'utf8');
  assert.ok(record.includes(token)); assert.equal(plan(f).status, 0);
  fs.appendFileSync(path.join(f.bundle, 'manifests/inclusion-approval.json'), ' ');
  const altered = snapshot(f.root); expectError(plan(f), 'inclusion-approval-digest-mismatch'); assert.deepEqual(snapshot(f.root), altered);
  fs.unlinkSync(path.join(f.bundle, 'manifests/inclusion-approval.json'));
  const missing = snapshot(f.root); expectError(plan(f), 'inclusion-approval-missing'); assert.deepEqual(snapshot(f.root), missing);
}));

test('capture rejects stale approval for selected settings, payload, policy, and package', () => {
  for (const changed of ['settings', 'payload', 'policy', 'package']) fixture(f => {
    const settings = path.join(f.agent, 'settings.json'), payload = path.join(f.agent, 'AGENTS.md');
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', packages: ['npm:alpha', 'npm:beta'] })); fs.writeFileSync(payload, 'first');
    policy(f, { settings: ['theme'], packages: ['npm:alpha', 'npm:beta'], files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
    const r = review(f); assert.equal(r.status, 0, r.stderr); const token = JSON.parse(r.stdout).captureReviewToken;
    if (changed === 'settings') fs.writeFileSync(settings, JSON.stringify({ theme: 'light', packages: ['npm:alpha', 'npm:beta'] }));
    if (changed === 'payload') fs.writeFileSync(payload, 'second');
    if (changed === 'policy') fs.appendFileSync(f.policy, ' ');
    if (changed === 'package') fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', packages: ['npm:beta', 'npm:alpha'] }));
    expectError(captureWithToken(f, token), 'inclusion-approval-mismatch', 1); assert.equal(fs.existsSync(f.bundle), false);
  });
});

test('capture revalidates malformed selected JSON and traversal after review', () => {
  fixture(f => {
    const settings = path.join(f.agent, 'settings.json'); fs.writeFileSync(settings, '{"theme":"dark"}'); policy(f, { settings: ['theme'] });
    const token = JSON.parse(review(f).stdout).captureReviewToken;
    fs.writeFileSync(settings, '{"theme":"dark","theme":"light"}');
    expectError(captureWithToken(f, token), 'json-duplicate-key'); assert.equal(fs.existsSync(f.bundle), false);
  });
  fixture(f => {
    fs.mkdirSync(path.join(f.agent, 'extensions')); fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), 'context');
    policy(f, { files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] });
    const token = JSON.parse(review(f).stdout).captureReviewToken;
    policy(f, { files: [{ root: 'agent', path: 'extensions/../AGENTS.md', class: 'extension-source', template: false }] });
    expectError(captureWithToken(f, token), 'path-invalid'); assert.equal(fs.existsSync(f.bundle), false);
  });
});

test('review refuses prohibited paths before opening them', () => {
  for (const p of ['extensions/auth.json', 'extensions/sessions/x.ts', 'extensions/settings.json']) fixture(f => {
    policy(f, { files: [{ root: 'agent', path: p, class: 'extension-source', template: false }] });
    expectError(review(f), 'path-prohibited'); assert.equal(fs.existsSync(f.bundle), false);
  });
});

test('unvalidated theme files are incomplete and invalid builtins are refused', () => {
  for (const content of ['null', '{}']) fixture(f => {
    fs.mkdirSync(path.join(f.agent, 'themes')); fs.writeFileSync(path.join(f.agent, 'themes/custom.json'), content);
    policy(f, { files: [{ root: 'agent', path: 'themes/custom.json', class: 'theme', template: false }] });
    const c = capture(f); assert.equal(c.status, 0, c.stderr); const p = plan(f); assert.equal(p.status, 1);
    const result = JSON.parse(p.stdout); assert.equal(result.status, 'incomplete'); assert.ok(!result.approvalToken);
  });
  for (const [key, value] of [['extensions', 'builtin:unknown'], ['skills', 'builtin:mcp']]) fixture(f => {
    fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ [key]: [value] })); policy(f, { settings: [key] });
    expectError(review(f), 'resource-builtin-unsupported');
  });
});

test('thinking level max is valid and unsupported tui mode is refused', () => {
  fixture(f => { fs.writeFileSync(path.join(f.agent, 'settings.json'), '{"defaultThinkingLevel":"max"}'); policy(f, { settings: ['defaultThinkingLevel'] }); assert.equal(capture(f).status, 0); assert.equal(plan(f).status, 0); });
  fixture(f => { fs.writeFileSync(path.join(f.agent, 'settings.json'), '{"tuiMode":"invalid"}'); policy(f, { settings: ['tuiMode'] }); expectError(review(f), 'setting-invalid'); });
});

test('ordered package filter mismatches are rejected rather than broadened', () => fixture(f => {
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ packages: [{ source: 'npm:alpha@latest', autoload: false, extensions: ['a.ts', '!b.ts'] }] }));
  policy(f, { packages: [{ source: 'npm:alpha', autoload: false, extensions: ['!b.ts', 'a.ts'] }] });
  expectError(capture(f), 'package-filter-mismatch'); assert.equal(fs.existsSync(f.bundle), false);
}));
