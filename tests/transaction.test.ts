/**
 * Internal fresh-restore transaction engine against real temporary
 * directories only. Every call passes a temporary fixture home as the guard
 * context and fake OS identity probes (boot identity, hostname, PID probe), so
 * no test reads a live Pi location or runs the boot identity subprocess.
 * Failures are injected through the engine's internal `fault` seam.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { USAGE, main } from '../src/cli.ts';
import { ToolError } from '../src/errors.ts';
import {
  applyRestore,
  inspectRestore,
  resolveRestore,
  rollbackRestore,
  type InspectResult,
  type RestorePacket,
  type TxOptions,
} from '../src/transaction.ts';
import { judgeLock, parseBootId, type LockRecord, type TxDeps } from '../src/transaction-fs.ts';
import type { Platform } from '../src/schema.ts';

const temps: string[] = [];
after(() => {
  for (const t of temps) {
    try {
      execFileSync('chmod', ['-R', 'u+rwx', t]);
    } catch {
      // ignore
    }
    fs.rmSync(t, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-tx-test-')));
  temps.push(d);
  return d;
}

const FAKE_HOME = tmp();
const GUARD = { home: FAKE_HOME };
const BOOT = '11111111-2222-4333-8444-555555555555';
const OTHER_BOOT = '99999999-2222-4333-8444-555555555555';
const OWNER_PID = 4_000_001;
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const PLATFORM = process.platform as Platform;
const TOKEN = `sha256:${'a'.repeat(64)}`;
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

function deps(over: Partial<TxDeps> = {}): Partial<TxDeps> {
  return {
    platform: PLATFORM,
    bootId: () => BOOT,
    hostname: () => 'fixture-host',
    uid: () => UID,
    pid: () => OWNER_PID,
    probePid: (pid: number) => (pid === OWNER_PID ? 'esrch' : 'alive'),
    ...over,
  };
}

function opts(over: Partial<TxDeps> = {}, env: Record<string, string | undefined> = {}): TxOptions {
  return { env, guard: GUARD, deps: deps(over) };
}

const SKILL = '---\nname: firecrawl\ndescription: Manual only.\ndisable-model-invocation: true\n---\nUse only when asked.\n';
const FILES: [RestorePacket['files'][number]['root'], string, RestorePacket['files'][number]['class'], string][] = [
  ['agent', 'AGENTS.md', 'agent-context', '# Rules\nBe careful.\n'],
  ['agent', 'extensions/hello.ts', 'extension-source', 'export default function hello() {}\n'],
  ['agent', 'skills/firecrawl/SKILL.md', 'skill-source', SKILL],
  ['agent', 'prompts/review.md', 'prompt', 'Review the change.\n'],
  ['agent', 'dev-kit/models.json', 'tool-config', '{"routes":[]}\n'],
  ['lens-config', 'config.json', 'external-config', '{"lsp":true}\n'],
];
const SETTINGS = { defaultProvider: 'anthropic', editorPaddingX: 2, extensions: ['extensions/hello.ts', '-builtin:mcp'] };
const PACKAGES = ['npm:pi-lens', { source: 'npm:@scope/tools', autoload: false, extensions: ['dist/a.ts'] }];

interface Fx {
  root: string;
  state: string;
  agent: string;
  lensDir: string;
  lens: string;
  bundle: string;
  packet: RestorePacket;
  sentinels: Map<string, string>;
}

/** `small` keeps one nested agent file and the lens file, no settings: the cheapest packet that crosses every boundary. */
function fixture(kind: 'full' | 'small' = 'full'): Fx {
  const root = tmp();
  const bundle = path.join(root, 'bundle');
  const lensDir = path.join(root, 'lens');
  fs.mkdirSync(bundle);
  fs.mkdirSync(lensDir);
  const sentinels = new Map<string, string>([
    [path.join(root, 'sibling.txt'), 'unrelated sibling\n'],
    [path.join(lensDir, 'other.json'), '{"keep":true}\n'],
    [path.join(bundle, 'manifest.json'), '{}\n'],
  ]);
  for (const [p, c] of sentinels) fs.writeFileSync(p, c);
  const packet: RestorePacket = {
    planToken: TOKEN,
    platform: PLATFORM,
    state: path.join(root, 'state'),
    agentTarget: path.join(root, 'agent'),
    lensTarget: path.join(lensDir, 'config.json'),
    settings: JSON.parse(JSON.stringify(SETTINGS)),
    packages: JSON.parse(JSON.stringify(PACKAGES)),
    files: FILES.map(([r, p, c, text]) => ({ root: r, path: p, class: c, bytes: Buffer.from(text), sha256: sha(text) })),
    protectedRoots: [bundle],
  };
  if (kind === 'small') {
    packet.files = packet.files.filter((f) => f.path === 'extensions/hello.ts' || f.root === 'lens-config');
    packet.settings = {};
    packet.packages = [];
  }
  return { root, state: packet.state, agent: packet.agentTarget, lensDir, lens: path.join(lensDir, 'config.json'), bundle, packet, sentinels };
}

function destOf(fx: Fx, r: string, p: string): string {
  return r === 'lens-config' ? fx.lens : path.join(fx.agent, ...p.split('/'));
}

function expectCode(fn: () => unknown, code: string | string[], exit?: 1 | 2): ToolError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ToolError, `expected ToolError ${String(code)}, got ${String(caught)}`);
  const codes = Array.isArray(code) ? code : [code];
  assert.ok(codes.includes(caught.code), `expected ${codes.join('|')}, got ${caught.code}`);
  if (exit !== undefined) assert.equal(caught.exit, exit);
  return caught;
}

/** Recursive listing: relative path → kind/size/inode/ctime, for "nothing changed" checks. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (p: string): void => {
    for (const n of fs.readdirSync(p).sort()) {
      const f = path.join(p, n);
      const st = fs.lstatSync(f, { bigint: true });
      const kind = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f';
      out.set(path.relative(dir, f), `${kind}:${st.ino}:${st.ctimeNs}:${st.size}:${(st.mode & 0o7777n).toString(8)}`);
      if (st.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out;
}

function checkSentinels(fx: Fx): void {
  for (const [p, c] of fx.sentinels) assert.equal(fs.readFileSync(p, 'utf8'), c, 'unrelated file changed');
}

function stageFiles(fx: Fx): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (!fs.existsSync(p)) return;
    for (const n of fs.readdirSync(p)) {
      const f = path.join(p, n);
      if (n.startsWith('.pi-machine-config-stage-')) out.push(n);
      else if (fs.lstatSync(f).isDirectory()) walk(f);
    }
  };
  walk(fx.agent);
  walk(fx.lensDir);
  return out.sort();
}

type JournalDoc = {
  tx: string;
  status: string;
  root: { phase: string };
  outputs: { root: string; path: string; phase: string; stage: string; note: string | null; stageId: unknown; targetId: unknown }[];
  resolutions: { action: string; class: string; locks: LockRecord[] }[];
};

function journal(fx: Fx): JournalDoc {
  return JSON.parse(fs.readFileSync(path.join(fx.state, 'journal.json'), 'utf8')) as JournalDoc;
}

function inspect(fx: Fx, over: Partial<TxDeps> = {}): InspectResult {
  return inspectRestore(fx.state, opts(over));
}

const NEXT: Record<string, string> = {
  'lock-stale': 'release-lock',
  'gate-stale': 'release-gate',
  unfinished: 'abandon',
  'published-unfinished': 'finalize',
  unfinalized: 'finalize',
  applied: 'rollback',
  partial: 'rollback',
  'rollback-pending': 'rollback',
  conflict: 'record-conflict',
};

/** Resolve explicitly, one classified step at a time, until a terminal class. Returns the visited classes. */
function drive(fx: Fx): string[] {
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = inspect(fx);
    seen.push(r.class);
    const action = NEXT[r.class];
    if (action === undefined) return seen;
    assert.deepEqual(r.actions, [action], `actions for ${r.class}`);
    resolveRestore(fx.state, { tx: r.tx ?? '', expect: r.class, action }, opts());
  }
  assert.fail('recovery did not terminate');
}

