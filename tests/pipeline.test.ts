/**
 * Capture review → capture → plan → CLI behavior against synthetic temporary
 * fixtures only. In-process runs pass a temporary fixture home as the guard
 * context, so the live-path guard canonicalizes only fixture paths. Spawned
 * CLI runs use the production guard, which queries path metadata (realpath)
 * of the real account's `.pi`/`.pi-lens` locations but never opens them.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureToken } from '../src/approval.ts';
import { main } from '../src/cli.ts';

const SECRET = 'SECRET-MARKER-7f3a';
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ENV: Record<string, string | undefined> = {};
const temps: string[] = [];

after(() => {
  for (const t of temps) {
    // Restore permissions so cleanup can remove deliberately unreadable fixtures.
    try {
      execFileSync('chmod', ['-R', 'u+rwx', t]);
    } catch {
      // ignore
    }
    fs.rmSync(t, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-test-')));
  temps.push(d);
  return d;
}

/** Fixture home for the in-process guard context; `.pi` inside it plays the live agent directory. */
const FAKE_HOME = tmp();
const GUARD = { home: FAKE_HOME };
const ZERO_TOKEN = `sha256:${'0'.repeat(64)}`;

function put(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const SKILL = '---\nname: firecrawl\ndescription: Manual only.\ndisable-model-invocation: true\n---\nUse only when asked.\n';

/** Synthetic source agent directory with approved and excluded content. */
function makeSource(root: string): string {
  const agent = path.join(root, 'agent');
  put(
    path.join(agent, 'settings.json'),
    JSON.stringify(
      {
        defaultProvider: 'anthropic',
        defaultModel: 'model-a',
        editorPaddingX: 2,
        theme: 'dark',
        defaultTools: ['read', 'bash'],
        extensions: [`${agent}/extensions/hello.ts`, '-builtin:mcp', `-${agent}/extensions/off.ts`],
        npmCommand: [SECRET],
        httpProxy: `http://${SECRET}`,
        packages: [
          'npm:pi-lens@1.2.3',
          { source: 'npm:@scope/tools@latest', autoload: false, extensions: ['dist/b.ts', '!dist/a.ts'], skills: [] },
          'npm:unlisted',
        ],
      },
      null,
      2,
    ),
  );
  put(path.join(agent, 'AGENTS.md'), '# Rules\nAgent dir: {{AGENT_DIR}}\n');
  put(path.join(agent, 'prompts', 'review.md'), 'Review this.\n');
  put(path.join(agent, 'themes', 'dark.json'), '{"name":"dark","colors":{}}\n');
  put(path.join(agent, 'extensions', 'hello.ts'), 'export default function () {}\n');
  put(path.join(agent, 'skills', 'firecrawl', 'SKILL.md'), SKILL);
  put(path.join(agent, 'auth.json'), JSON.stringify({ token: SECRET }));
  fs.chmodSync(path.join(agent, 'auth.json'), 0o000);
  put(path.join(agent, 'sessions', 'x.jsonl'), SECRET);
  return agent;
}

type Obj = Record<string, unknown>;

function basePolicy(): Obj {
  return {
    schemaVersion: 1,
    kind: 'pi-machine-config/inclusion',
    layers: {
      common: {
        settings: ['defaultProvider', 'editorPaddingX', 'defaultTools'],
        packages: ['npm:pi-lens', { source: 'npm:@scope/tools', autoload: false, extensions: ['dist/b.ts', '!dist/a.ts'], skills: [] }],
        files: [
          { root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: true },
          { root: 'agent', path: 'prompts/review.md', class: 'prompt', template: false },
        ],
      },
      'platform:darwin': { settings: ['theme'] },
    },
  };
}

function writePolicy(root: string, policy: Obj, name = 'policy.json'): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, JSON.stringify(policy, null, 2));
  return p;
}

interface Fixture {
  root: string;
  agent: string;
  policy: string;
  bundle: string;
}

function fixture(policy: Obj = basePolicy()): Fixture {
  const root = tmp();
  const agent = makeSource(root);
  return { root, agent, policy: writePolicy(root, policy), bundle: path.join(root, 'bundle') };
}

function reviewArgs(f: Fixture, extra: string[] = [], platform = 'darwin'): string[] {
  return ['capture-review', '--policy', f.policy, '--source-agent', f.agent, '--platform', platform, ...extra];
}

/**
 * Capture arguments with a well-formed approval token. Input validation runs
 * before the token comparison, so error cases see the validation error; a
 * successful capture needs the reviewed token (see `captured`).
 */
function captureArgs(f: Fixture, extra: string[] = [], token = ZERO_TOKEN): string[] {
  return ['capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'darwin', '--out', f.bundle, ...extra, '--approve-inclusion', token];
}

function run(args: string[], env = ENV) {
  const r = main(args, env, GUARD);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'output leaked a secret');
  return { ...r, out: r.stdout ? (JSON.parse(r.stdout) as Obj) : undefined, err: r.stderr ? (JSON.parse(r.stderr) as Obj) : undefined };
}

function reviewToken(f: Fixture, extra: string[] = []): string {
  const r = run(reviewArgs(f, extra));
  assert.equal(r.code, 0, r.stderr);
  return String(r.out?.captureReviewToken);
}

/** Review, then capture with the reviewed token. */
function captured(f: Fixture = fixture(), extra: string[] = []): Fixture {
  const r = run(captureArgs(f, extra, reviewToken(f, extra)));
  assert.equal(r.code, 0, r.stderr);
  return f;
}

function planArgs(f: Fixture, target: string, extra: string[] = [], platform = 'darwin'): string[] {
  return ['plan', '--bundle', f.bundle, '--platform', platform, '--target-agent', target, ...extra];
}

function expectError(args: string[], code: string, exit = 2, env = ENV): void {
  const r = run(args, env);
  assert.equal(r.code, exit, r.stderr || r.stdout);
  assert.equal(r.err?.error, code, r.stderr);
}

/** Recursive metadata snapshot used to prove commands do not mutate a tree. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    const st = fs.lstatSync(p, { bigint: true });
    out.push(`${path.relative(dir, p)}|${st.mode}|${st.size}|${st.mtimeNs}|${st.ctimeNs}|${st.ino}`);
    if (st.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
  };
  walk(dir);
  return out;
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------- hand-built bundles

interface LayerSpec {
  settings?: Obj;
  packages?: unknown[];
  files?: { root: string; path: string; class: string; template: boolean; content: string; expect?: Obj }[];
  packagesRemove?: string[];
}

function layerDoc(layer: string, spec: LayerSpec): Obj {
  const files = (spec.files ?? []).map((f) => {
    const rec: Obj = { root: f.root, path: f.path, class: f.class, bytes: Buffer.byteLength(f.content), sha256: sha(f.content), template: f.template };
    if (f.expect) rec.expect = f.expect;
    return rec;
  });
  const doc: Obj = { schemaVersion: 1, layer, piDiscoveryModel: 'pi@1.5.2', settings: spec.settings ?? {}, packages: spec.packages ?? [], files };
  if (spec.packagesRemove) doc.packagesRemove = spec.packagesRemove;
  return doc;
}

function writeLayer(dir: string, layer: string, spec: LayerSpec): string {
  for (const f of spec.files ?? []) put(path.join(dir, 'files', f.root, f.path), f.content);
  const bytes = JSON.stringify(layerDoc(layer, spec), null, 2);
  put(path.join(dir, 'manifest.json'), bytes);
  return sha(bytes);
}

type Layers = Partial<Record<'common' | 'platform:darwin' | 'platform:linux', LayerSpec>>;
const LAYER_NAMES = ['common', 'platform:darwin', 'platform:linux'] as const;

/** Approval record for a hand-built bundle: the descriptor capture would record and its token. */
function approvalRecord(policyBytes: string, layers: Layers, platform = 'darwin'): Obj {
  const docs: Obj = {};
  for (const l of LAYER_NAMES) docs[l] = layerDoc(l, layers[l] ?? {});
  const intent: Obj = { tool: 'pi-machine-config@0.1.0', discoveryModel: 'pi@1.5.2', platform, policySha256: sha(policyBytes), layers: docs };
  return { schemaVersion: 1, kind: 'pi-machine-config/inclusion-approval', approvalToken: captureToken(intent as never), intent };
}

