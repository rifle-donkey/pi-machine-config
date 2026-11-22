/** Independent offline acceptance tests for the standalone skill discovery model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import workerThreads from 'node:worker_threads';

const discovery = new URL('../src/skill-discovery.ts', import.meta.url);
const MiB = 1024 * 1024;
const limit = { status: 'limit' };
const notes = 'Inert fixture notes.';
const desc = 'description: Synthetic discovery description marker';
const skill = (...fields: string[]) => `---\n${[desc, ...fields].join('\n')}\n---\nInert fixture body.\n`;
const key = (dir: string) => `skills/${dir}/SKILL.md`;
const payload = (path: string, bytes: string | Uint8Array = skill()) =>
  ({ path, bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes });
const candidate = (dir: string) => ({ path: key(dir), status: 'candidate' });
const shadowed = (dir: string) => ({ path: key(dir), status: 'shadowed' });
const unverified = (dir: string, reason: 'entry-location' | 'metadata' | 'settings') =>
  ({ path: key(dir), status: 'unverified', reason });
type Row = ReturnType<typeof candidate | typeof shadowed | typeof unverified>;
const complete = (nameCheck: 'complete' | 'unverified', entries: Row[] = [], collisions: string[][] = []) =>
  ({ status: 'complete', entries, nameCheck, collisions });

type Input = ReturnType<typeof payload>;
type Analyze = (files: readonly Input[], skillsSetting?: unknown) => unknown;
async function analyzer(): Promise<Analyze> {
  const { analyzeSkillDiscovery } = await import(discovery.href);
  assert.equal(typeof analyzeSkillDiscovery, 'function', 'missing analyzeSkillDiscovery export');
  return analyzeSkillDiscovery;
}

async function rejectionCheck(analyze: Analyze) {
  const { ToolError } = await import('../src/errors.ts');
  const code = 'skill-discovery-input-invalid';
  return (files: unknown, setting: unknown, label: string) => {
    assert.throws(() => analyze(files as readonly Input[], setting), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.exit, 2);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.layer, undefined);
      assert.equal(error.cause, undefined);
      assert.equal(String(error), `ToolError: ${code}`);
      return true;
    }, label);
  };
}

// Keep this test first: use cold module loads in the public graph, including the
// real opt-in doctor worker. Count rejected attempts even if callers catch them.
test('isolation: capture approval, plan, apply and both doctors do not load skill analysis', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-discovery-qa-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const forbidden = String.raw`(?:^|/)skill-(?:discovery|metadata)\.ts(?:[?#]|$)`;
  const matcher = new RegExp(forbidden);
  let publicAttempts = 0;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const deny = (): never => { publicAttempts++; throw new Error('skill analysis is test-only'); };
    if (matcher.test(specifier)) deny();
    const result = next(specifier, context);
    if (matcher.test(result.url)) deny();
    return result;
  } });

  const observer = 'pmc-skill-discovery-qa-worker-counts';
  const counts = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  // Worker loaders do not inherit this thread's hooks. Add a test-only import
  // to its execArgv, without changing the worker entry, data, or protocol.
  const preload = `import { registerHooks } from 'node:module';
    import { getEnvironmentData } from 'node:worker_threads';
    const counts = getEnvironmentData(${JSON.stringify(observer)});
    const matcher = new RegExp(${JSON.stringify(forbidden)});
    Atomics.add(counts, 0, 1);
    registerHooks({ resolve(specifier, context, next) {
      const deny = () => { Atomics.add(counts, 1, 1); throw new Error('skill analysis is test-only'); };
      if (matcher.test(specifier)) deny();
      const result = next(specifier, context);
      if (matcher.test(result.url)) deny();
      if (result.url.endsWith('/src/extension-imports.ts')) Atomics.add(counts, 2, 1);
      return result;
    } });`;
  try {
    const Worker = workerThreads.Worker;
    workerThreads.setEnvironmentData(observer, counts);
    t.mock.method(workerThreads, 'Worker', class extends Worker {
      constructor(entry: ConstructorParameters<typeof Worker>[0], opts?: ConstructorParameters<typeof Worker>[1]) {
        super(entry, { ...opts, execArgv: [...(opts?.execArgv ?? []), '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`] });
      }
    });
    syncBuiltinESMExports();
    const { main, runCli } = await import('../src/cli.ts');
    const { parseJsonBytes } = await import('../src/json.ts');
    const { restoreFromPlan } = await import('../src/restore.ts');
    const platform = process.platform;
    assert.ok(platform === 'darwin' || platform === 'linux', 'project supports macOS and Linux');
    const root = fs.realpathSync(temp);
    const home = path.join(root, 'home');
    const source = path.join(root, 'source');
    const targetAgent = path.join(root, 'target');
    const stateDir = path.join(root, 'state');
    const policy = path.join(root, 'policy.json');
    const env = {};
    const guard = { home };
    fs.mkdirSync(home);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'settings.json'), '{}');
    const captureArgs = ['--policy', policy, '--source-agent', source, '--platform', platform];
    const argsFor = (bundle: string) => ['--bundle', bundle, '--platform', platform, '--target-agent', targetAgent];
    const decode = (stdout: string) => parseJsonBytes(Buffer.from(stdout));
    type CliOutput = Awaited<ReturnType<typeof runCli>>;
    const response = (actual: CliOutput, code: number, body: unknown) => {
      assert.equal(actual.code, code);
      assert.equal(actual.stderr, '');
      assert.deepEqual(decode(actual.stdout), decode(JSON.stringify(body)));
    };
    const refusal = (code: number, error: string) => ({ code, stdout: '', stderr: `${JSON.stringify({ ok: false, error })}\n` });
    const bundleWith = async (name: string, files: { path: string; class: string; body: string; expect?: unknown }[],
      verifyCaptureBinding = false) => {
      const bundle = path.join(root, name);
      for (const file of files) {
        const dest = path.join(source, file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.body);
      }
      fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: {
        common: { files: files.map(({ body: _bytes, ...rule }) => ({ ...rule, root: 'agent', template: false })) },
      } }));
      const reviewed = await runCli(['capture-review', ...captureArgs], env, guard);
      assert.equal(reviewed.code, 0);
      assert.equal(reviewed.stderr, '');
      const review = decode(reviewed.stdout);
      assert.ok(review && typeof review === 'object' && 'captureReviewToken' in review);
      const { captureReviewToken: token } = review;
      assert.ok(typeof token === 'string' && /^sha256:[0-9a-f]{64}$/.test(token));
      const capture = ['capture', ...captureArgs, '--out', bundle, '--approve-inclusion', token];
      if (verifyCaptureBinding) {
        const file = files[0];
        const dest = path.join(source, file.path);
        fs.appendFileSync(dest, '\nInert changed body.\n');
        assert.deepEqual(await runCli(capture, env, guard), refusal(1, 'inclusion-approval-mismatch'));
        assert.equal(fs.existsSync(bundle), false);
        fs.writeFileSync(dest, file.body);
      }
      const captured = await runCli(capture, env, guard);
      assert.equal(captured.code, 0);
      assert.equal(captured.stderr, '');
      for (const file of files) {
        assert.equal(fs.readFileSync(path.join(bundle, 'config/common/files/agent', file.path), 'utf8'), file.body);
      }
      return bundle;
    };

    // Includes one discovery candidate and one capture-compatible entry that
    // uses a block outside the bounded metadata subset. Neither permits apply.
    const entryPaths = [key('block'), key('candidate')];
    const ext = 'extensions/inert.ts';
    const block = '---\ndescription: |\n  Inert block\ndisable-model-invocation: true\n---\n';
    const diagnostic = await bundleWith('diagnostic', [
      { path: entryPaths[0], class: 'skill-source', body: block,
        expect: { frontmatter: { 'disable-model-invocation': true } } },
      { path: entryPaths[1], class: 'skill-source', body: skill() },
      { path: ext, class: 'extension-source', body: '// Inert input; static parsing only.\nexport {};\n' },
    ], true);
    const args = argsFor(diagnostic);
    const plan = await runCli(['plan', ...args], env, guard);
    response(plan, 1, { ok: false, command: 'plan', status: 'incomplete', platform, overlay: false, approvalToken: null,
      items: [...[...entryPaths, ext].map((path) => ({ kind: 'file', root: 'agent', path,
        class: path === ext ? 'extension-source' : 'skill-source', operation: 'incomplete', reason: 'dependency-analysis-unavailable',
      })), { kind: 'target', target: 'agent', operation: 'create' }] });
    assert.deepEqual(await runCli(['apply', ...args, '--state-dir', stateDir,
      '--approve-activation', `sha256:${'0'.repeat(64)}`], env, guard), refusal(1, 'plan-not-ready'));
    assert.equal(fs.existsSync(targetAgent), false);
    assert.equal(fs.existsSync(stateDir), false);
    response(await runCli(['doctor', '--extension-imports', ...args], env, guard), 0, {
      ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files: [
        { path: ext, status: 'analyzed', imports: { resolved: 0, missing: 0, 'outside-set': 0,
          unsupported: 0, 'unsupported-target': 0, external: 0 } },
      ],
    });
    assert.equal(Atomics.load(counts, 0), 1, 'worker observation must be active');
    assert.ok(Atomics.load(counts, 2) > 0, 'worker hook must see extension analyzer resolution');
    const help = await runCli(['help'], env, guard);
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.stdout, /skill.discover|analyzeSkillDiscovery/i);
    for (const cmd of [['skill-discovery', ...args], ['doctor', '--skill-discovery', ...args]]) {
      assert.deepEqual(main(cmd, env, guard), refusal(2, 'usage'));
      assert.deepEqual(await runCli(cmd, env, guard), refusal(2, 'usage'));
    }

    // A ready control exercises approval and locked recompile, then a matching
    // default doctor. Supply synthetic OS facts to the trusted fixture service.
    const ready = await bundleWith('ready', [{ path: 'AGENTS.md', class: 'agent-context', body: notes }]);
    const readyArgs = argsFor(ready);
    const preview = main(['plan', ...readyArgs], env, guard);
    assert.equal(preview.code, 0);
    assert.equal(preview.stderr, '');
    const result = decode(preview.stdout);
    assert.ok(result && typeof result === 'object' && 'approvalToken' in result);
    const { approvalToken } = result;
    assert.ok(typeof approvalToken === 'string' && /^sha256:[0-9a-f]{64}$/.test(approvalToken));
    assert.deepEqual(await runCli(['plan', ...readyArgs], env, guard), preview, 'same plan and token on repeat');
    const changedToken = approvalToken.replace(/.$/, (c) => c === '0' ? '1' : '0');
    assert.deepEqual(main(['apply', ...readyArgs, '--state-dir', stateDir, '--approve-activation', changedToken], env, guard),
      refusal(1, 'activation-approval-mismatch'));
    const applied = restoreFromPlan({ bundle: ready, targetAgent, stateDir, platform, env, guard,
      approveActivation: approvalToken, deps: { platform, bootId: () => '11111111-2222-4333-8444-555555555555',
        hostname: () => 'fixture-host', pid: () => 4000201, probePid: () => assert.fail('unexpected PID probe') } });
    assert.equal(applied.status, 'applied');
    response(await runCli(['doctor', ...readyArgs, '--state-dir', stateDir, '--tx', applied.tx], env, guard), 0,
      { ok: true, command: 'doctor', status: 'match' });
  } finally {
    hooks.deregister();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    workerThreads.setEnvironmentData(observer, undefined);
    assert.equal(publicAttempts, 0, 'public graph attempted to load a skill analyzer');
    assert.equal(Atomics.load(counts, 1), 0, 'doctor worker attempted to load a skill analyzer');
  }
});

test('regression: the standalone metadata report retains its old row shapes and semantics', async () => {
  const { analyzeSkillEntries } = await import('../src/skill-metadata.ts');
  const files = [payload(key('missing/sub')), payload('skills/sidecar/notes.md', notes),
    payload(key('Block'), '---\ndescription: |\n  Inert\n---\n'),
    payload(key('manual'), `---\nname: "Synthetic-Name-Marker"\ndescription: ${'x'.repeat(1025)}\n` +
      'disable-model-invocation: true\n---\n'), payload(key('fallback'), skill('name: null'))];
  assert.deepEqual(analyzeSkillEntries(files), { status: 'complete', entries: [
    { path: key('Block'), status: 'unsupported', reason: 'syntax' },
    { path: key('fallback'), status: 'recognized', manualOnly: false, nameSource: 'directory', nameValid: true,
      nameMatchesDirectory: true, descriptionTooLong: false },
    { path: key('manual'), status: 'recognized', manualOnly: true, nameSource: 'frontmatter', nameValid: false,
      nameMatchesDirectory: false, descriptionTooLong: true },
    { path: key('missing'), status: 'missing', reason: 'entry-missing' },
    { path: key('missing/sub'), status: 'unsupported', reason: 'entry-location' },
    { path: key('sidecar'), status: 'missing', reason: 'entry-missing' },
  ] });
});

test('admission: fixed invalid error for shape, bytes, exact duplicates and path guards', async () => {
  const analyze = await analyzer();
  const invalid = await rejectionCheck(analyze);
  const valid = payload(key('valid'));
  for (const v of [undefined, null, 'synthetic-input-marker', { 0: valid, length: 4097 }, new Uint8Array(4097)]) {
    invalid(v, undefined, 'array type wins over any apparent length');
  }
  for (const v of [null, undefined, 42, {}, { ...valid, path: 5 }, { path: valid.path },
    ...[null, 'synthetic-bytes-marker', [0], new Uint8ClampedArray(1), new Uint16Array(1), new DataView(new ArrayBuffer(1))]
      .map((bytes) => ({ ...valid, bytes }))]) invalid([v], undefined, 'invalid row or bytes');
  invalid(new Array(1), undefined, 'missing row in an in-range array');
  for (const p of [
    '/skills/fixture/SKILL.md', 'skills/fixture/../SKILL.md', 'skills//fixture/SKILL.md', 'skills\\fixture\\SKILL.md',
    'skills/fixture/.gitignore', 'skills/fixture/sub/.ignore', 'skills/fixture/.piignore',
    'skills/fixture/marker\n.md', 'skills/fixture/report:marker.md', 'skills/fixture/Sub Node/notes.md',
    'skills/fixture/cafe\u0301.md', 'skills/fixture/node_modules/notes.md', 'skills/fixture/SESSIONS/notes.md',
    'skills/fixture/AGENTS.override.md', 'skills/fixture/settings.json', 'skills/fixture/marker.csv',
    'skills/SKILL.md', 'Skills/fixture/SKILL.md', 'prompts/fixture/SKILL.md',
  ]) invalid([valid, payload(p)], undefined, 'invalid path, prohibited path, or placement');
  invalid([valid, payload(valid.path, notes)], undefined, 'duplicate exact entry path');
  const sidecar = payload('skills/fixture/notes.txt', notes);
  invalid([sidecar, sidecar], undefined, 'duplicate exact non-entry path');
  const framed = Uint8Array.from([0xff, ...valid.bytes, 0xff]);
  assert.deepEqual(analyze([payload(valid.path, framed.subarray(1, -1))]), complete('complete', [candidate('valid')]));
});

test('admission: folded full paths, directory aliases, and file/directory overlap are invalid in either order', async () => {
  const analyze = await analyzer();
  const invalid = await rejectionCheck(analyze);
  const cases = [
    ['folded entry alias', key('box'), 'skills/box/skill.md'],
    ['folded sidecar alias', 'skills/box/Notes.txt', 'skills/box/notes.txt'],
    ['folded top directory with distinct leaves', 'skills/Box/left.txt', 'skills/box/right.txt'],
    ['folded deep directory with distinct leaves', 'skills/box/a/Docs/left.txt', 'skills/box/a/docs/right.txt'],
    ['exact file/directory overlap', 'skills/box/assets.txt', 'skills/box/assets.txt/sub/notes.txt'],
    ['folded file/directory overlap', 'skills/box/Assets.txt', 'skills/box/assets.txt/sub/notes.txt'],
    ['entry file also used as a directory', key('box'), 'skills/box/SKILL.md/sub/notes.txt'],
  ];
  for (const [label, a, b] of cases) {
    invalid([payload(a), payload(b)], undefined, label);
    invalid([payload(b), payload(a)], undefined, `${label} (reverse)`);
  }
  assert.deepEqual(analyze([payload(key('Box')), payload('skills/Box/sub/left.txt'), payload('skills/Box/sub/right.txt'),
    payload('skills/Box/sub-dir/left.txt')]), complete('complete', [candidate('Box')]),
  'identical directory prefixes and similar but distinct names are legal');
});

test('admission: inclusive count and byte caps with namespace and settings validation between them', async () => {
  const analyze = await analyzer();
  const invalid = await rejectionCheck(analyze);
  const direct = payload(key('valid'));
  const badPath = payload('outside/fixture/notes.txt');
  const exactCount = [direct, ...Array.from({ length: 4095 }, (_, i) => payload(`skills/valid/n-${i}.txt`, ''))];
  assert.deepEqual(analyze(exactCount), complete('complete', [candidate('valid')]));
  invalid(exactCount, null, 'exact count still validates settings');
  assert.deepEqual(analyze([badPath, ...exactCount], null), limit, 'over count before path and settings errors');
  assert.deepEqual(analyze([...exactCount, direct]), limit, 'over count before duplicate check');
  assert.deepEqual(analyze([...exactCount, payload(key('Valid'))]), limit, 'over count before namespace check');
  const exactEntry = Buffer.alloc(MiB, 0x20);
  exactEntry.write(skill());
  // Views share storage on purpose: the limit counts each view's byteLength.
  const unread = new Uint8Array(MiB + 2).fill(0xff).subarray(1, -1);
  const exactBytes = [payload(direct.path, exactEntry), ...Array.from({ length: 47 }, (_, i) =>
    payload(`skills/valid/asset-${i}.txt`, unread))];
  assert.deepEqual(analyze(exactBytes), complete('complete', [candidate('valid')]));
  const over = [...exactBytes, payload('skills/valid/over.txt', 'x')];
  assert.deepEqual(analyze(over), limit, 'one byte over, including sidecars, returns no partial report');
  assert.deepEqual(analyze(over, ['skills/valid']), limit, 'over bytes with valid nonempty settings');
  invalid(over, null, 'settings validity wins over aggregate byte cap');
  invalid([...over, badPath], undefined, 'trailing invalid path wins over aggregate byte cap');
  invalid([...over, direct], undefined, 'exact duplicate wins over aggregate byte cap');
  invalid([...over, payload('skills/Valid/other.md')], undefined, 'folded directory alias wins over aggregate byte cap');
  invalid([...over, payload('skills/valid/over.txt/child.md')], undefined, 'file/directory conflict wins over aggregate byte cap');
  assert.deepEqual(analyze([payload(direct.path, new Uint8Array(MiB + 1).fill(0xff))]),
    complete('unverified', [unverified('valid', 'metadata')]), 'direct metadata bound remains in force');
});

test('settings: absence is equivalent to empty; invalid values use one redacted error', async () => {
  const analyze = await analyzer();
  const invalid = await rejectionCheck(analyze);
  const files = [payload(key('same')), payload(key('another'), skill('name: same'))];
  const want = complete('complete', [candidate('another'), candidate('same')], [[key('another'), key('same')]]);
  assert.deepEqual(analyze(files), want);
  assert.deepEqual(analyze(files, undefined), want);
  assert.deepEqual(analyze(files, Object.freeze([])), want);
  for (const value of [null, 'synthetic-setting-marker', { skills: [] }, true, [null], [1], [''], ['+'],
    ['+../marker'], ['!/synthetic-absolute-marker'], ['~/marker'], ['marker\\skill'], ['{{HOME}}/marker'],
    ['builtin:marker'], ['line\nmarker'], ['x'.repeat(4097)], Array(4097).fill('skills/marker')]) {
    invalid(files, value, 'invalid value via shared skills setting schema');
  }
  invalid([], null, 'validate settings even without a payload');
});

test('settings F1: every nonempty valid selection, even negative-only, makes zero rows unverified', async () => {
  const analyze = await analyzer();
  const sidecars = [payload('skills/fixture/skill.md'), payload('skills/another/notes.txt', notes)];
  const files = [payload(key('alias'), skill('name: same')), payload(key('same')),
    payload(key('alias/sub'), new Uint8Array([0])), payload(key('other'), notes), payload(key('nested/sub'))];
  const expected = complete('unverified', [unverified('alias', 'settings'), shadowed('alias/sub'),
    unverified('nested/sub', 'entry-location'), unverified('other', 'metadata'), unverified('same', 'settings')]);
  for (const value of [['skills/synthetic-selection-marker/SKILL.md'], ['-skills/synthetic-selection-marker'],
    ['!skills/synthetic-selection-marker/**'], ['+./skills/synthetic-selection-marker']]) {
    // This is the F1 case, not a settings row causing nameCheck to follow it.
    assert.deepEqual(analyze([], value), complete('unverified'));
    assert.deepEqual(analyze(sidecars, value), complete('unverified'));
    const result = analyze(files, Object.freeze(value));
    assert.deepEqual(result, expected, 'settings affect candidates only and suppress their name groups');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-selection-marker/);
  }
  assert.deepEqual(analyze([], []), complete('complete'));
  assert.deepEqual(analyze(sidecars), complete('complete'));
});

test('entries: exact filenames, no missing rows, and ancestor shadowing before location or metadata', async () => {
  const analyze = await analyzer();
  const badUtf8 = new Uint8Array([0xc3, 0x28]);
  const badMeta = '---\ndescription: false\n---\n';
  const files = [payload(key('root/sub/gap/deep'), badUtf8), payload(key('root/sub'), skill()),
    payload(key('root'), badMeta), payload(key('Nested/a/b/c'), badUtf8), payload(key('Nested/a'), badMeta),
    payload(key('solo/a/deep'), badUtf8), payload(key('solo/cousin'), skill()),
    payload('skills/solo/skill.md', skill()), payload('skills/case/SKILL.MD', skill()),
    payload('skills/case/extra/SKILL.md.md', skill()), payload('skills/case/SKILL.txt', skill()),
    payload('skills/sidecar/notes.md', badUtf8), payload(key('Good')), payload(key('Good/deep'), badUtf8),
    payload(key('Good-sibling')), payload(key('z-bad'), badUtf8)];
  const expected = complete('unverified', [candidate('Good-sibling'), candidate('Good'), shadowed('Good/deep'),
    unverified('Nested/a', 'entry-location'), shadowed('Nested/a/b/c'), unverified('root', 'metadata'),
    shadowed('root/sub'), shadowed('root/sub/gap/deep'), unverified('solo/a/deep', 'entry-location'),
    unverified('solo/cousin', 'entry-location'), unverified('z-bad', 'metadata')]);
  assert.deepEqual(analyze(files), expected);
  assert.deepEqual(analyze([...files].reverse()), expected);
  assert.deepEqual(analyze([payload(key('Good/deep'), badUtf8), payload(key('Good'))]),
    complete('complete', [candidate('Good'), shadowed('Good/deep')]), 'shadowed rows alone do not make the check unverified');
});

test('names: exact candidate-only groups, stable code-unit order, and no raw metadata', async () => {
  const analyze = await analyzer();
  const normal = 'synthetic-name-marker';
  const upper = 'Synthetic-Name-Marker';
  const composed = 'Caf\u00e9-Synthetic-Marker';
  const decomposed = 'Cafe\u0301-Synthetic-Marker';
  const warning = `Synthetic long description marker ${'x'.repeat(1025)}`;
  const other = 'SyntheticOtherKeyMarker';
  const body = 'Synthetic opaque body marker';
  const named = (name: string) => skill(`name: "${name}"`, `${other}: Inert`) + body;
  const manual = `---\nname: ${normal}\ndescription: ${warning}\ndisable-model-invocation: true\n---\n`;
  const files = [payload(key('zz-normal'), named(normal)), payload(key('Zed'), manual), payload(key(normal), skill('name: ""')),
    payload(key('Beta'), named(upper)), payload(key('z-upper'), named(upper)), payload(key('a-cafe'), named(composed)),
    payload(key('z-cafe'), named(composed)), payload(key('mid-decomp'), named(decomposed)),
    payload(key('mid-space'), named(`${upper} `)),
    payload(key('Beta/child'), named(upper)), payload(key('other/sub'), named(upper)),
    payload(key('bad'), `---\nname: ${upper}\ndescription: false\n---\n`)];
  const groups = [[key('Beta'), key('z-upper')], [key('Zed'), key(normal), key('zz-normal')], [key('a-cafe'), key('z-cafe')]];
  const expected = complete('unverified', [candidate('Beta'), shadowed('Beta/child'), candidate('Zed'), candidate('a-cafe'),
    unverified('bad', 'metadata'), candidate('mid-decomp'), candidate('mid-space'), unverified('other/sub', 'entry-location'),
    candidate(normal), candidate('z-cafe'), candidate('z-upper'), candidate('zz-normal')], groups);
  const before = files.map(({ bytes }) => Buffer.from(bytes));
  for (const order of [files, [...files].reverse(), [...files.slice(5), ...files.slice(0, 5)]]) {
    const report = analyze(Object.freeze(order.map((file) => Object.freeze({ ...file }))));
    assert.deepEqual(report, expected);
    const serialized = JSON.stringify(report);
    for (const marker of [upper, composed, decomposed, warning, 'Synthetic long description marker',
      'Synthetic discovery description marker', other, body, 'manualOnly', 'nameSource']) {
      assert.ok(!serialized.includes(marker), 'raw metadata or private flags in the report');
    }
  }
  assert.deepEqual(files.map(({ bytes }) => Buffer.from(bytes)), before);
  const clean = files.filter((file) => file.path !== key('bad') && file.path !== key('other/sub'));
  assert.deepEqual(analyze(clean), complete('complete', expected.entries.filter((row) => row.status !== 'unverified'), groups),
    'collisions alone do not imply unverified names');
});