const LOCK_POINTS = /^(lock-release|target-lock-release)/;

/** Crash (locks kept) at the second stage creation: one output applied, state and target locks remain. */
function crashed(over: Partial<TxDeps> = {}, kind: 'full' | 'small' = 'small'): Fx {
  const fx = fixture(kind);
  let n = 0;
  let failed = false;
  expectCode(
    () =>
      applyRestore(fx.packet, opts({
        ...over,
        fault: (p) => {
          if (failed && LOCK_POINTS.test(p)) throw new Error('crash');
          if (p === 'stage-create' && ++n === 2) {
            failed = true;
            throw new Error('crash');
          }
        },
      })),
    'stage-failed',
    1,
  );
  assert.ok(fs.existsSync(path.join(fx.state, 'lock.json')));
  assert.ok(fs.existsSync(path.join(fx.agent, '.pi-machine-config-lock')));
  return fx;
}

/** Fault hook that throws at the `index`-th fault event; in crash mode also keeps every lock afterwards. */
function failAt(index: number, crash: boolean, log?: string[]): (p: string) => void {
  let n = 0;
  let failed = false;
  return (p: string) => {
    log?.push(p);
    if (failed && crash && LOCK_POINTS.test(p)) throw new Error('crash');
    if (n++ === index) {
      failed = true;
      throw new Error('injected');
    }
  };
}

// ================================================================ apply