function writeMarker(bundle: string, fields: Obj): void {
  fs.writeFileSync(path.join(bundle, 'manifests', 'complete.json'), JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/capture-complete', tool: 'pi-machine-config@0.1.0', ...fields }));
}

/** Build a complete bundle directly, so merge and tamper cases need no capture. */
function buildBundle(bundle: string, policy: Obj, layers: Layers, approval?: Obj): void {
  const pbytes = JSON.stringify(policy);
  put(path.join(bundle, 'manifests', 'inclusion.json'), pbytes);
  const shas: Obj = {};
  for (const l of LAYER_NAMES) {
    const dir = l === 'common' ? 'config/common' : `config/platforms/${l.slice(9)}`;
    shas[l] = writeLayer(path.join(bundle, dir), l, layers[l] ?? {});
  }
  const abytes = JSON.stringify(approval ?? approvalRecord(pbytes, layers));
  put(path.join(bundle, 'manifests', 'inclusion-approval.json'), abytes);
  writeMarker(bundle, { policySha256: sha(pbytes), approvalSha256: sha(abytes), layers: shas });
}

function policyFor(layers: Obj, overlay?: Obj): Obj {
  const p: Obj = { schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers };
  if (overlay) p.overlay = overlay;
  return p;
}

// ================================================================ capture

describe('capture', () => {
  it('projects only approved settings, packages and files into a complete private bundle', () => {
    const f = fixture();
    const token = reviewToken(f);
    const r = run(captureArgs(f, [], token));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out, {
      ok: true,
      command: 'capture',
      layers: { common: { settings: 3, packages: 2, files: 2 }, 'platform:darwin': { settings: 1, packages: 0, files: 0 } },
      skipped: { settings: 4, packages: 1 },
    });
    const rel = allFiles(f.bundle).map((p) => path.relative(f.bundle, p));
    assert.deepEqual(rel, [
      'config/common/files/agent/AGENTS.md',
      'config/common/files/agent/prompts/review.md',
      'config/common/manifest.json',
      'config/platforms/darwin/manifest.json',
      'config/platforms/linux/manifest.json',
      'manifests/complete.json',
      'manifests/inclusion-approval.json',
      'manifests/inclusion.json',
    ]);
    const approval = JSON.parse(fs.readFileSync(path.join(f.bundle, 'manifests/inclusion-approval.json'), 'utf8'));
    assert.equal(approval.approvalToken, token);
    assert.equal(approval.intent.platform, 'darwin');
    assert.equal(approval.intent.policySha256, sha(fs.readFileSync(f.policy)));
    for (const p of allFiles(f.bundle)) {
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
      assert.ok(!fs.readFileSync(p, 'utf8').includes(SECRET), 'secret copied into bundle');
    }
    assert.equal(fs.statSync(f.bundle).mode & 0o777, 0o700);
    const common = JSON.parse(fs.readFileSync(path.join(f.bundle, 'config/common/manifest.json'), 'utf8'));
    assert.deepEqual(common.settings, { defaultProvider: 'anthropic', defaultTools: ['read', 'bash'], editorPaddingX: 2 });
    // Versions removed, object form, autoload and filter order preserved, source order kept.
    assert.deepEqual(common.packages, ['npm:pi-lens', { autoload: false, extensions: ['dist/b.ts', '!dist/a.ts'], skills: [], source: 'npm:@scope/tools' }]);
    assert.equal(common.files[0].sha256, sha(fs.readFileSync(path.join(f.agent, 'AGENTS.md'))));
    assert.deepEqual(fs.readFileSync(path.join(f.bundle, 'manifests/inclusion.json')), fs.readFileSync(f.policy));
    const marker = JSON.parse(fs.readFileSync(path.join(f.bundle, 'manifests/complete.json'), 'utf8'));
    assert.equal(marker.policySha256, sha(fs.readFileSync(f.policy)));
    assert.equal(marker.approvalSha256, sha(fs.readFileSync(path.join(f.bundle, 'manifests/inclusion-approval.json'))));
    assert.equal(marker.layers.common, sha(fs.readFileSync(path.join(f.bundle, 'config/common/manifest.json'))));
    const linux = JSON.parse(fs.readFileSync(path.join(f.bundle, 'config/platforms/linux/manifest.json'), 'utf8'));
    assert.deepEqual([linux.settings, linux.packages, linux.files], [{}, [], []]);
  });

  it('converts approved absolute source-agent resource paths and keeps prefixes and builtins', () => {
    const p = basePolicy();
    (p.layers as Obj).common = { settings: ['extensions'] };
    const f = captured(fixture(p));
    const common = JSON.parse(fs.readFileSync(path.join(f.bundle, 'config/common/manifest.json'), 'utf8'));
    assert.deepEqual(common.settings.extensions, ['extensions/hello.ts', '-builtin:mcp', '-extensions/off.ts']);
  });

  it('refuses resource paths outside the source agent directory', () => {
    const f = fixture({ ...basePolicy(), layers: { common: { settings: ['extensions'] } } });
    const s = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
    s.extensions = [`/opt/${SECRET}/x.ts`];
    fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(s));
    expectError(captureArgs(f), 'resource-path-outside-agent');
    assert.ok(!fs.existsSync(f.bundle));
  });

  it('captures skills with a validated manual-only frontmatter expectation', () => {
    const expect = { frontmatter: { 'disable-model-invocation': true } };
    const pol = policyFor({ common: { files: [{ root: 'agent', path: 'skills/firecrawl/SKILL.md', class: 'skill-source', template: false, expect }] } });
    captured(fixture(pol));
    const bad = fixture(pol);
    fs.writeFileSync(path.join(bad.agent, 'skills/firecrawl/SKILL.md'), SKILL.replace('true', 'false'));
    expectError(captureArgs(bad), 'expectation-failed');
    assert.ok(!fs.existsSync(bad.bundle));
  });

  it('enforces an optional reviewed payload digest', () => {
    const pol = policyFor({ common: { files: [{ root: 'agent', path: 'prompts/review.md', class: 'prompt', template: false, sha256: sha('Review this.\n') }] } });
    captured(fixture(pol));
    const changed = policyFor({ common: { files: [{ root: 'agent', path: 'prompts/review.md', class: 'prompt', template: false, sha256: sha('other') }] } });
    expectError(captureArgs(fixture(changed)), 'file-digest-mismatch');
  });

  it('refuses an existing output, a missing parent and overlapping roots', () => {
    const f = fixture();
    fs.mkdirSync(f.bundle);
    expectError(captureArgs(f), 'output-exists', 1);
    assert.deepEqual(fs.readdirSync(f.bundle), []);
    const g = fixture();
    const t = ['--approve-inclusion', reviewToken(g)];
    expectError(['capture', '--policy', g.policy, '--source-agent', g.agent, '--platform', 'darwin', '--out', path.join(g.root, 'no', 'bundle'), ...t], 'output-parent-missing', 1);
    expectError(['capture', '--policy', g.policy, '--source-agent', g.agent, '--platform', 'darwin', '--out', path.join(g.agent, 'bundle'), ...t], 'roots-overlap');
    assert.ok(!fs.existsSync(path.join(g.agent, 'bundle')));
  });

  it('refuses live Pi locations before reading them', () => {
    const f = fixture();
    expectError(captureArgs(f), 'live-path-refused', 2, { PI_CODING_AGENT_DIR: f.agent });
    expectError(captureArgs(f), 'live-path-refused', 2, { PI_CODING_AGENT_DIR: f.root });
    // Lexical refusal happens before any filesystem access to these paths.
    const home = FAKE_HOME;
    const t = ['--approve-inclusion', ZERO_TOKEN];
    expectError(['capture', '--policy', f.policy, '--source-agent', path.join(home, '.pi', 'agent'), '--platform', 'darwin', '--out', f.bundle, ...t], 'live-path-refused');
    expectError(['capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'darwin', '--out', path.join(home, '.pi', 'bundle'), ...t], 'live-path-refused');
    expectError(['capture', '--policy', f.policy, '--source-agent', home, '--platform', 'darwin', '--out', f.bundle, ...t], 'live-path-refused');
    expectError(reviewArgs({ ...f, agent: path.join(home, '.pi-lens') }), 'live-path-refused');
    assert.ok(!fs.existsSync(f.bundle));
  });

  it('rejects malformed settings without publishing a bundle', () => {
    const cases: [string, string][] = [
      ['{"defaultProvider":"a","defaultProvider":"b"}', 'json-duplicate-key'],
      ['{"__proto__":{"x":1}}', 'json-unsafe-key'],
      ['\ufeff{}', 'json-bom'],
      ['{"editorPaddingX":12345678901234567890}', 'json-unsafe-number'],
      ['{"defaultProvider":"a","editorPaddingX": 9,"defaultTools":[],"theme":"t"}', 'setting-invalid'],
      ['[]', 'settings-invalid'],
      [`{"defaultProvider":"a","editorPaddingX":1,"defaultTools":[],"theme":"t","packages":"${SECRET}"}`, 'settings-invalid'],
      ['{"editorPaddingX":1,"defaultTools":[],"theme":"t"}', 'setting-missing'],
    ];
    for (const [text, code] of cases) {
      const f = fixture();
      fs.writeFileSync(path.join(f.agent, 'settings.json'), text);
      expectError(captureArgs(f), code);
      assert.ok(!fs.existsSync(f.bundle), code);
    }
  });

  it('rejects unsupported, missing or drifted package declarations', () => {
    const mutate = (pk: unknown[]) => {
      const f = fixture();
      const s = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
      s.packages = pk;
      fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(s));
      return f;
    };
    const tools = { source: 'npm:@scope/tools', autoload: false, extensions: ['dist/b.ts', '!dist/a.ts'], skills: [] };
    expectError(captureArgs(mutate(['npm:pi-lens', tools, `git:github.com/${SECRET}/x`])), 'package-unsupported');
    expectError(captureArgs(mutate(['npm:pi-lens', tools, 'npm:x@^1.0.0'])), 'package-unsupported');
    expectError(captureArgs(mutate(['npm:pi-lens', tools, { source: 'npm:y', secret: SECRET }])), 'package-unsupported');
    expectError(captureArgs(mutate(['npm:pi-lens', tools, 'npm:pi-lens@2'])), 'package-duplicate');
    expectError(captureArgs(mutate([tools])), 'package-missing');
    expectError(captureArgs(mutate(['npm:pi-lens', { ...tools, extensions: ['!dist/a.ts', 'dist/b.ts'] }])), 'package-filter-mismatch');
    expectError(captureArgs(mutate(['npm:pi-lens', { ...tools, autoload: true }])), 'package-filter-mismatch');
    expectError(captureArgs(mutate([{ source: 'npm:pi-lens' }, tools])), 'package-filter-mismatch');
  });

  it('refuses symlinks, special files, hard links, oversized and non-text payloads', () => {
    const prompt = (f: Fixture) => path.join(f.agent, 'prompts', 'review.md');
    const cases: [(f: Fixture) => void, string][] = [
      [(f) => { fs.rmSync(prompt(f)); fs.symlinkSync(path.join(f.agent, 'auth.json'), prompt(f)); }, 'symlink-refused'],
      [(f) => { fs.rmSync(path.join(f.agent, 'prompts'), { recursive: true }); fs.mkdirSync(path.join(f.root, 'elsewhere')); put(path.join(f.root, 'elsewhere', 'review.md'), 'x'); fs.symlinkSync(path.join(f.root, 'elsewhere'), path.join(f.agent, 'prompts')); }, 'symlink-refused'],
      [(f) => { fs.rmSync(prompt(f)); execFileSync('mkfifo', [prompt(f)]); }, 'special-file-refused'],
      [(f) => { fs.mkdirSync(path.join(f.root, 'x')); fs.linkSync(prompt(f), path.join(f.root, 'x', 'link.md')); }, 'hardlink-refused'],
      [(f) => fs.writeFileSync(prompt(f), Buffer.alloc(1024 * 1024 + 1, 0x61)), 'file-too-large'],
      [(f) => fs.writeFileSync(prompt(f), Buffer.from([0xff, 0xfe, 0x00])), 'content-invalid'],
      [(f) => fs.writeFileSync(prompt(f), 'a\0b'), 'content-invalid'],
      [(f) => fs.rmSync(prompt(f)), 'source-missing'],
      [(f) => fs.writeFileSync(path.join(f.agent, 'AGENTS.md'), `{{${SECRET}}}`), 'template-unresolved'],
    ];
    for (const [setup, code] of cases) {
      const f = fixture();
      setup(f);
      expectError(captureArgs(f), code);
      assert.ok(!fs.existsSync(f.bundle), code);
    }
  });

  it('rejects unsafe or unapproved policies', () => {
    const file = (p: string, cls: string, extra: Obj = {}) => ({ root: 'agent', path: p, class: cls, template: false, ...extra });
    const cases: [Obj, string][] = [
      [{ ...basePolicy(), approvedBy: SECRET }, 'policy-invalid'],
      [policyFor({ common: { files: [file('../outside.md', 'prompt')] } }), 'path-invalid'],
      [policyFor({ common: { files: [file('prompts/.hidden.md', 'prompt')] } }), 'path-invalid'],
      [policyFor({ common: { files: [file('settings.json', 'tool-config')] } }), 'path-prohibited'],
      [policyFor({ common: { files: [file('auth.json', 'tool-config')] } }), 'path-prohibited'],
      [policyFor({ common: { files: [file('extensions/x/node_modules/a.js', 'extension-source')] } }), 'path-invalid'],
      [policyFor({ common: { settings: ['httpProxy'] } }), 'setting-not-allowed'],
      [policyFor({ 'platform:linux': { settings: ['theme'] } }), 'policy-platform-mismatch'],
      [policyFor({ common: { files: [file('prompts/review.md', 'prompt')] }, 'platform:darwin': { files: [file('prompts/Review.md', 'prompt')] } }), 'path-alias'],
    ];
    for (const [pol, code] of cases) {
      const f = fixture(pol);
      expectError(captureArgs(f), code);
      assert.ok(!fs.existsSync(f.bundle), code);
    }
    const dup = fixture();
    fs.writeFileSync(dup.policy, '{"schemaVersion":1,"schemaVersion":1}');
    expectError(captureArgs(dup), 'json-duplicate-key');
  });

  it('requires the lens source exactly when a lens payload is approved', () => {
    const pol = policyFor({ common: { files: [{ root: 'lens-config', path: 'config.json', class: 'external-config', template: true }] } });
    const f = fixture(pol);
    const lens = path.join(f.root, 'lens.json');
    fs.writeFileSync(lens, '{"root":"{{HOME}}/x"}');
    expectError(captureArgs(f), 'lens-config-required');
    captured(f, ['--source-lens-config', lens]);
    assert.ok(fs.existsSync(path.join(f.bundle, 'config/common/files/lens-config/config.json')));
    const g = fixture();
    expectError(captureArgs(g, ['--source-lens-config', lens]), 'lens-config-unused');
    // Whole-file inputs inside the source agent directory are refused before reading.
    const h = fixture(pol);
    h.bundle = path.join(h.root, 'bundle-h');
    expectError(captureArgs(h, ['--source-lens-config', path.join(h.agent, 'auth.json')]), 'roots-overlap');
    const inside = path.join(h.agent, 'policy.json');
    fs.copyFileSync(h.policy, inside);
    expectError(['capture', '--policy', inside, '--source-agent', h.agent, '--platform', 'darwin', '--out', h.bundle, '--source-lens-config', lens, '--approve-inclusion', ZERO_TOKEN], 'roots-overlap');
  });
});