describe('applyRestore', () => {
  it('creates a fresh agent target and lens file with private modes and no leftovers', () => {
    const fx = fixture();
    const r = applyRestore(fx.packet, opts());
    assert.match(r.tx, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...r, tx: '' }, { tx: '', status: 'applied', outputs: FILES.length + 1, directories: 5, warnings: [] });
    for (const [root, p, , text] of FILES) {
      const dest = destOf(fx, root, p);
      assert.equal(fs.readFileSync(dest, 'utf8'), text);
      const st = fs.lstatSync(dest);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(st.nlink, 1);
    }
    const settings = JSON.parse(fs.readFileSync(path.join(fx.agent, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { ...SETTINGS, packages: PACKAGES });
    assert.equal(fs.lstatSync(path.join(fx.agent, 'settings.json')).mode & 0o777, 0o600);
    for (const d of ['', 'extensions', 'skills', 'skills/firecrawl', 'prompts', 'dev-kit']) {
      assert.equal(fs.lstatSync(path.join(fx.agent, d)).mode & 0o777, 0o700, d);
    }
    assert.equal(fs.lstatSync(fx.state).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(fx.state), ['journal.json']);
    assert.equal(fs.lstatSync(path.join(fx.state, 'journal.json')).mode & 0o777, 0o600);
    assert.deepEqual(stageFiles(fx), []);
    assert.ok(!fs.existsSync(path.join(fx.agent, '.pi-machine-config-lock')));
    assert.deepEqual(fs.readdirSync(fx.lensDir).sort(), ['config.json', 'other.json']);
    checkSentinels(fx);

    const j = journal(fx);
    assert.equal(j.status, 'applied');
    assert.ok(j.outputs.every((o) => o.phase === 'applied' && o.stage.startsWith('.pi-machine-config-stage-')));
    const ids = j.outputs.map((o) => o.targetId as { birthtimeNs: string; ctimeNs: string });
    assert.ok(ids.every((id) => /^[1-9][0-9]*$/.test(id.birthtimeNs) && /^[0-9]+$/.test(id.ctimeNs)));

    const i = inspect(fx);
    assert.equal(i.class, 'applied');
    assert.deepEqual(i.actions, ['rollback']);
    assert.deepEqual(i.locks, { state: 'absent', target: 'absent', gate: 'absent' });
    assert.ok(i.items.every((x) => x.observed === 'applied' || x.observed === 'ok'));
    assert.ok(!JSON.stringify(i).includes(fx.root), 'inspect output must not contain absolute paths');
    assert.ok(!JSON.stringify(r).includes(fx.root));
  });

  it('copies payload bytes before validating, so later caller mutation has no effect', () => {
    const fx = fixture('small');
    const original = Buffer.from(fx.packet.files[0].bytes);
    let mutated = false;
    applyRestore(fx.packet, {
      ...opts(),
      deps: deps({
        fault: (p) => {
          if (p === 'stage-create' && !mutated) {
            fx.packet.files[0].bytes.fill(0x41);
            mutated = true;
          }
        },
      }),
    });
    assert.ok(mutated);
    assert.deepEqual(fs.readFileSync(path.join(fx.agent, 'extensions/hello.ts')), original);
  });

  it('applies without a lens file and without settings', () => {
    const fx = fixture();
    fx.packet.lensTarget = null;
    fx.packet.files = fx.packet.files.filter((f) => f.root === 'agent');
    fx.packet.settings = {};
    fx.packet.packages = [];
    const r = applyRestore(fx.packet, opts());
    assert.equal(r.outputs, FILES.length - 1);
    assert.ok(!fs.existsSync(path.join(fx.agent, 'settings.json')));
    assert.ok(!fs.existsSync(fx.lens));
  });

  it('refuses every existing or ambiguous target before creating state', () => {
    const cases: [string, (fx: Fx) => void, string[]][] = [
      ['empty agent dir', (fx) => fs.mkdirSync(fx.agent), ['target-exists']],
      [
        'apparently identical agent dir',
        (fx) => {
          fs.mkdirSync(fx.agent);
          fs.writeFileSync(path.join(fx.agent, 'AGENTS.md'), FILES[0][3]);
        },
        ['target-exists'],
      ],
      ['dangling symlink', (fx) => fs.symlinkSync(path.join(fx.root, 'nowhere'), fx.agent), ['target-exists']],
      ['case alias', (fx) => fs.mkdirSync(path.join(fx.root, 'AGENT')), ['target-exists', 'target-alias-exists']],
      ['NFD alias', (fx) => {
        fx.packet.agentTarget = path.join(fx.root, 'caf\u00e9');
        fs.mkdirSync(path.join(fx.root, 'cafe\u0301'));
      }, ['target-exists', 'target-alias-exists']],
      ['lens exists', (fx) => fs.writeFileSync(fx.lens, '{}'), ['target-exists']],
      ['agent parent missing', (fx) => {
        fx.packet.agentTarget = path.join(fx.root, 'missing', 'agent');
      }, ['target-parent-missing']],
      ['state exists', (fx) => fs.mkdirSync(fx.state), ['state-exists']],
      ['state parent missing', (fx) => {
        fx.packet.state = path.join(fx.root, 'missing', 'state');
      }, ['state-parent-missing']],
    ];
    for (const [name, setup, codes] of cases) {
      const fx = fixture();
      setup(fx);
      const before = snapshot(fx.root);
      expectCode(() => applyRestore(fx.packet, opts()), codes, 1);
      assert.deepEqual(snapshot(fx.root), before, `${name}: nothing may be written`);
    }
  });

  it('refuses live Pi locations lexically, through symlinked aliases and via PI_CODING_AGENT_DIR', () => {
    fs.mkdirSync(path.join(FAKE_HOME, '.pi'), { recursive: true });
    fs.mkdirSync(path.join(FAKE_HOME, '.pi-lens'), { recursive: true });
    const cases: [string, (fx: Fx) => Record<string, string>][] = [
      ['agent in ~/.pi', (fx) => ((fx.packet.agentTarget = path.join(FAKE_HOME, '.pi', 'agent')), {})],
      ['state in ~/.pi-lens', (fx) => ((fx.packet.state = path.join(FAKE_HOME, '.pi-lens', 'state')), {})],
      ['lens in ~/.pi-lens', (fx) => ((fx.packet.lensTarget = path.join(FAKE_HOME, '.pi-lens', 'config.json')), {})],
      [
        'symlinked alias',
        (fx) => {
          fs.symlinkSync(path.join(FAKE_HOME, '.pi'), path.join(fx.root, 'alias'));
          fx.packet.agentTarget = path.join(fx.root, 'alias', 'agent');
          return {};
        },
      ],
      [
        'PI_CODING_AGENT_DIR',
        (fx) => {
          fs.mkdirSync(path.join(fx.root, 'custom'));
          fx.packet.agentTarget = path.join(fx.root, 'custom', 'agent');
          return { PI_CODING_AGENT_DIR: path.join(fx.root, 'custom') };
        },
      ],
    ];
    for (const [name, setup] of cases) {
      const fx = fixture();
      const env = setup(fx);
      const home = snapshot(FAKE_HOME);
      const before = snapshot(fx.root);
      expectCode(() => applyRestore(fx.packet, opts({}, env)), 'live-path-refused', 2);
      assert.deepEqual(snapshot(fx.root), before, name);
      assert.deepEqual(snapshot(FAKE_HOME), home, name);
    }
  });

  it('keeps state, targets, protected roots and the tool checkout disjoint', () => {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const cases: [string, (fx: Fx) => void][] = [
      ['state in bundle', (fx) => (fx.packet.state = path.join(fx.bundle, 'state'))],
      ['agent in bundle', (fx) => (fx.packet.agentTarget = path.join(fx.bundle, 'agent'))],
      ['state inside agent', (fx) => (fx.packet.state = path.join(fx.agent, 'state'))],
      ['lens inside agent', (fx) => (fx.packet.lensTarget = path.join(fx.agent, 'config.json'))],
      ['lens equals state', (fx) => (fx.packet.lensTarget = fx.packet.state)],
      ['state case alias of agent', (fx) => (fx.packet.state = path.join(fx.root, 'AGENT'))],
      ['agent in tool checkout', (fx) => (fx.packet.agentTarget = path.join(repo, '.state', 'agent'))],
    ];
    for (const [name, setup] of cases) {
      const fx = fixture();
      setup(fx);
      const before = snapshot(fx.root);
      expectCode(() => applyRestore(fx.packet, opts()), 'roots-overlap', 2);
      assert.deepEqual(snapshot(fx.root), before, name);
    }
    assert.ok(!fs.existsSync(path.join(repo, '.state', 'agent')));
  });

  it('revalidates the packet and refuses unapproved content before writing', () => {
    type Mut = (p: RestorePacket) => void;
    const file = (root: string, p: string, cls: string, text: string) =>
      ({ root, path: p, class: cls, bytes: Buffer.from(text), sha256: sha(text) }) as RestorePacket['files'][number];
    const cases: [string, Mut, string][] = [
      ['unknown setting', (p) => (p.settings.npmCommand = ['x']), 'setting-not-allowed'],
      ['packages as a setting', (p) => (p.settings.packages = []), 'setting-not-allowed'],
      ['bad setting value', (p) => (p.settings.editorPaddingX = 9), 'setting-invalid'],
      ['versioned package', (p) => p.packages.push('npm:x@1.0.0'), 'package-versioned'],
      ['git package', (p) => p.packages.push('git:github.com/a/b'), 'package-unsupported'],
      ['duplicate package', (p) => p.packages.push('npm:pi-lens'), 'package-duplicate'],
      ['credential file', (p) => p.files.push(file('agent', 'extensions/auth.json', 'extension-source', '{}')), 'path-prohibited'],
      ['raw settings file', (p) => p.files.push(file('agent', 'settings.json', 'tool-config', '{}')), 'path-prohibited'],
      ['settings class', (p) => p.files.push(file('agent', 'settings.json', 'settings', '{}')), 'destination-not-allowed'],
      ['wrong class destination', (p) => p.files.push(file('agent', 'notes/a.md', 'prompt', 'x')), 'destination-not-allowed'],
      ['traversal', (p) => p.files.push(file('agent', 'extensions/../x.ts', 'extension-source', 'x')), 'path-invalid'],
      ['dot component', (p) => p.files.push(file('agent', 'extensions/.pi-machine-config-lock', 'extension-source', 'x')), 'path-invalid'],
      ['digest mismatch', (p) => (p.files[0].sha256 = '0'.repeat(64)), 'packet-digest-mismatch'],
      ['invalid JSON tool config', (p) => (p.files[4] = file('agent', 'dev-kit/models.json', 'tool-config', '{bad')), 'json-syntax'],
      ['NUL byte', (p) => (p.files[0] = file('agent', 'AGENTS.md', 'agent-context', 'a\0b')), 'content-invalid'],
      ['duplicate file', (p) => p.files.push(p.files[0]), 'file-duplicate'],
      ['alias file', (p) => p.files.push(file('agent', 'prompts/Review.md', 'prompt', 'x')), 'path-alias'],
      ['alias directory', (p) => p.files.push(file('agent', 'Extensions/b.ts', 'extension-source', 'x')), ['destination-not-allowed', 'path-alias'] as unknown as string],
      ['file is also a directory', (p) => p.files.push(file('agent', 'extensions/hello.ts/x.ts', 'extension-source', 'x')), 'path-conflict'],
      ['lens target missing', (p) => (p.lensTarget = null), 'lens-target-required'],
      ['lens target unused', (p) => (p.files = p.files.filter((f) => f.root !== 'lens-config')), 'lens-target-unused'],
      ['bad plan token', (p) => (p.planToken = 'sha256:xyz'), 'approval-token-invalid'],
      ['bytes not binary', (p) => ((p.files[0] as { bytes: unknown }).bytes = 'text'), 'packet-invalid'],
      ['empty', (p) => {
        p.files = [];
        p.settings = {};
        p.packages = [];
        p.lensTarget = null;
      }, 'packet-empty'],
      ['relative state', (p) => (p.state = 'state'), 'usage'],
      ['protected root missing', (p) => p.protectedRoots.push('/nonexistent-pmc-root'), 'protected-root-missing'],
    ];
    for (const [name, mut, code] of cases) {
      const fx = fixture();
      mut(fx.packet);
      const before = snapshot(fx.root);
      const codes = Array.isArray(code) ? code : [code];
      expectCode(() => applyRestore(fx.packet, opts()), codes);
      assert.deepEqual(snapshot(fx.root), before, name);
    }
    const fx = fixture();
    expectCode(() => applyRestore(fx.packet, opts({ platform: PLATFORM === 'darwin' ? 'linux' : 'darwin' })), 'platform-mismatch', 2);
    assert.ok(!fs.existsSync(fx.state));
  });

  it('refuses a transaction whose journal or settings could exceed 1 MiB before any write', () => {
    const fx = fixture();
    const long = ['d', 'e', 'f', 'g'].map((c) => c.repeat(200)).join('/');
    for (let i = 0; i < 1100; i++) {
      const p = `extensions/${long}/x${i}.ts`;
      fx.packet.files.push({ root: 'agent', path: p, class: 'extension-source', bytes: Buffer.from('x'), sha256: sha('x') });
    }
    const before = snapshot(fx.root);
    expectCode(() => applyRestore(fx.packet, opts()), 'transaction-too-large', 2);
    assert.deepEqual(snapshot(fx.root), before);

    const fx2 = fixture();
    fx2.packet.settings.enabledModels = Array.from({ length: 4096 }, (_, i) => `m${i}-${'x'.repeat(300)}`);
    expectCode(() => applyRestore(fx2.packet, opts()), 'settings-too-large', 2);
    assert.ok(!fs.existsSync(fx2.state) && !fs.existsSync(fx2.agent));
  });

  it('records a missing boot identity as a warning and in the locks', () => {
    const fx = fixture('small');
    const r = applyRestore(fx.packet, opts({ bootId: () => null }));
    assert.deepEqual(r.warnings, ['boot-identity-unavailable']);
  });
});

// ================================================================ concurrency

describe('concurrent transactions', () => {
  it('lets only one state directory create a given target (exclusive root mkdir)', () => {
    const a = fixture();
    const bState = path.join(a.root, 'state-b');
    let bTx = '';
    const hook = (p: string) => {
      if (p === 'root-mkdir' && bTx === '') {
        bTx = applyRestore({ ...a.packet, state: bState }, opts()).tx;
      }
    };
    expectCode(() => applyRestore(a.packet, opts({ fault: hook })), 'target-exists', 1);
    assert.match(bTx, /^[0-9a-f]{32}$/);
    // B owns the target; A never touched it.
    assert.equal(inspectRestore(bState, opts()).class, 'applied');
    const i = inspect(a);
    assert.equal(i.class, 'unfinished');
    assert.equal(i.items[0].phase, 'not-created');
    assert.deepEqual(drive(a), ['unfinished', 'closed']);
    assert.equal(inspectRestore(bState, opts()).class, 'applied');
    assert.equal(fs.readFileSync(path.join(a.agent, 'AGENTS.md'), 'utf8'), FILES[0][3]);
    expectCode(() => rollbackRestore(a.state, journal(a).tx, opts()), 'rollback-unavailable', 1);
    assert.equal(rollbackRestore(bState, bTx, opts()).removed, FILES.length + 1);
  });

  it('refuses a second apply into the same state directory', () => {
    const a = fixture('small');
    let second: unknown;
    const hook = (p: string) => {
      if (p === 'lock-create' && second === undefined) {
        try {
          applyRestore({ ...a.packet, agentTarget: path.join(a.root, 'agent-b'), lensTarget: path.join(a.lensDir, 'b.json') }, opts());
          second = 'applied';
        } catch (e) {
          second = e;
        }
      }
    };
    applyRestore(a.packet, opts({ fault: hook }));
    assert.ok(second instanceof ToolError && second.code === 'state-exists');
    assert.ok(!fs.existsSync(path.join(a.root, 'agent-b')));
    assert.equal(inspect(a).class, 'applied');
  });

  it('blocks rollback and recovery while a live owner holds the lock', () => {
    const fx = crashed({}, 'small');
    const alive = { probePid: () => 'alive' as const };
    const i = inspect(fx, alive);
    assert.equal(i.class, 'lock-held');
    assert.equal(i.reason, 'owner-alive');
    assert.deepEqual(i.actions, []);
    const tx = journal(fx).tx;
    expectCode(() => rollbackRestore(fx.state, tx, opts(alive)), 'lock-held', 1);
    expectCode(() => resolveRestore(fx.state, { tx, expect: 'lock-stale', action: 'release-lock' }, opts(alive)), 'expect-mismatch', 1);
    expectCode(() => resolveRestore(fx.state, { tx, expect: 'lock-held', action: 'release-lock' }, opts(alive)), 'action-not-allowed', 2);
    assert.ok(fs.existsSync(path.join(fx.state, 'lock.json')));
  });
});

// ================================================================ rollback

describe('rollbackRestore', () => {
  it('removes only proven outputs, keeps directories, and never touches later replacements', () => {
    const fx = fixture();
    const { tx } = applyRestore(fx.packet, opts());
    const r = rollbackRestore(fx.state, tx, opts());
    assert.deepEqual(r, { tx, status: 'rolled-back', removed: FILES.length + 1 });
    for (const [root, p] of FILES) assert.ok(!fs.existsSync(destOf(fx, root, p)), p);
    assert.ok(!fs.existsSync(path.join(fx.agent, 'settings.json')));
    for (const d of ['extensions', 'skills/firecrawl', 'prompts', 'dev-kit']) assert.ok(fs.lstatSync(path.join(fx.agent, d)).isDirectory());
    checkSentinels(fx);
    assert.equal(inspect(fx).class, 'rolled-back');
    // A replacement created after rollback is never removed by repetition.
    fs.writeFileSync(path.join(fx.agent, 'AGENTS.md'), FILES[0][3]);
    fs.writeFileSync(fx.lens, FILES[5][3]);
    assert.deepEqual(rollbackRestore(fx.state, tx, opts()), { tx, status: 'rolled-back', removed: 0 });
    assert.equal(fs.readFileSync(path.join(fx.agent, 'AGENTS.md'), 'utf8'), FILES[0][3]);
    assert.ok(fs.existsSync(fx.lens));
    // The target still exists, so a new apply to it is refused.
    const again = fixture();
    expectCode(() => applyRestore({ ...again.packet, agentTarget: fx.agent, lensTarget: null, files: again.packet.files.filter((f) => f.root === 'agent') }, opts()), 'target-exists', 1);
  });

  it('preserves the whole group when any output was edited, replaced, relinked or removed', () => {
    const tampers: [string, (fx: Fx) => void, string][] = [
      ['edited same size', (fx) => fs.writeFileSync(path.join(fx.agent, 'prompts/review.md'), 'Review the chanGe.\n'), 'output-changed'],
      [
        'identical replacement',
        (fx) => {
          const p = path.join(fx.agent, 'prompts/review.md');
          fs.unlinkSync(p);
          fs.writeFileSync(p, FILES[3][3], { mode: 0o600 });
        },
        'output-changed',
      ],
      ['metadata change', (fx) => fs.chmodSync(fx.lens, 0o644), 'output-changed'],
      ['extra hardlink', (fx) => fs.linkSync(path.join(fx.agent, 'AGENTS.md'), path.join(fx.root, 'extra')), 'output-changed'],
      [
        'symlink replacement',
        (fx) => {
          const p = path.join(fx.agent, 'extensions/hello.ts');
          fs.renameSync(p, path.join(fx.root, 'moved.ts'));
          fs.symlinkSync(path.join(fx.root, 'moved.ts'), p);
        },
        'output-changed',
      ],
      ['removed', (fx) => fs.unlinkSync(path.join(fx.agent, 'settings.json')), 'output-missing'],
      [
        'replaced directory',
        (fx) => {
          fs.renameSync(path.join(fx.agent, 'dev-kit'), path.join(fx.root, 'dev-kit-old'));
          fs.mkdirSync(path.join(fx.agent, 'dev-kit'));
          fs.copyFileSync(path.join(fx.root, 'dev-kit-old', 'models.json'), path.join(fx.agent, 'dev-kit', 'models.json'));
        },
        'parent-changed',
      ],
    ];
    for (const [name, tamper, reason] of tampers) {
      const fx = fixture();
      const { tx } = applyRestore(fx.packet, opts());
      tamper(fx);
      const before = snapshot(fx.root);
      expectCode(() => rollbackRestore(fx.state, tx, opts()), 'rollback-conflict', 1);
      const i = inspect(fx);
      assert.equal(i.class, 'conflict', name);
      assert.equal(i.reason, reason, name);
      assert.deepEqual(i.actions, ['record-conflict']);
      expectCode(() => resolveRestore(fx.state, { tx, expect: 'conflict', action: 'rollback' }, opts()), 'action-not-allowed', 2);
      const after1 = snapshot(fx.root);
      after1.delete('state/journal.json');
      before.delete('state/journal.json');
      assert.deepEqual(after1, before, `${name}: nothing removed`);
      resolveRestore(fx.state, { tx, expect: 'conflict', action: 'record-conflict' }, opts());
      assert.equal(inspect(fx).class, 'preserved');
      expectCode(() => rollbackRestore(fx.state, tx, opts()), 'rollback-unavailable', 1);
      for (const [root, p] of FILES) {
        if (name === 'symlink replacement' && p === 'extensions/hello.ts') continue;
        if (name === 'replaced directory' && p === 'dev-kit/models.json') continue;
        assert.ok(fs.existsSync(destOf(fx, root, p)), `${name}: ${p} preserved`);
      }
      checkSentinels(fx);
    }
  });

  it('continues an interrupted rollback and treats a replacement as a conflict', () => {
    const fx = fixture();
    const { tx } = applyRestore(fx.packet, opts());
    let n = 0;
    const hook = (p: string) => {
      if (p === 'rollback-unlink' && ++n === 3) throw new Error('injected');
    };
    expectCode(() => rollbackRestore(fx.state, tx, opts({ fault: hook })), 'rollback-failed', 1);
    assert.equal(inspect(fx).class, 'rollback-pending');
    assert.deepEqual(drive(fx), ['rollback-pending', 'rolled-back']);
    for (const [root, p] of FILES) assert.ok(!fs.existsSync(destOf(fx, root, p)));

    const fx2 = fixture();
    const tx2 = applyRestore(fx2.packet, opts()).tx;
    expectCode(
      () => rollbackRestore(fx2.state, tx2, opts({ fault: (p) => {
        if (p === 'rollback-dirsync') throw new Error('injected');
      } })),
      'rollback-failed',
      1,
    );
    const j = journal(fx2);
    const first = j.outputs.find((o) => o.phase === 'rollback-pending' && !fs.existsSync(destOf(fx2, o.root, o.path)));
    assert.ok(first);
    fs.writeFileSync(destOf(fx2, first.root, first.path), 'someone else\n');
    const i = inspect(fx2);
    assert.equal(i.class, 'conflict');
    assert.deepEqual(drive(fx2), ['conflict', 'preserved']);
    assert.equal(fs.readFileSync(destOf(fx2, first.root, first.path), 'utf8'), 'someone else\n');
  });
});

// ================================================================ crash recovery

describe('injected failures and explicit recovery', () => {
  const events: string[] = [];
  {
    const fx = fixture('small');
    applyRestore(fx.packet, opts({ fault: (p) => events.push(p) }));
  }
  const outputs = 2;
  /** Journal checkpoints of the small packet, in protocol order. */
  const SAVES = [
    'initial',
    'root-intent',
    'root-created',
    'target-lock-intent',
    'target-lock-held',
    'dirs-intent',
    'dirs-created',
    ...Array.from({ length: outputs }, (_, k) => ['staging', 'prepared', 'published', `applied:${k}`]).flat(),
    'final',
  ];

  interface Expected {
    label: string;
    /** First classification after any stale lock release; `no-state` when nothing was created. */
    cls: string;
    lockKept: boolean;
  }

  /**
   * Protocol model: the on-disk state if the process stops *before* each
   * fault event. A checkpoint becomes visible when its rename completes; the
   * unjournaled effects of a completed root mkdir, link or stage unlink are
   * what recovery sees until the next checkpoint.
   */
  function model(): Expected[] {
    const out: Expected[] = [];
    let saves = 0;
    let effect: string | null = null;
    let stateMade = false;
    let lockMade = false;
    let lockReleased = false;
    const classOf = (): string => {
      if (!stateMade) return 'no-state';
      if (saves === 0) return 'corrupt';
      if (effect === 'root-mkdir' || effect === 'unstage') return 'conflict';
      if (effect === 'link') return 'published-unfinished';
      const cp = SAVES[saves - 1];
      if (cp === 'published') return 'published-unfinished';
      if (cp === `applied:${outputs - 1}`) return 'unfinalized';
      if (cp === 'final') return 'applied';
      return 'unfinished';
    };
    for (const p of events) {
      const label = p.startsWith('journal-') ? `${p}@${SAVES[saves]}` : p;
      out.push({ label, cls: classOf(), lockKept: lockMade && !lockReleased });
      if (p === 'state-mkdir') stateMade = true;
      if (p === 'lock-create') lockMade = true;
      if (p === 'lock-release' && saves === SAVES.length) lockReleased = true;
      if (p === 'root-mkdir' || p === 'link' || p === 'unstage') effect = p;
      if (p === 'journal-rename') {
        saves++;
        effect = null;
      }
    }
    return out;
  }
  const expected = model();

  it('crosses every apply boundary in protocol order', () => {
    assert.equal(expected.length, events.length);
    for (const p of [
      'state-mkdir',
      'state-parent-sync',
      'lock-create',
      'lock-dirsync',
      'journal-write',
      'journal-write-sync',
      'journal-rename',
      'journal-dirsync',
      'root-mkdir',
      'root-parent-sync',
      'target-lock-create',
      'target-lock-dirsync',
      'dir-mkdir',
      'dir-sync',
      'stage-create',
      'stage-create-sync',
      'stage-dirsync',
      'link',
      'link-dirsync',
      'unstage',
      'unstage-dirsync',
      'target-lock-release',
      'lock-release',
    ]) {
      assert.ok(events.includes(p), p);
    }
    assert.equal(events.filter((p) => p === 'journal-rename').length, SAVES.length);
    // Every write is preceded by its durable intent: stage after `staging`, link after `prepared`.
    const order = events.filter((p) => ['stage-create', 'link', 'unstage', 'root-mkdir', 'journal-rename'].includes(p));
    assert.ok(order.indexOf('root-mkdir') > order.indexOf('journal-rename'));
  });

  /** Run one injected failure and drive explicit recovery to a terminal class. */
  function runCase(i: number, crash: boolean): void {
    const want = expected[i];
    const tag = `${want.label} (${crash ? 'crash' : 'failure'})`;
    const fx = fixture('small');
    let threw: unknown;
    try {
      applyRestore(fx.packet, opts({ fault: failAt(i, crash) }));
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof ToolError && threw.exit === 1, `${tag}: fixed-code failure`);
    checkSentinels(fx);
    if (want.cls === 'no-state') {
      assert.ok(!fs.existsSync(fx.state) && !fs.existsSync(fx.agent), tag);
      return;
    }
    let first = inspect(fx);
    if (crash && want.lockKept && want.cls !== 'corrupt') {
      assert.equal(first.class, 'lock-stale', `${tag}: stale lock`);
      const before = snapshot(fx.root);
      inspect(fx);
      assert.deepEqual(snapshot(fx.root), before, `${tag}: inspect is read-only`);
      resolveRestore(fx.state, { tx: first.tx ?? '', expect: 'lock-stale', action: 'release-lock' }, opts());
      assert.ok(!fs.existsSync(path.join(fx.state, 'lock.json')), tag);
      first = inspect(fx);
    }
    assert.equal(first.class, want.cls, tag);
    if (first.class === 'corrupt') {
      assert.equal(first.reason, 'journal-missing', tag);
      assert.ok(!fs.existsSync(fx.agent), `${tag}: no target before the first journal`);
      return;
    }
    const visited = drive(fx);
    const final = visited[visited.length - 1];
    assert.equal(final, want.cls === 'conflict' ? 'preserved' : visited.includes('applied') || visited.includes('partial') ? 'rolled-back' : 'closed', `${tag}: ${visited.join('>')}`);
    checkSentinels(fx);
    const j = journal(fx);
    if (final === 'preserved') {
      assert.ok(j.outputs.some((o) => o.phase === 'conflict') || j.root.phase === 'conflict', tag);
      return;
    }
    for (const o of j.outputs) assert.ok(!fs.existsSync(destOf(fx, o.root, o.path)), `${tag}: ${o.path} cleaned`);
    const orphans = j.outputs.filter((o) => o.note === 'orphan-preserved').map((o) => o.stage).sort();
    assert.deepEqual(stageFiles(fx), orphans, `${tag}: only recorded orphans remain`);
  }

  // Failure mode covers every event except the repeated pre-rename journal sub-steps after the first
  // checkpoint (same on-disk outcome as `journal-rename`); crash mode covers every non-journal event and
  // every checkpoint rename.
  const failureCases = expected.map((e, i) => ({ e, i })).filter(({ e, i }) => !/^journal-write/.test(events[i]) || e.label.endsWith('@initial')).map(({ i }) => i);
  const crashCases = expected.map((_, i) => i).filter((i) => !events[i].startsWith('journal-') || events[i] === 'journal-rename');
  const CHUNK = 16;
  for (const [mode, cases] of [['failure', failureCases], ['crash', crashCases]] as const) {
    for (let c = 0; c < cases.length; c += CHUNK) {
      const slice = cases.slice(c, c + CHUNK);
      it(`classifies and resolves a ${mode} at boundaries ${c + 1}-${c + slice.length} of ${cases.length}`, () => {
        for (const i of slice) runCase(i, mode === 'crash');
      });
    }
  }

  it('abandons an EEXIST destination as not-created and never touches it', () => {
    const fx = fixture();
    const foreign = path.join(fx.agent, 'AGENTS.md');
    expectCode(
      () => applyRestore(fx.packet, opts({ fault: (p) => {
        if (p === 'link' && !fs.existsSync(foreign)) fs.writeFileSync(foreign, FILES[0][3]);
      } })),
      'target-conflict',
      1,
    );
    const i = inspect(fx);
    assert.equal(i.class, 'unfinished');
    const item = i.items.find((x) => x.path === 'AGENTS.md');
    assert.equal(item?.phase, 'not-created');
    assert.equal(item?.note, 'destination-exists');
    const r = resolveRestore(fx.state, { tx: i.tx ?? '', expect: 'unfinished', action: 'abandon' }, opts());
    assert.equal(r.removed, 1);
    assert.deepEqual(stageFiles(fx), []);
    assert.equal(fs.readFileSync(foreign, 'utf8'), FILES[0][3], 'identical bytes are not ownership');
    assert.equal(inspect(fx).class, 'closed');
  });

  it('preserves a stage whose identity changed and records it as an orphan', () => {
    const fx = fixture();
    let stagePath = '';
    expectCode(
      () => applyRestore(fx.packet, opts({ fault: (p) => {
        if (p === 'link' && stagePath === '') {
          stagePath = path.join(fx.agent, stageFiles(fx)[0]);
          throw new Error('injected');
        }
      } })),
      'publish-failed',
      1,
    );
    fs.appendFileSync(stagePath, 'tampered');
    const i = inspect(fx);
    assert.equal(i.class, 'unfinished');
    resolveRestore(fx.state, { tx: i.tx ?? '', expect: 'unfinished', action: 'abandon' }, opts());
    assert.ok(fs.existsSync(stagePath));
    assert.equal(journal(fx).outputs[0].note, 'orphan-preserved');
  });

  it('treats an edited stage/destination pair as a conflict, not a finalizable pair', () => {
    const fx = fixture();
    expectCode(
      () => applyRestore(fx.packet, opts({ fault: (p) => {
        if (p === 'link-dirsync') throw new Error('injected');
      } })),
      'publish-failed',
      1,
    );
    assert.equal(inspect(fx).class, 'published-unfinished');
    fs.appendFileSync(path.join(fx.agent, 'AGENTS.md'), 'x');
    const i = inspect(fx);
    assert.equal(i.class, 'conflict');
    assert.equal(i.reason, 'identity-unproven');
    assert.deepEqual(drive(fx), ['conflict', 'preserved']);
    assert.equal(stageFiles(fx).length, 1, 'the pair is preserved');
  });
});

// ================================================================ state integrity and requests

describe('corrupt state and recovery requests', () => {
  function applied(): { fx: Fx; tx: string } {
    const fx = fixture('small');
    return { fx, tx: applyRestore(fx.packet, opts()).tx };
  }

  it('refuses unreadable, unsafe or inconsistent state without automated resolution', () => {
    const cases: [string, (fx: Fx) => void, string][] = [
      ['garbage journal', (fx) => fs.writeFileSync(path.join(fx.state, 'journal.json'), '{nope'), 'journal-invalid'],
      [
        'duplicate key',
        (fx) => {
          const p = path.join(fx.state, 'journal.json');
          fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('{', '{"tx":"x",'));
        },
        'journal-invalid',
      ],
      [
        'inconsistent phase',
        (fx) => {
          const p = path.join(fx.state, 'journal.json');
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          j.outputs[0].phase = 'pending';
          fs.writeFileSync(p, JSON.stringify(j));
        },
        'journal-invalid',
      ],
      [
        'escaping output path',
        (fx) => {
          const p = path.join(fx.state, 'journal.json');
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          j.outputs[0].path = '../outside.md';
          fs.writeFileSync(p, JSON.stringify(j));
        },
        'journal-invalid',
      ],
      ['journal mode', (fx) => fs.chmodSync(path.join(fx.state, 'journal.json'), 0o644), 'state-unsafe'],
      ['state mode', (fx) => fs.chmodSync(fx.state, 0o755), 'state-unsafe'],
      ['unexpected entry', (fx) => fs.writeFileSync(path.join(fx.state, 'notes.txt'), 'x'), 'state-unexpected-entry'],
      [
        'journal symlink',
        (fx) => {
          const p = path.join(fx.state, 'journal.json');
          fs.renameSync(p, path.join(fx.root, 'j.json'));
          fs.symlinkSync(path.join(fx.root, 'j.json'), p);
        },
        'state-unsafe',
      ],
      [
        'journal hardlink',
        (fx) => fs.linkSync(path.join(fx.state, 'journal.json'), path.join(fx.root, 'j2.json')),
        'state-unsafe',
      ],
      ['missing journal', (fx) => fs.unlinkSync(path.join(fx.state, 'journal.json')), 'journal-missing'],
    ];
    for (const [name, damage, reason] of cases) {
      const { fx, tx } = applied();
      damage(fx);
      const i = inspect(fx);
      assert.equal(i.class, 'corrupt', name);
      assert.equal(i.reason, reason, name);
      assert.deepEqual(i.actions, []);
      expectCode(() => rollbackRestore(fx.state, tx, opts()), 'state-corrupt', 1);
      expectCode(() => resolveRestore(fx.state, { tx, expect: 'corrupt', action: 'rollback' }, opts()), 'state-corrupt', 1);
      for (const f of fx.packet.files) assert.ok(fs.existsSync(destOf(fx, f.root, f.path)), `${name}: ${f.path} untouched`);
    }
  });

  it('refuses a journal that points at a live Pi location', () => {
    const { fx } = applied();
    const p = path.join(fx.state, 'journal.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.targets.agent = path.join(FAKE_HOME, '.pi', 'agent');
    fs.writeFileSync(p, JSON.stringify(j));
    expectCode(() => inspect(fx), 'live-path-refused', 2);
    expectCode(() => inspectRestore(path.join(FAKE_HOME, '.pi'), opts()), 'live-path-refused', 2);
  });

  it('validates transaction, expected class and action before acting', () => {
    const { fx, tx } = applied();
    expectCode(() => resolveRestore(fx.state, { tx: 'XYZ', expect: 'applied', action: 'rollback' }, opts()), 'tx-invalid', 2);
    expectCode(() => resolveRestore(fx.state, { tx: 'f'.repeat(32), expect: 'applied', action: 'rollback' }, opts()), 'tx-mismatch', 1);
    expectCode(() => resolveRestore(fx.state, { tx, expect: 'whatever', action: 'rollback' }, opts()), 'expect-invalid', 2);
    expectCode(() => resolveRestore(fx.state, { tx, expect: 'applied', action: 'delete' }, opts()), 'action-invalid', 2);
    expectCode(() => resolveRestore(fx.state, { tx, expect: 'partial', action: 'rollback' }, opts()), 'expect-mismatch', 1);
    expectCode(() => resolveRestore(fx.state, { tx, expect: 'applied', action: 'abandon' }, opts()), 'action-not-allowed', 2);
    expectCode(() => rollbackRestore(fx.state, 'nope', opts()), 'tx-invalid', 2);
    expectCode(() => inspectRestore(path.join(fx.root, 'absent'), opts()), 'state-missing', 2);
    const r = resolveRestore(fx.state, { tx, expect: 'applied', action: 'rollback' }, opts());
    assert.equal(r.removed, fx.packet.files.length);
    assert.equal(journal(fx).resolutions[0].action, 'rollback');
  });
});

// ================================================================ locks and boot identity

describe('locks and stale-owner proof', () => {
  it('records transaction, PID, UID, hostname and boot identity in private lock files', () => {
    const fx = crashed();
    const lock = JSON.parse(fs.readFileSync(path.join(fx.state, 'lock.json'), 'utf8'));
    assert.deepEqual(lock, {
      schemaVersion: 1,
      kind: 'pi-machine-config/lock',
      role: 'state',
      tx: journal(fx).tx,
      pid: OWNER_PID,
      uid: UID,
      hostname: 'fixture-host',
      bootId: BOOT,
      platform: PLATFORM,
    });
    assert.equal(fs.lstatSync(path.join(fx.state, 'lock.json')).mode & 0o777, 0o600);
    const tlock = JSON.parse(fs.readFileSync(path.join(fx.agent, '.pi-machine-config-lock'), 'utf8'));
    assert.equal(tlock.role, 'target');
  });

  it('proves staleness only with matching host and UID plus a changed boot or ESRCH', () => {
    const fx = crashed();
    const matrix: [string, Partial<TxDeps>, string, string | null][] = [
      ['same boot, ESRCH', {}, 'lock-stale', null],
      ['same boot, alive', { probePid: () => 'alive' }, 'lock-held', 'owner-alive'],
      ['same boot, EPERM', { probePid: () => 'eperm' }, 'lock-held', 'owner-unprovable'],
      ['same boot, probe error', { probePid: () => 'unknown' }, 'lock-held', 'owner-unprovable'],
      ['changed boot, PID reused', { bootId: () => OTHER_BOOT, probePid: () => 'alive' }, 'lock-stale', null],
      ['boot unavailable', { bootId: () => null }, 'lock-held', 'boot-identity-unavailable'],
      ['boot probe throws', { bootId: () => { throw new Error('x'); } }, 'lock-held', 'boot-identity-unavailable'],
      ['invalid boot value', { bootId: () => 'not-a-uuid' }, 'lock-held', 'boot-identity-unavailable'],
      ['other host', { hostname: () => 'elsewhere' }, 'lock-held', 'other-host'],
      ['hostname unavailable', { hostname: () => '' }, 'lock-held', 'hostname-unavailable'],
    ];
    const before = snapshot(fx.root);
    for (const [name, over, cls, reason] of matrix) {
      const i = inspect(fx, over);
      assert.equal(i.class, cls, name);
      assert.equal(i.reason, reason, name);
      assert.deepEqual(i.actions, cls === 'lock-stale' ? ['release-lock'] : [], name);
      if (cls === 'lock-held') {
        expectCode(() => resolveRestore(fx.state, { tx: i.tx ?? '', expect: 'lock-stale', action: 'release-lock' }, opts(over)), 'expect-mismatch', 1);
      }
    }
    assert.deepEqual(snapshot(fx.root), before, 'inspect never breaks locks');
    assert.deepEqual(inspect(fx, { bootId: () => null }).warnings, ['boot-identity-unavailable']);
  });

  it('treats an invalid, foreign or unsafe lock file as held', () => {
    const fx = crashed();
    const lockFile = path.join(fx.state, 'lock.json');
    const original = fs.readFileSync(lockFile, 'utf8');
    const cases: [string, () => void, string][] = [
      ['garbage', () => fs.writeFileSync(lockFile, '{oops'), 'lock-invalid'],
      ['other transaction', () => fs.writeFileSync(lockFile, original.replace(/"tx":"[0-9a-f]+"/, `"tx":"${'b'.repeat(32)}"`)), 'lock-invalid'],
      ['unknown field', () => fs.writeFileSync(lockFile, original.replace('{', '{"extra":1,')), 'lock-invalid'],
      ['group readable', () => fs.chmodSync(lockFile, 0o644), 'lock-unsafe'],
    ];
    for (const [name, damage, reason] of cases) {
      fs.writeFileSync(lockFile, original);
      fs.chmodSync(lockFile, 0o600);
      damage();
      const i = inspect(fx);
      assert.equal(i.class, 'lock-held', name);
      assert.equal(i.reason, reason, name);
      assert.deepEqual(i.actions, [], name);
      expectCode(() => resolveRestore(fx.state, { tx: i.tx ?? '', expect: 'lock-stale', action: 'release-lock' }, opts()), 'expect-mismatch', 1);
      assert.ok(fs.existsSync(lockFile), name);
    }
  });

  it('cannot prove a lock that recorded no boot identity', () => {
    const fx = crashed({ bootId: () => null });
    const i = inspect(fx);
    assert.equal(i.class, 'lock-held');
    assert.equal(i.reason, 'boot-identity-unavailable');
  });

  it('releases proven stale locks under the recovery gate and archives their records', () => {
    const fx = crashed();
    const tx = journal(fx).tx;
    const r = resolveRestore(fx.state, { tx, expect: 'lock-stale', action: 'release-lock' }, opts());
    assert.equal(r.removed, 2);
    assert.ok(!fs.existsSync(path.join(fx.state, 'lock.json')));
    assert.ok(!fs.existsSync(path.join(fx.state, 'recovery-gate.json')));
    assert.ok(!fs.existsSync(path.join(fx.agent, '.pi-machine-config-lock')));
    const res = journal(fx).resolutions;
    assert.equal(res.length, 1);
    assert.equal(res[0].action, 'release-lock');
    assert.deepEqual(res[0].locks.map((l) => l.role).sort(), ['state', 'target']);
    assert.deepEqual(drive(fx), ['unfinished', 'partial', 'rolled-back']);
  });

  it('refuses to remove a lock that changed after it was proven stale', () => {
    const fx = crashed();
    const tx = journal(fx).tx;
    const lockFile = path.join(fx.state, 'lock.json');
    let swapped = false;
    const hook = (p: string) => {
      if (p === 'stale-unlink' && !swapped) {
        swapped = true;
        const bytes = fs.readFileSync(lockFile);
        fs.unlinkSync(lockFile);
        fs.writeFileSync(lockFile, bytes, { mode: 0o600 });
      }
    };
    // Target lock is removed first; the swap happens before the state lock unlink check runs again.
    let n = 0;
    expectCode(
      () => resolveRestore(fx.state, { tx, expect: 'lock-stale', action: 'release-lock' }, opts({ fault: (p) => {
        if (p === 'stale-unlink' && ++n === 1) hook(p);
      } })),
      'lock-changed',
      1,
    );
    assert.ok(fs.existsSync(lockFile), 'the replaced lock is preserved');
    assert.ok(!fs.existsSync(path.join(fx.state, 'recovery-gate.json')), 'the gate is released');
  });

  it('classifies a stale recovery gate and releases it explicitly', () => {
    const fx = crashed();
    const tx = journal(fx).tx;
    expectCode(
      () => resolveRestore(fx.state, { tx, expect: 'lock-stale', action: 'release-lock' }, opts({ fault: (p) => {
        if (p === 'stale-unlink' || p.startsWith('gate-release')) throw new Error('crash');
      } })),
      'lock-release-failed',
      1,
    );
    assert.ok(fs.existsSync(path.join(fx.state, 'recovery-gate.json')));
    const alive = inspect(fx, { probePid: () => 'alive' });
    assert.equal(alive.class, 'gate-held');
    expectCode(() => rollbackRestore(fx.state, tx, opts({ probePid: () => 'alive' })), 'gate-held', 1);
    const i = inspect(fx);
    assert.equal(i.class, 'gate-stale');
    assert.deepEqual(i.actions, ['release-gate']);
    resolveRestore(fx.state, { tx, expect: 'gate-stale', action: 'release-gate' }, opts());
    assert.ok(!fs.existsSync(path.join(fx.state, 'recovery-gate.json')));
    assert.deepEqual(drive(fx), ['lock-stale', 'unfinished', 'partial', 'rolled-back']);
  });

  it('judges lock records without consulting clocks', () => {
    const d = { ...deps(), randomHex: () => '', fault: () => {} } as TxDeps;
    const rec: LockRecord = { role: 'state', tx: 'a'.repeat(32), pid: OWNER_PID, uid: UID, hostname: 'fixture-host', bootId: BOOT, platform: PLATFORM };
    assert.deepEqual(judgeLock(rec, d, BOOT), { stale: true });
    assert.deepEqual(judgeLock({ ...rec, uid: UID + 1 }, d, BOOT), { stale: false, reason: 'other-user' });
    assert.deepEqual(judgeLock(rec, d, OTHER_BOOT), { stale: true });
    assert.deepEqual(judgeLock(rec, d, null), { stale: false, reason: 'boot-identity-unavailable' });
    assert.deepEqual(judgeLock({ ...rec, hostname: null }, d, BOOT), { stale: false, reason: 'hostname-unavailable' });
  });

  it('accepts only a single UUID as boot identity', () => {
    assert.equal(parseBootId('A1B2C3D4-0000-4000-8000-0123456789AB\n'), 'a1b2c3d4-0000-4000-8000-0123456789ab');
    assert.equal(parseBootId('11111111-2222-4333-8444-555555555555'), BOOT);
    for (const bad of ['', '\n', 'uuid', `${BOOT}\n\n`, `${BOOT} `, '1700000000', `{ sec = 1700000000, usec = 0 }`]) {
      assert.equal(parseBootId(bad), null, bad);
    }
  });
});

describe('no public write command', () => {
  it('keeps apply, rollback and recovery out of the CLI', () => {
    for (const c of ['apply', 'rollback', 'recover']) {
      assert.ok(!USAGE.includes(c), c);
      assert.equal(main([c, '--tx', 'x'], {}, GUARD).code, 2);
    }
  });
});