// ================================================================ plan

describe('plan', () => {
  it('produces a deterministic token for a complete plan and never mutates the filesystem', () => {
    const f = captured();
    const target = path.join(f.root, 'target-agent');
    const before = snapshot(f.root);
    const a = run(planArgs(f, target));
    const b = run(planArgs(f, target));
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.out?.status, 'ready');
    assert.match(String(a.out?.approvalToken), /^sha256:[0-9a-f]{64}$/);
    assert.equal(a.out?.approvalToken, b.out?.approvalToken);
    assert.deepEqual(a.out?.items, [
      { kind: 'setting', key: 'defaultProvider', operation: 'create' },
      { kind: 'setting', key: 'defaultTools', operation: 'activation-required' },
      { kind: 'setting', key: 'editorPaddingX', operation: 'create' },
      { kind: 'setting', key: 'theme', operation: 'create' },
      { kind: 'package', source: 'npm:pi-lens', operation: 'activation-required' },
      { kind: 'package', source: 'npm:@scope/tools', operation: 'activation-required' },
      { kind: 'file', root: 'agent', path: 'AGENTS.md', class: 'agent-context', operation: 'activation-required' },
      { kind: 'file', root: 'agent', path: 'prompts/review.md', class: 'prompt', operation: 'activation-required' },
      { kind: 'target', target: 'agent', operation: 'create' },
    ]);
    const text = a.stdout;
    for (const leak of ['anthropic', 'model-a', f.root, 'Review this', 'sha256:' + sha('Review this.\n')]) {
      assert.ok(!text.includes(leak), 'plan output exposes a value');
    }
  });

  it('binds the token to the canonical target, templates and every reviewed input', () => {
    const f = captured();
    const t1 = run(planArgs(f, path.join(f.root, 't1'))).out?.approvalToken;
    const t2 = run(planArgs(f, path.join(f.root, 't2'))).out?.approvalToken;
    assert.notEqual(t1, t2);
    // A symlinked ancestor resolves to the same canonical target and token.
    fs.symlinkSync(f.root, path.join(f.root, 'alias'));
    assert.equal(run(planArgs(f, path.join(f.root, 'alias', 't1'))).out?.approvalToken, t1);

    const tokenFor = (mut: (s: Obj) => void, pol = basePolicy()) => {
      const g = fixture(pol);
      const s = JSON.parse(fs.readFileSync(path.join(g.agent, 'settings.json'), 'utf8'));
      mut(s);
      fs.writeFileSync(path.join(g.agent, 'settings.json'), JSON.stringify(s));
      captured(g);
      // Same target spelling relative to each fixture root still differs, so compare within one target.
      const target = path.join(f.root, 'shared-target');
      return run(['plan', '--bundle', g.bundle, '--platform', 'darwin', '--target-agent', target]).out?.approvalToken;
    };
    const base = tokenFor(() => {});
    assert.equal(tokenFor(() => {}), base, 'identical content must give identical tokens');
    assert.notEqual(tokenFor((s) => { s.editorPaddingX = 3; }), base);
    assert.notEqual(tokenFor((s) => { s.defaultTools = ['bash', 'read']; }), base);
    assert.notEqual(tokenFor((s) => { (s.packages as unknown[]).reverse(); }), base);
    assert.notEqual(tokenFor((s) => { (s.packages as Obj[])[1] = { ...(s.packages as Obj[])[1], autoload: true }; }, (() => {
      const p = basePolicy();
      ((p.layers as Obj).common as Obj).packages = ['npm:pi-lens', { source: 'npm:@scope/tools', autoload: true, extensions: ['dist/b.ts', '!dist/a.ts'], skills: [] }];
      return p;
    })()), base);
  });

  it('merges common, platform and overlay layers in order with whole-value replacement', () => {
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    const lensFile = { root: 'lens-config', path: 'config.json', class: 'external-config', template: true };
    const sandbox = { root: 'agent', path: 'sandbox.json', class: 'tool-config', template: false };
    const pol = policyFor(
      {
        common: { settings: ['theme', 'enabledModels'], packages: ['npm:a', { source: 'npm:b', extensions: ['x.ts'] }, 'npm:c'] },
        'platform:darwin': { settings: ['enabledModels'], packages: [{ source: 'npm:b', extensions: [] }, 'npm:d'] },
        'platform:linux': { settings: ['theme'] },
      },
      { files: [sandbox, lensFile], packagesRemove: ['npm:c'] },
    );
    buildBundle(bundle, pol, {
      common: { settings: { theme: 'dark', enabledModels: ['m1', 'm2'] }, packages: ['npm:a', { source: 'npm:b', extensions: ['x.ts'] }, 'npm:c'] },
      'platform:darwin': { settings: { enabledModels: [] }, packages: [{ source: 'npm:b', extensions: [] }, 'npm:d'] },
      'platform:linux': { settings: { theme: 'light' } },
    });
    const overlay = path.join(root, 'overlay');
    writeLayer(overlay, 'overlay', {
      packagesRemove: ['npm:c'],
      files: [{ ...sandbox, content: '{"allow":[]}' }, { ...lensFile, content: '{"home":"{{HOME}}"}' }],
    });
    const f = { root, agent: '', policy: '', bundle };
    const target = path.join(root, 'agent');
    const lens = path.join(root, 'lens.json');
    const r = run(planArgs(f, target, ['--overlay', overlay, '--lens-config', lens]));
    assert.equal(r.code, 1);
    assert.equal(r.out?.status, 'incomplete', JSON.stringify(r.out?.items));
    assert.equal(r.out?.approvalToken, null);
    assert.equal(r.out?.overlay, true);
    const items = r.out?.items as Obj[];
    assert.deepEqual(
      items.filter((i) => i.kind === 'package').map((i) => i.source),
      ['npm:a', 'npm:b', 'npm:d'],
    );
    assert.deepEqual(
      items.filter((i) => i.kind === 'file').map((i) => [i.path, i.operation, i.reason]),
      [
        ['sandbox.json', 'incomplete', 'schema-adapter-unavailable'],
        ['config.json', 'incomplete', 'schema-adapter-unavailable'],
      ],
    );
    assert.deepEqual(items.at(-1), { kind: 'target', target: 'lens-config', operation: 'create' });

    // Without the overlay the merge is common → darwin and the plan is ready.
    const r2 = run(planArgs(f, target));
    assert.equal(r2.code, 0, r2.stderr);
    const r3 = run(planArgs(f, target, [], 'linux'));
    assert.equal(r3.code, 0, r3.stderr);
    assert.notEqual(r2.out?.approvalToken, r3.out?.approvalToken);
  });

  it('rejects overlay settings, packages, unapproved removals and unknown removals', () => {
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    buildBundle(bundle, policyFor({ common: { packages: ['npm:a'] } }, { packagesRemove: ['npm:a', 'npm:z'] }), { common: { packages: ['npm:a'] } });
    const f = { root, agent: '', policy: '', bundle };
    const target = path.join(root, 'agent');
    const cases: [LayerSpec & { settings?: Obj }, string][] = [
      [{ settings: { theme: 'x' } }, 'overlay-setting-not-allowed'],
      [{ packages: ['npm:new'] }, 'overlay-package-not-allowed'],
      [{ packagesRemove: ['npm:b'] }, 'policy-mismatch'],
      [{ packagesRemove: ['npm:z'] }, 'overlay-remove-unknown'],
      [{ files: [{ root: 'agent', path: 'sandbox.json', class: 'tool-config', template: false, content: '{}' }] }, 'policy-mismatch'],
    ];
    for (const [spec, code] of cases) {
      const ov = fs.mkdtempSync(path.join(root, 'ov-'));
      writeLayer(ov, 'overlay', spec);
      expectError(planArgs(f, target, ['--overlay', ov]), code);
    }
    const ok = fs.mkdtempSync(path.join(root, 'ov-'));
    writeLayer(ok, 'overlay', { packagesRemove: ['npm:a'] });
    const r = run(planArgs(f, target, ['--overlay', ok]));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual((r.out?.items as Obj[]).filter((i) => i.kind === 'package'), []);
  });

  it('classifies adapter-dependent files and local resource references as incomplete without a token', () => {
    const expect = { frontmatter: { 'disable-model-invocation': true } };
    const pol = policyFor({
      common: {
        settings: ['extensions'],
        files: [
          { root: 'agent', path: 'extensions/hello.ts', class: 'extension-source', template: false },
          { root: 'agent', path: 'skills/firecrawl/SKILL.md', class: 'skill-source', template: false, expect },
        ],
      },
    });
    const f = captured(fixture(pol));
    const r = run(planArgs(f, path.join(f.root, 'target')));
    assert.equal(r.code, 1);
    assert.equal(r.out?.status, 'incomplete');
    assert.equal(r.out?.approvalToken, null);
    assert.deepEqual(
      (r.out?.items as Obj[]).filter((i) => i.operation === 'incomplete').map((i) => i.reason),
      ['resource-reference-unverified', 'dependency-analysis-unavailable', 'dependency-analysis-unavailable'],
    );
  });

  it('accepts builtin and exclusion-only resource selections', () => {
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    buildBundle(bundle, policyFor({ common: { settings: ['extensions', 'skills'] } }), {
      common: { settings: { extensions: ['builtin:mcp', '+builtin:tool-search', '-builtin:codemode', '-extensions/a.ts', '!b/*.ts'], skills: [] } },
    });
    const r = run(planArgs({ root, agent: '', policy: '', bundle }, path.join(root, 'agent')));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual((r.out?.items as Obj[]).filter((i) => i.kind === 'setting').map((i) => i.operation), ['activation-required', 'activation-required']);
  });

  it('reports existing, aliased or parentless targets as conflicts without a token', () => {
    const f = captured();
    const expectConflict = (target: string, reasons: string[]) => {
      const before = snapshot(f.root);
      const r = run(planArgs(f, target));
      assert.deepEqual(snapshot(f.root), before);
      assert.equal(r.code, 1, r.stderr);
      assert.equal(r.out?.status, 'conflict');
      assert.equal(r.out?.approvalToken, null);
      const t = (r.out?.items as Obj[]).find((i) => i.kind === 'target');
      assert.equal(t?.operation, 'conflict');
      assert.ok(reasons.includes(String(t?.reason)), String(t?.reason));
    };
    const empty = path.join(f.root, 'empty');
    fs.mkdirSync(empty);
    expectConflict(empty, ['target-exists']);
    const file = path.join(f.root, 'file');
    fs.writeFileSync(file, '');
    expectConflict(file, ['target-exists']);
    const dangling = path.join(f.root, 'dangling');
    fs.symlinkSync(path.join(f.root, 'nowhere'), dangling);
    expectConflict(dangling, ['target-exists']);
    expectConflict(path.join(f.root, 'missing', 'agent'), ['target-parent-missing']);
    fs.mkdirSync(path.join(f.root, 'CaseAgent'));
    expectConflict(path.join(f.root, 'caseagent'), ['target-exists', 'target-alias-exists']);
    fs.mkdirSync(path.join(f.root, 'cafe\u0301'));
    expectConflict(path.join(f.root, 'caf\u00e9'), ['target-exists', 'target-alias-exists']);
  });

  it('checks the lens target: required, absent, parent present', () => {
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    const lensFile = { root: 'lens-config', path: 'config.json', class: 'external-config', template: false };
    buildBundle(bundle, policyFor({ common: { files: [lensFile] } }), { common: { files: [{ ...lensFile, content: '{}' }] } });
    const f = { root, agent: '', policy: '', bundle };
    const target = path.join(root, 'agent');
    expectError(planArgs(f, target), 'lens-config-required');
    const existing = path.join(root, 'existing.json');
    fs.writeFileSync(existing, '{}');
    const r = run(planArgs(f, target, ['--lens-config', existing]));
    assert.equal(r.out?.status, 'conflict');
    assert.deepEqual((r.out?.items as Obj[]).at(-1), { kind: 'target', target: 'lens-config', operation: 'conflict', reason: 'target-exists' });
    expectError(planArgs(f, target, ['--lens-config', path.join(target, 'lens.json')]), 'roots-overlap');
    const unused = captured();
    expectError(planArgs(unused, path.join(unused.root, 'agent'), ['--lens-config', path.join(unused.root, 'l.json')]), 'lens-config-unused');
  });

  it('refuses overlapping roots and live locations', () => {
    const f = captured();
    expectError(planArgs(f, path.join(f.bundle, 'agent')), 'roots-overlap');
    expectError(planArgs(f, f.root), 'roots-overlap');
    const ov = path.join(f.bundle, 'config');
    expectError(planArgs(f, path.join(f.root, 'agent'), ['--overlay', ov]), 'roots-overlap');
    const decoy = path.join(f.root, 'live');
    fs.mkdirSync(decoy);
    expectError(planArgs(f, path.join(decoy, 'agent')), 'live-path-refused', 2, { PI_CODING_AGENT_DIR: decoy });
    expectError(planArgs(f, path.join(f.root, 'agent')), 'live-path-refused', 2, { PI_CODING_AGENT_DIR: path.join(f.bundle, 'x') });
    expectError(planArgs(f, path.join(FAKE_HOME, '.pi', 'agent')), 'live-path-refused');
    // A symlinked alias of the (fixture) live directory is refused through its canonical path.
    fs.mkdirSync(path.join(FAKE_HOME, '.pi'), { recursive: true });
    const alias = path.join(f.root, 'pi-alias');
    fs.symlinkSync(path.join(FAKE_HOME, '.pi'), alias);
    expectError(planArgs(f, path.join(alias, 'agent')), 'live-path-refused');
  });

  it('refuses incomplete, tampered or policy-inconsistent bundles', () => {
    const target = (f: Fixture) => path.join(f.root, 'agent');
    const interrupted = captured();
    fs.rmSync(path.join(interrupted.bundle, 'manifests', 'complete.json'));
    expectError(planArgs(interrupted, target(interrupted)), 'bundle-incomplete');

    const payload = captured();
    fs.appendFileSync(path.join(payload.bundle, 'config/common/files/agent/prompts/review.md'), SECRET);
    expectError(planArgs(payload, target(payload)), 'payload-digest-mismatch');

    const manifest = captured();
    fs.appendFileSync(path.join(manifest.bundle, 'config/common/manifest.json'), ' ');
    expectError(planArgs(manifest, target(manifest)), 'manifest-digest-mismatch');

    const pol = captured();
    fs.appendFileSync(path.join(pol.bundle, 'manifests/inclusion.json'), ' ');
    expectError(planArgs(pol, target(pol)), 'policy-digest-mismatch');

    const marker = captured();
    fs.writeFileSync(path.join(marker.bundle, 'manifests/complete.json'), '{"schemaVersion":1}');
    expectError(planArgs(marker, target(marker)), 'completion-invalid');

    // Internally consistent digests but intent outside the approved policy.
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    buildBundle(bundle, policyFor({ common: { settings: ['theme'] } }), { common: { settings: { theme: 'x', defaultModel: 'm' } } });
    expectError(planArgs({ root, agent: '', policy: '', bundle }, path.join(root, 'agent')), 'policy-mismatch');
    const bundle2 = path.join(root, 'bundle2');
    buildBundle(bundle2, policyFor({ common: { packages: [{ source: 'npm:a', autoload: false }] } }), { common: { packages: ['npm:a'] } });
    expectError(planArgs({ root, agent: '', policy: '', bundle: bundle2 }, path.join(root, 'agent')), 'policy-mismatch');
    const bundle3 = path.join(root, 'bundle3');
    buildBundle(bundle3, policyFor({}), { common: { settings: { npmCommand: ['x'] } } });
    expectError(planArgs({ root, agent: '', policy: '', bundle: bundle3 }, path.join(root, 'agent')), 'setting-not-allowed');

    const link = captured();
    const p = path.join(link.bundle, 'config/common/files/agent/prompts/review.md');
    fs.rmSync(p);
    fs.symlinkSync(path.join(link.agent, 'prompts/review.md'), p);
    expectError(planArgs(link, target(link)), 'symlink-refused');
  });

  it('refuses a bundle whose root is a symlink', () => {
    const f = captured();
    const alias = path.join(f.root, 'bundle-link');
    fs.symlinkSync(f.bundle, alias);
    expectError(['plan', '--bundle', alias, '--platform', 'darwin', '--target-agent', path.join(f.root, 'agent')], 'symlink-refused');
  });
});

// ================================================================ CLI process

describe('CLI process', () => {
  const spawn = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'process output leaked a secret');
    return r;
  };

  it('runs capture review, capture and plan end to end with JSON output and exit statuses', () => {
    const f = fixture();
    const before = snapshot(f.root);
    const review = spawn(reviewArgs(f));
    assert.equal(review.status, 0, review.stderr);
    assert.deepEqual(snapshot(f.root), before);
    const token = JSON.parse(review.stdout).captureReviewToken;
    assert.match(token, /^sha256:[0-9a-f]{64}$/);
    const c = spawn(captureArgs(f, [], token));
    assert.equal(c.status, 0, c.stderr);
    assert.equal(JSON.parse(c.stdout).ok, true);
    const p = spawn(planArgs(f, path.join(f.root, 'target')));
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).status, 'ready');
    assert.equal(p.stderr, '');
    const conflict = spawn(planArgs(f, f.agent));
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stdout).approvalToken, null);
  });

  it('reports invocation errors as fixed codes without echoing input', () => {
    const f = fixture();
    const cases: string[][] = [
      [],
      ['unknown'],
      ['capture'],
      ['capture', '--policy', f.policy],
      [...captureArgs(f), '--extra', SECRET],
      [...captureArgs(f), '--out', f.bundle],
      ['capture', '--policy', `relative/${SECRET}`, '--source-agent', f.agent, '--platform', 'darwin', '--out', f.bundle],
      ['capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', SECRET, '--out', f.bundle],
      ['plan', '--bundle', f.bundle, '--platform', 'windows', '--target-agent', path.join(f.root, 'a')],
    ];
    for (const args of cases) {
      const r = spawn(args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.stdout, '');
      assert.deepEqual(JSON.parse(r.stderr), { ok: false, error: 'usage' });
    }
    const missing = spawn(['plan', '--bundle', path.join(f.root, SECRET), '--platform', 'darwin', '--target-agent', path.join(f.root, 'a')]);
    assert.equal(missing.status, 2);
    assert.deepEqual(JSON.parse(missing.stderr), { ok: false, error: 'bundle-missing' });
    assert.ok(!fs.existsSync(f.bundle));
  });

  it('applies the production live-path guard (path metadata only) to the real account home', () => {
    const f = fixture();
    // Lexical refusal: the real `.pi` path is refused before it is accessed; the
    // production guard only resolves its metadata (realpath), never its contents.
    const r = spawn(['plan', '--bundle', f.bundle, '--platform', 'darwin', '--target-agent', path.join(os.userInfo().homedir, '.pi', 'agent')]);
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stderr), { ok: false, error: 'live-path-refused' });
  });

  it('prints help', () => {
    const r = spawn(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /capture --policy/);
  });
});


// ================================================================ filesystem call recording

type FsEvent = [op: string, p: string];

/**
 * Record path-level filesystem calls made while `fn` runs, optionally failing
 * selected calls. Patches the shared `node:fs` module object that the sources
 * use, and always restores it.
 */
function withFs<T>(fn: () => T, fail?: (op: string, p: string) => string | undefined): { events: FsEvent[]; value: T } {
  const events: FsEvent[] = [];
  const fds = new Map<number, string>();
  const orig = {
    openSync: fs.openSync,
    fsyncSync: fs.fsyncSync,
    mkdirSync: fs.mkdirSync,
    lstatSync: fs.lstatSync,
    opendirSync: fs.opendirSync,
    realpath: fs.realpathSync.native,
  };
  const check = (op: string, p: string): void => {
    events.push([op, p]);
    const code = fail?.(op, p);
    if (code) throw Object.assign(new Error(code), { code });
  };
  const m = fs as unknown as Record<string, unknown>;
  m.openSync = (p: fs.PathLike, ...rest: unknown[]) => {
    check('open', String(p));
    const fd = (orig.openSync as (...a: unknown[]) => number)(p, ...rest);
    fds.set(fd, String(p));
    return fd;
  };
  m.fsyncSync = (fd: number) => {
    check('fsync', fds.get(fd) ?? '?');
    return orig.fsyncSync(fd);
  };
  m.mkdirSync = (p: fs.PathLike, ...rest: unknown[]) => {
    check('mkdir', String(p));
    return (orig.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  };
  m.lstatSync = (p: fs.PathLike, ...rest: unknown[]) => {
    check('lstat', String(p));
    return (orig.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
  };
  m.opendirSync = (p: fs.PathLike, ...rest: unknown[]) => {
    check('opendir', String(p));
    return (orig.opendirSync as (...a: unknown[]) => unknown)(p, ...rest);
  };
  (fs.realpathSync as unknown as Record<string, unknown>).native = (p: fs.PathLike, ...rest: unknown[]) => {
    check('realpath', String(p));
    return (orig.realpath as (...a: unknown[]) => unknown)(p, ...rest);
  };
  try {
    return { events, value: fn() };
  } finally {
    Object.assign(m, { openSync: orig.openSync, fsyncSync: orig.fsyncSync, mkdirSync: orig.mkdirSync, lstatSync: orig.lstatSync, opendirSync: orig.opendirSync });
    (fs.realpathSync as unknown as Record<string, unknown>).native = orig.realpath;
  }
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

// ================================================================ capture approval

describe('capture approval', () => {
  it('capture-review is read-only and prints only a token and counts', () => {
    const f = fixture();
    const before = snapshot(f.root);
    const r = run(reviewArgs(f));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapshot(f.root), before);
    assert.ok(!fs.existsSync(f.bundle));
    assert.deepEqual(Object.keys(r.out ?? {}).sort(), ['captureReviewToken', 'command', 'layers', 'ok', 'skipped']);
    assert.equal(r.out?.command, 'capture-review');
    assert.match(String(r.out?.captureReviewToken), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(r.out?.skipped, { settings: 4, packages: 1 });
    for (const leak of ['anthropic', 'model-a', f.root, 'Review this', sha('Review this.\n')]) assert.ok(!r.stdout.includes(leak), 'review output exposes a value');
    assert.equal(reviewToken(f), r.out?.captureReviewToken, 'review is deterministic');
    // Review never creates output and refuses an `--out` argument.
    expectError([...reviewArgs(f), '--out', f.bundle], 'usage');
  });

  it('refuses a missing, malformed or mismatched approval before creating output', () => {
    const f = fixture();
    const noToken = ['capture', '--policy', f.policy, '--source-agent', f.agent, '--platform', 'darwin', '--out', f.bundle];
    expectError(noToken, 'inclusion-approval-required');
    expectError([...noToken, '--approve-inclusion', 'sha256:abc'], 'approval-token-invalid');
    expectError([...noToken, '--approve-inclusion', reviewToken(f).toUpperCase()], 'approval-token-invalid');
    expectError([...noToken, '--approve-inclusion', ZERO_TOKEN], 'inclusion-approval-mismatch', 1);
    assert.ok(!fs.existsSync(f.bundle));
    const r = run([...noToken, '--approve-inclusion', reviewToken(f)]);
    assert.equal(r.code, 0, r.stderr);
  });

  it('invalidates the token when selected content, settings, policy or platform change', () => {
    const editSettings = (f: Fixture, mut: (s: Obj) => void) => {
      const s = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
      mut(s);
      fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(s, null, 2));
    };
    const stale = (mut: (f: Fixture) => void) => {
      const f = fixture();
      const token = reviewToken(f);
      mut(f);
      assert.notEqual(reviewToken(f), token);
      expectError(captureArgs(f, [], token), 'inclusion-approval-mismatch', 1);
      assert.ok(!fs.existsSync(f.bundle));
    };
    stale((f) => fs.writeFileSync(path.join(f.agent, 'prompts', 'review.md'), 'Review that.\n'));
    stale((f) => fs.appendFileSync(path.join(f.agent, 'AGENTS.md'), 'more\n'));
    stale((f) => editSettings(f, (s) => { s.editorPaddingX = 3; }));
    stale((f) => editSettings(f, (s) => { s.defaultTools = ['bash', 'read']; }));
    stale((f) => editSettings(f, (s) => { (s.packages as unknown[]).splice(0, 2, (s.packages as unknown[])[1], (s.packages as unknown[])[0]); }));
    stale((f) => fs.appendFileSync(f.policy, '\n'));
    // Unselected source settings and packages are not part of the reviewed intent.
    const g = fixture();
    const token = reviewToken(g);
    editSettings(g, (s) => { s.defaultModel = 'other'; (s.packages as unknown[]).push('npm:another'); });
    assert.equal(reviewToken(g), token);
    // The source platform is bound.
    const h = fixture(policyFor({ common: { settings: ['defaultProvider'] } }));
    assert.notEqual(run(reviewArgs(h, [], 'linux')).out?.captureReviewToken, reviewToken(h));
    expectError(['capture', '--policy', h.policy, '--source-agent', h.agent, '--platform', 'linux', '--out', h.bundle, '--approve-inclusion', reviewToken(h)], 'inclusion-approval-mismatch', 1);
  });

  it('binds the approval record into the completion marker and revalidates it on every load', () => {
    const target = (f: Fixture) => path.join(f.root, 'target');
    const approvalFile = (f: Fixture) => path.join(f.bundle, 'manifests', 'inclusion-approval.json');
    const marker = (f: Fixture) => JSON.parse(fs.readFileSync(path.join(f.bundle, 'manifests', 'complete.json'), 'utf8'));
    const rewrite = (f: Fixture, edit: (a: Obj) => void) => {
      const a = JSON.parse(fs.readFileSync(approvalFile(f), 'utf8'));
      edit(a);
      const bytes = JSON.stringify(a);
      fs.writeFileSync(approvalFile(f), bytes);
      const m = marker(f);
      m.approvalSha256 = sha(bytes);
      fs.writeFileSync(path.join(f.bundle, 'manifests', 'complete.json'), JSON.stringify(m));
    };

    const ok = captured();
    assert.equal(run(planArgs(ok, target(ok))).code, 0);

    const appended = captured();
    fs.appendFileSync(approvalFile(appended), ' ');
    expectError(planArgs(appended, target(appended)), 'inclusion-approval-digest-mismatch');

    const removed = captured();
    fs.rmSync(approvalFile(removed));
    expectError(planArgs(removed, target(removed)), 'inclusion-approval-missing');

    // Edited intent with the old token: the token no longer matches the record.
    const edited = captured();
    rewrite(edited, (a) => { ((a.intent as Obj).layers as Obj).common = { ...(((a.intent as Obj).layers as Obj).common as Obj), settings: { defaultProvider: 'x', defaultTools: [], editorPaddingX: 0 } }; });
    expectError(planArgs(edited, target(edited)), 'inclusion-approval-invalid');

    // A self-consistent record (token recomputed) that does not describe this bundle.
    const forged = captured();
    rewrite(forged, (a) => {
      const intent = a.intent as Obj;
      ((intent.layers as Obj).common as Obj).settings = { defaultProvider: 'x', defaultTools: [], editorPaddingX: 0 };
      a.approvalToken = captureToken(intent as never);
    });
    expectError(planArgs(forged, target(forged)), 'inclusion-approval-bundle-mismatch');

    const otherPolicy = captured();
    rewrite(otherPolicy, (a) => {
      const intent = a.intent as Obj;
      intent.policySha256 = sha('other');
      a.approvalToken = captureToken(intent as never);
    });
    expectError(planArgs(otherPolicy, target(otherPolicy)), 'inclusion-approval-bundle-mismatch');

    const extraKey = captured();
    rewrite(extraKey, (a) => { a.approvedBy = 'someone'; });
    expectError(planArgs(extraKey, target(extraKey)), 'inclusion-approval-invalid');

    // A marker without the approval digest (an approval-less bundle) is refused.
    const old = captured();
    const m = marker(old);
    delete m.approvalSha256;
    fs.writeFileSync(path.join(old.bundle, 'manifests', 'complete.json'), JSON.stringify(m));
    expectError(planArgs(old, target(old)), 'completion-invalid');

    // Identical captures record identical approvals, so their plan tokens agree.
    const a = captured();
    const b = captured();
    const shared = path.join(a.root, 'shared-target');
    assert.equal(run(planArgs(a, shared)).out?.approvalToken, run(planArgs(b, shared)).out?.approvalToken);
  });
});

// ================================================================ prohibited sources (I1)

describe('prohibited source paths', () => {
  const cases: [string, string][] = [
    ['extensions/auth.json', 'extension-source'],
    ['skills/example/sessions/run.jsonl', 'skill-source'],
    ['extensions/x/bin/tool.sh', 'extension-source'],
    ['AGENTS.override.md', 'agent-context'],
    ['models.json', 'tool-config'],
    ['skills/example/CLAUDE.md', 'skill-source'],
  ];

  it('refuses them during policy validation, before any source file is opened or copied', () => {
    for (const [p, cls] of cases) {
      const f = fixture(policyFor({ common: { settings: ['defaultProvider'], files: [{ root: 'agent', path: p, class: cls, template: false }] } }));
      put(path.join(f.agent, p), SECRET);
      fs.chmodSync(path.join(f.agent, p), 0o000);
      for (const args of [reviewArgs(f), captureArgs(f)]) {
        const { events } = withFs(() => expectError(args, 'path-prohibited'));
        // Only the policy file is opened; nothing inside the source agent directory, not even settings.json.
        assert.deepEqual(events.filter(([op, q]) => op === 'open' && under(q, f.agent)), [], p);
      }
      assert.ok(!fs.existsSync(f.bundle), p);
    }
  });

  it('refuses them in bundle manifests before any payload is opened', () => {
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    const file = { root: 'agent', path: 'extensions/auth.json', class: 'extension-source', template: false };
    buildBundle(bundle, policyFor({}), { common: { files: [{ ...file, content: SECRET }] } });
    const payload = path.join(bundle, 'config/common/files/agent/extensions/auth.json');
    fs.chmodSync(payload, 0o000);
    const { events } = withFs(() => expectError(planArgs({ root, agent: '', policy: '', bundle }, path.join(root, 'agent')), 'path-prohibited'));
    assert.ok(!events.some(([op, q]) => op === 'open' && q === payload));
    assert.ok(!fs.existsSync(path.join(root, 'agent')));
  });
});

// ================================================================ theme and built-in readiness (I2)

describe('theme and built-in readiness', () => {
  it('reports invalid theme files and unresolved custom theme names without a token', () => {
    for (const content of ['null\n', '{}\n', '{"name":"mine","colors":{}}\n']) {
      const f = fixture(policyFor({ common: { settings: ['theme'], files: [{ root: 'agent', path: 'themes/mine.json', class: 'theme', template: false }] } }));
      put(path.join(f.agent, 'themes', 'mine.json'), content);
      const s = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
      s.theme = 'mine';
      fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(s));
      captured(f);
      const r = run(planArgs(f, path.join(f.root, 'target')));
      assert.equal(r.code, 1);
      assert.equal(r.out?.status, 'incomplete');
      assert.equal(r.out?.approvalToken, null);
      assert.deepEqual(
        (r.out?.items as Obj[]).filter((i) => i.operation === 'incomplete').map((i) => [i.kind, i.reason]),
        [['setting', 'theme-reference-unverified'], ['file', 'theme-invalid']],
      );
    }
    const dup = fixture(policyFor({ common: { files: [{ root: 'agent', path: 'themes/dark.json', class: 'theme', template: false }] } }));
    fs.writeFileSync(path.join(dup.agent, 'themes', 'dark.json'), '{"a":1,"a":1}');
    expectError(reviewArgs(dup), 'json-duplicate-key');
  });

  it('accepts built-in theme names as ordinary settings', () => {
    for (const theme of ['dark', 'light/dark', 'system']) {
      const root = tmp();
      const bundle = path.join(root, 'bundle');
      buildBundle(bundle, policyFor({ common: { settings: ['theme'] } }), { common: { settings: { theme } } });
      const r = run(planArgs({ root, agent: '', policy: '', bundle }, path.join(root, 'agent')));
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual((r.out?.items as Obj[])[0], { kind: 'setting', key: 'theme', operation: 'create' });
    }
  });

  it('refuses unknown or misplaced built-in references', () => {
    const withSettings = (key: string, value: unknown) => {
      const f = fixture(policyFor({ common: { settings: [key] } }));
      const s = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
      s[key] = value;
      fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(s));
      return f;
    };
    expectError(reviewArgs(withSettings('extensions', ['builtin:x'])), 'resource-builtin-unsupported');
    expectError(reviewArgs(withSettings('extensions', ['-builtin:read'])), 'resource-builtin-unsupported');
    expectError(reviewArgs(withSettings('skills', ['builtin:mcp'])), 'resource-builtin-unsupported');
    expectError(reviewArgs(withSettings('themes', ['-builtin:mcp'])), 'resource-builtin-unsupported');
    const root = tmp();
    const bundle = path.join(root, 'bundle');
    buildBundle(bundle, policyFor({ common: { settings: ['prompts'] } }), { common: { settings: { prompts: ['builtin:mcp'] } } });
    expectError(planArgs({ root, agent: '', policy: '', bundle }, path.join(root, 'agent')), 'resource-builtin-unsupported');
  });
});

// ================================================================ output safety (I4, I5)

describe('capture output safety', () => {
  it('refuses an output whose case or normalization alias exists, before creating anything', () => {
    for (const [existing, out] of [['BUNDLE', 'bundle'], ['cafe\u0301', 'caf\u00e9']]) {
      const f = fixture();
      f.bundle = path.join(f.root, out);
      const token = reviewToken(f);
      fs.mkdirSync(path.join(f.root, existing));
      const before = fs.readdirSync(f.root).sort();
      const r = run(captureArgs(f, [], token));
      assert.equal(r.code, 1, r.stderr);
      assert.ok(['output-exists', 'output-alias-exists'].includes(String(r.err?.error)), r.stderr);
      assert.deepEqual(fs.readdirSync(f.root).sort(), before);
      // Simulate a case- and normalization-sensitive filesystem: the exact name is
      // absent, so only the bounded sibling alias scan can refuse it.
      const { events } = withFs(
        () => expectError(captureArgs(f, [], token), 'output-alias-exists', 1),
        (op, p) => (op === 'lstat' && p === f.bundle ? 'ENOENT' : undefined),
      );
      assert.ok(!events.some(([op]) => op === 'mkdir'));
      assert.deepEqual(fs.readdirSync(f.root).sort(), before);
    }
  });

  it('syncs the canonical output parent after creating the root and before the completion marker', () => {
    const f = fixture();
    const token = reviewToken(f);
    const { events } = withFs(() => assert.equal(run(captureArgs(f, [], token)).code, 0));
    const at = (pred: (e: FsEvent) => boolean, from = 0) => events.findIndex((e, i) => i >= from && pred(e));
    const mkdir = at(([op, p]) => op === 'mkdir' && p === f.bundle);
    const parentSync = at(([op, p]) => op === 'fsync' && p === f.root, mkdir);
    const firstChild = at(([op, p]) => op === 'mkdir' && p !== f.bundle, mkdir);
    const approval = at(([op, p]) => op === 'open' && p === path.join(f.bundle, 'manifests', 'inclusion-approval.json'));
    const complete = at(([op, p]) => op === 'open' && p === path.join(f.bundle, 'manifests', 'complete.json'));
    assert.ok(mkdir >= 0 && parentSync > mkdir && firstChild > parentSync, 'parent synced right after root creation');
    assert.ok(approval > parentSync && complete > approval, 'completion marker written last');
  });

  it('leaves no usable bundle when syncing the output parent fails', () => {
    const f = fixture();
    const token = reviewToken(f);
    const { events } = withFs(
      () => expectError(captureArgs(f, [], token), 'write-failed', 1),
      (op, p) => (op === 'fsync' && p === f.root ? 'EIO' : undefined),
    );
    assert.ok(!events.some(([op, p]) => op === 'open' && p.endsWith(path.join('manifests', 'complete.json'))));
    assert.ok(!fs.existsSync(path.join(f.bundle, 'manifests', 'complete.json')));
    expectError(planArgs(f, path.join(f.root, 'agent')), 'bundle-incomplete');
  });
});

// ================================================================ approval record size (I7)

describe('approval record size', () => {
  const MIB = 1024 * 1024;
  const BOTH = { common: { settings: ['enabledModels', 'defaultModel'] }, 'platform:darwin': { settings: ['enabledModels'] } };

  /** Source with only the given settings; `layers` selects them into the policy. */
  function sized(settings: Obj, layers: Obj = BOTH): Fixture {
    const root = tmp();
    const agent = path.join(root, 'agent');
    put(path.join(agent, 'settings.json'), JSON.stringify(settings));
    return { root, agent, policy: writePolicy(root, policyFor(layers)), bundle: path.join(root, 'bundle') };
  }

  const models = (count: number, len: number) => Array.from({ length: count }, (_, i) => `m${i}-`.padEnd(len, 'a'));
  const fileSize = (f: Fixture, rel: string) => fs.statSync(path.join(f.bundle, rel)).size;
  const APPROVAL = 'manifests/inclusion-approval.json';

  /** Both review and capture refuse with the fixed code, print no token or value, and create nothing. */
  function refused(f: Fixture, tokens: string[]): void {
    const before = snapshot(f.root);
    const r = run(reviewArgs(f));
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(r.err, { ok: false, error: 'inclusion-approval-too-large' });
    assert.equal(r.stdout, '');
    assert.ok(!r.stderr.includes('sha256:') && !r.stderr.includes('aaaa'), 'refusal exposes a token or value');
    for (const token of tokens) {
      const { events } = withFs(() => expectError(captureArgs(f, [], token), 'inclusion-approval-too-large'));
      assert.ok(!events.some(([op]) => op === 'mkdir'), 'capture created a directory');
    }
    assert.ok(!fs.existsSync(f.bundle));
    assert.deepEqual(snapshot(f.root), before);
  }

  it('refuses a record over the read limit in review and capture even when every manifest fits', () => {
    const settings = { enabledModels: models(200, 3000), defaultModel: 'm' };
    // Each input and each layer manifest fits: capture the same settings into one layer.
    const single = captured(sized(settings, { common: { settings: ['enabledModels', 'defaultModel'] } }));
    assert.ok(fs.statSync(path.join(single.agent, 'settings.json')).size < MIB);
    const manifest = fileSize(single, 'config/common/manifest.json');
    assert.ok(manifest > 500 * 1024 && manifest < MIB, 'single layer manifest near but under the limit');
    assert.ok(fileSize(single, APPROVAL) < MIB);
    assert.equal(run(planArgs(single, path.join(single.root, 'target'))).code, 0);
    const previous = reviewToken(single);

    // Selecting the same key in the platform layer too puts it into the record twice.
    const f = sized(settings);
    fs.copyFileSync(single.policy, path.join(f.root, 'single-policy.json'));
    const fitting = reviewToken({ ...f, policy: path.join(f.root, 'single-policy.json') });
    refused(f, [previous, fitting, ZERO_TOKEN]);
  });

  it('accepts a record of exactly the limit and refuses one byte more', () => {
    // Calibrate: capture once, then lengthen strings so the record is exactly 1 MiB.
    // ASCII only; each `enabledModels` byte appears twice in the record, `defaultModel` once.
    const base = models(170, 3000);
    const probe = captured(sized({ enabledModels: base, defaultModel: 'm' }));
    const gap = MIB - fileSize(probe, APPROVAL);
    assert.ok(gap > 0 && gap < 170 * 1096 * 2, 'calibration within reach');
    let pad = Math.floor(gap / 2);
    const grown = base.map((s) => {
      const add = Math.min(pad, 4096 - s.length);
      pad -= add;
      return s + 'a'.repeat(add);
    });
    const exact = { enabledModels: grown, defaultModel: 'm'.repeat(1 + (gap % 2)) };

    const ok = captured(sized(exact));
    assert.equal(fileSize(ok, APPROVAL), MIB);
    assert.equal(run(planArgs(ok, path.join(ok.root, 'target'))).code, 0, 'a record at the limit loads');

    const over = sized({ ...exact, defaultModel: `${exact.defaultModel}m` });
    refused(over, [reviewToken(ok)]);
  });
});

// ================================================================ guard context (I8)

describe('live-path guard context', () => {
  it('lets in-process runs canonicalize only the fixture home, never the real account locations', () => {
    const home = os.userInfo().homedir;
    const real = [path.join(home, '.pi'), path.join(home, '.pi-lens')];
    const { events } = withFs(() => {
      const f = captured();
      assert.equal(run(planArgs(f, path.join(f.root, 'target'))).code, 0);
    });
    assert.ok(events.some(([op, p]) => op === 'realpath' && p === path.join(FAKE_HOME, '.pi')), 'fixture home guarded');
    assert.deepEqual(events.filter(([, p]) => real.some((r) => under(p, r))), []);
  });
});
