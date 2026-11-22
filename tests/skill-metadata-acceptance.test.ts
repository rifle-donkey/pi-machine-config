import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const src = new URL('../src/', import.meta.url);
const metadata = new URL('skill-metadata.ts', src);
const MiB = 1024 * 1024;
const validText = frontmatter(['description: Fixture description']);
const captureCompatibleBlock = frontmatter(['description: |', '  Inert description', 'disable-model-invocation: true']);
const usage = { code: 2, stdout: '', stderr: '{"ok":false,"error":"usage"}\n' };

// Run the public routes cold. Blocking resolution detects even caught attempts
// to load the new module, and lets the control run before the module exists.
test('baseline: capture expectations, approval, readiness and CLI stay independent', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-skill-control-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const attempts: string[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const refuse = () => {
        attempts.push('skill metadata resolution');
        throw new Error('skill metadata is unavailable to public routes');
      };
      if (specifier.includes('skill-metadata')) refuse();
      const result = next(specifier, context);
      if (result.url === metadata.href) refuse();
      return result;
    },
  });
  try {
    const root = fs.realpathSync(temp);
    const { main, runCli } = await import('../src/cli.ts');
    const { plan } = await import('../src/plan.ts');
    const bundle = path.join(root, 'bundle');
    const source = path.join(root, 'source');
    const targetAgent = path.join(root, 'target');
    const state = path.join(root, 'state');
    const policy = path.join(root, 'policy.json');
    const home = path.join(root, 'home');
    const env = {};
    const guard = { home };
    const platform = 'darwin' as const;
    const key = 'skills/fixture/SKILL.md';
    const recognizedKey = 'skills/recognized/SKILL.md';
    const skill = path.join(source, key);
    const recognizedSkill = path.join(source, recognizedKey);
    // Capture's expectation reader allows an unrelated block scalar. The new
    // analyzer must refuse that syntax, without changing capture's behavior.
    const approved = captureCompatibleBlock;
    fs.mkdirSync(home);
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.mkdirSync(path.dirname(recognizedSkill), { recursive: true });
    fs.writeFileSync(path.join(source, 'settings.json'), '{}');
    fs.writeFileSync(skill, approved);
    fs.writeFileSync(recognizedSkill, validText);
    fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: 'pi-machine-config/inclusion', layers: {
      common: { files: [
        { root: 'agent', path: key, class: 'skill-source', template: false,
          expect: { frontmatter: { 'disable-model-invocation': true } } },
        { root: 'agent', path: recognizedKey, class: 'skill-source', template: false },
      ] },
    } }));

    const captureArgs = ['--policy', policy, '--source-agent', source, '--platform', platform];
    const review = await runCli(['capture-review', ...captureArgs], env, guard);
    assert.equal(review.code, 0);
    assert.equal(review.stderr, '');
    const { captureReviewToken: token } = JSON.parse(review.stdout);
    assert.match(token, /^sha256:[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(bundle), false);
    const capture = ['capture', ...captureArgs, '--out', bundle, '--approve-inclusion', token];
    fs.writeFileSync(skill, approved.replace('invocation: true', 'invocation: false'));
    assert.deepEqual(await runCli(capture, env, guard), {
      code: 2, stdout: '', stderr: '{"ok":false,"error":"expectation-failed"}\n',
    });
    fs.writeFileSync(skill, `${approved}\nInert byte change.\n`);
    assert.deepEqual(await runCli(capture, env, guard), {
      code: 1, stdout: '', stderr: '{"ok":false,"error":"inclusion-approval-mismatch"}\n',
    });
    assert.equal(fs.existsSync(bundle), false);
    fs.writeFileSync(skill, approved);
    const captured = await runCli(capture, env, guard);
    assert.equal(captured.code, 0);
    assert.equal(captured.stderr, '');
    assert.equal(fs.readFileSync(path.join(bundle, 'config/common/files/agent', key), 'utf8'), approved);
    assert.equal(fs.readFileSync(path.join(bundle, 'config/common/files/agent', recognizedKey), 'utf8'), validText);

    const expected = { status: 'incomplete', platform, overlay: false, approvalToken: null, items: [
      ...[key, recognizedKey].map((path) => ({ kind: 'file', root: 'agent', path, class: 'skill-source',
        operation: 'incomplete', reason: 'dependency-analysis-unavailable' })),
      { kind: 'target', target: 'agent', operation: 'create' },
    ] };
    const opts = { bundle, targetAgent, platform, guard, env };
    assert.deepEqual(plan(opts), expected);
    const planArgs = ['--bundle', bundle, '--platform', platform, '--target-agent', targetAgent];
    const preview = await runCli(['plan', ...planArgs], env, guard);
    assert.equal(preview.code, 1);
    assert.equal(preview.stderr, '');
    assert.deepEqual(JSON.parse(preview.stdout), { ok: false, command: 'plan', ...expected });
    assert.deepEqual(await runCli(['apply', ...planArgs, '--state-dir', state,
      '--approve-activation', `sha256:${'0'.repeat(64)}`], env, guard), {
      code: 1, stdout: '', stderr: '{"ok":false,"error":"plan-not-ready"}\n',
    });
    assert.equal(fs.existsSync(targetAgent), false);
    assert.equal(fs.existsSync(state), false);

    const doctor = await runCli(['doctor', '--extension-imports', ...planArgs], env, guard);
    assert.equal(doctor.code, 0);
    assert.equal(doctor.stderr, '');
    assert.deepEqual(JSON.parse(doctor.stdout), {
      ok: true, command: 'doctor', mode: 'extension-imports', status: 'complete', files: [],
    });
    const help = await runCli(['help'], env, guard);
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.stdout, /skill-metadata|analyzeSkillEntries/i);
    for (const args of [['skill-metadata', ...planArgs], ['doctor', '--skill-metadata', ...planArgs]]) {
      assert.deepEqual(main(args, env, guard), usage);
      assert.deepEqual(await runCli(args, env, guard), usage);
    }
  } finally {
    hooks.deregister();
    assert.deepEqual(attempts, []);
  }
});

type Input = { path: string; bytes: Uint8Array };
type Analyze = (files: readonly Input[]) => unknown;
type Missing = 'entry-missing' | 'frontmatter-missing' | 'description-missing';
type Unsupported = 'entry-location' | 'limit' | 'decode' | 'bom' | 'delimiter' | 'syntax';
type Invalid = 'frontmatter-invalid' | 'description-invalid' | 'manual-only-invalid' | 'name-invalid';
type Rejection = readonly ['missing', Missing] | readonly ['unsupported', Unsupported] | readonly ['invalid', Invalid];
type Flags = { manualOnly: boolean; nameSource: 'directory' | 'frontmatter'; nameValid: boolean;
  nameMatchesDirectory: boolean; descriptionTooLong: boolean };

async function analyzer(): Promise<Analyze> {
  const { analyzeSkillEntries } = await import(metadata.href);
  assert.equal(typeof analyzeSkillEntries, 'function');
  return analyzeSkillEntries;
}
function frontmatter(lines: readonly string[]): string {
  return ['---', ...lines, '---', 'Inert fixture body.', ''].join('\n');
}
function skillEntry(dir: string): string {
  return `skills/${dir}/SKILL.md`;
}
function payload(path: string, data: string | Uint8Array = validText): Input {
  return { path, bytes: typeof data === 'string' ? Buffer.from(data) : data };
}
function recognized(path: string, flags: Partial<Flags> = {}) {
  return { path, status: 'recognized', manualOnly: false, nameSource: 'directory', nameValid: true,
    nameMatchesDirectory: true, descriptionTooLong: false, ...flags };
}
function rejected(path: string, [status, reason]: Rejection) {
  return { path, status, reason };
}
function complete(...entries: unknown[]) {
  return { status: 'complete', entries };
}
const limit = { status: 'limit' };

// One call per case keeps a failing assertion focused on its own fixture.
function checkCases(analyze: Analyze, cases: readonly (readonly [string, string | Uint8Array, Rejection | Partial<Flags>])[]) {
  for (const [label, bytes, want] of cases) {
    const key = skillEntry('fixture');
    assert.deepEqual(analyze([payload(key, bytes)]), complete(
      'length' in want ? rejected(key, want) : recognized(key, want),
    ), label);
  }
}

test('input: fixed invalid code for shape, schema paths, byte type and duplicates', async () => {
  const analyze = await analyzer();
  const { ToolError } = await import('../src/errors.ts');
  const valid = payload(skillEntry('fixture'));
  const invalidInput = (files: unknown, label: string) => {
    assert.throws(() => analyze(files as readonly Input[]), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.exit, 2);
      assert.equal(e.code, 'skill-metadata-input-invalid');
      assert.equal(e.message, 'skill-metadata-input-invalid');
      assert.equal(e.layer, undefined);
      assert.equal(e.cause, undefined);
      return true;
    }, label);
  };
  assert.deepEqual(analyze([]), complete());
  const framed = Uint8Array.from([0xff, ...valid.bytes, 0xff]);
  assert.deepEqual(analyze([payload(valid.path, framed.subarray(1, -1))]), complete(recognized(valid.path)));
  for (const shape of [null, undefined, { 0: valid, length: 1 }, new Uint8Array(3), 'fixture-input-marker']) {
    invalidInput(shape, 'non-array');
  }
  invalidInput(new Array(1), 'in-range sparse array');
  for (const path of [
    '/skills/fixture/SKILL.md', 'skills/fixture/../SKILL.md', 'skills/fixture/.hidden/SKILL.md',
    'skills//fixture/SKILL.md', 'skills\\fixture\\SKILL.md', 'skills/fixture/one\n.md',
    'skills/fixture/one:two.md', 'skills/fixture/node_modules/data.txt',
    'skills/fixture/SESSIONS/data.txt', 'skills/fixture/AGENTS.override.md', 'skills/fixture/settings.json',
    'skills/SKILL.md', 'Skills/fixture/SKILL.md', 'prompts/fixture/SKILL.md',
    'skills/fixture/unsupported.csv', 'skills/fixture/with space.md',
  ]) invalidInput([valid, { ...valid, path }], 'invalid path');
  for (const entry of [null, 3, {}, { ...valid, path: 42 }, { path: valid.path },
    ...['fixture-bytes-marker', [65], new ArrayBuffer(1), new DataView(new ArrayBuffer(1)),
      new Uint8ClampedArray(1), new Uint16Array(1)].map((bytes) => ({ ...valid, bytes })),
  ]) invalidInput([entry], 'invalid entry shape or byte type');
  invalidInput([valid, payload(valid.path, 'different synthetic bytes')], 'duplicate direct entry');
  const sidecar = payload('skills/fixture/notes.txt', 'notes');
  invalidInput([sidecar, sidecar], 'duplicate non-entry');
});

test('input: count and aggregate byte caps are inclusive, with validation between them', async () => {
  const analyze = await analyzer();
  const exactCount = Array.from({ length: 4096 }, (_, i) => payload(`skills/fixture/notes-${i}.txt`, ''));
  const malformed = payload('not-approved/marker.txt', '');
  const key = skillEntry('fixture');
  assert.deepEqual(analyze(exactCount), complete(rejected(key, ['missing', 'entry-missing'])));
  assert.deepEqual(analyze([malformed, ...exactCount]), limit, 'count wins before invalid path');

  const exactEntry = Buffer.alloc(MiB, 0x20);
  exactEntry.write(validText);
  // Count each payload, including sidecars, not backing allocations. Sidecars
  // have deliberately undecodable data; only approved direct entries decode.
  const unread = new Uint8Array(MiB).fill(0xff);
  const exactBytes = [payload(key, exactEntry), ...Array.from({ length: 47 }, (_, i) =>
    payload(`skills/fixture/notes-${i}.txt`, unread))];
  assert.deepEqual(analyze(exactBytes), complete(recognized(key)));
  const overBytes = [...exactBytes, payload('skills/fixture/over.txt', 'x')];
  assert.deepEqual(analyze(overBytes), limit, 'no partial report above the byte cap');
  assert.throws(() => analyze([...overBytes, malformed]), {
    code: 'skill-metadata-input-invalid', message: 'skill-metadata-input-invalid', exit: 2,
  }, 'validate trailing entry before applying the byte cap');
  assert.deepEqual(analyze([payload(key, Buffer.alloc(48 * MiB + 1, 0))]), limit,
    'aggregate cap wins over per-entry byte and decode diagnostics');
});

test('entries: exact locations, code-unit order and fixed redacted output', async () => {
  const analyze = await analyzer();
  const key = skillEntry('a');
  const hidden = {
    name: 'SYNTHETIC-NAME-MARKER', description: 'SYNTHETIC-DESCRIPTION-MARKER',
    unknown: 'SyntheticKeyMarker', body: 'SYNTHETIC-BODY-MARKER',
  };
  const direct = payload(key, frontmatter([
    `name: ${hidden.name}`, `description: ${hidden.description}`, `${hidden.unknown}: Fine`,
  ]) + hidden.body);
  const nested = 'skills/a/sub/SKILL.md';
  const nestedOnly = 'skills/Zed/sub/deep/SKILL.md';
  const syntaxMarker = 'SYNTHETIC-SYNTAX-MARKER';
  const oversized = new Uint8Array(MiB + 1).fill(0xff);
  const files = [payload('skills/case/skill.md'), payload('skills/case/SKILL.MD'),
    payload('skills/case/Skill.md'), payload('skills/case/SKILL.md.md'), payload('skills/case/SKILL.txt'),
    payload('skills/case/sub/skill.md'), payload('skills/case/sub/SKILL.Md'),
    payload(nested, oversized), payload(nestedOnly, new Uint8Array([0])),
    payload(skillEntry('a-one')), payload('skills/a/notes.txt', oversized),
    payload(skillEntry('B'), frontmatter(['description: Fixture', `hidden: [${syntaxMarker}]`])), direct];
  const want = complete(
    rejected(skillEntry('B'), ['unsupported', 'syntax']),
    rejected(skillEntry('Zed'), ['missing', 'entry-missing']),
    rejected(nestedOnly, ['unsupported', 'entry-location']),
    recognized(skillEntry('a-one')),
    recognized(key, { nameSource: 'frontmatter', nameValid: false, nameMatchesDirectory: false }),
    rejected(nested, ['unsupported', 'entry-location']),
    rejected(skillEntry('case'), ['missing', 'entry-missing']),
  );
  const before = Buffer.from(direct.bytes);
  for (const order of [files, [...files].reverse()]) {
    const actual = analyze(Object.freeze(order.map((entry) => Object.freeze(entry))));
    assert.deepEqual(actual, want);
    const serialized = JSON.stringify(actual);
    for (const marker of [...Object.values(hidden), syntaxMarker]) assert.ok(!serialized.includes(marker));
  }
  assert.deepEqual(direct.bytes, before);
});

test('entry checks: file bytes, strict whole-file decode, BOM and Pi delimiter precedence', async () => {
  const analyze = await analyzer();
  checkCases(analyze, [
    ['entry byte cap before decode', Buffer.alloc(MiB + 1, 0), ['unsupported', 'limit']],
    ['fatal UTF-8 even in body', Buffer.concat([Buffer.from(validText), Buffer.from([0xc3, 0x28])]), ['unsupported', 'decode']],
    ['NUL even in body', `${validText}\0`, ['unsupported', 'decode']],
    ['decode before double BOM', `\uFEFF\uFEFF${validText}\0`, ['unsupported', 'decode']],
    ['one BOM, mixed CRLF and CR', '\uFEFF---\r\ndescription: Fixture\rdisable-model-invocation: true\r\n---\r', { manualOnly: true }],
    ['two BOMs before missing opener', '\uFEFF\uFEFFInert body.', ['unsupported', 'bom']],
    ['missing prefix despite later delimiters', `Inert preamble.\n${validText}`, ['missing', 'frontmatter-missing']],
    ['no closing match despite inexact opener', '---suffix\ndescription: Fixture\n  ---', ['missing', 'frontmatter-missing']],
    ['missing close before grammar', '---\nunsupported: [fixture]\n', ['missing', 'frontmatter-missing']],
    ['opening line must be exact', '--- \ndescription: Fixture\n---', ['unsupported', 'delimiter']],
    ['first prefix match wins over later valid close', '---\ndescription: Fixture\n---suffix\n---', ['unsupported', 'delimiter']],
    ['closing line must be exact', '---\ndescription: Fixture\n--- ', ['unsupported', 'delimiter']],
    ['empty slice', '---\n---\nInert body.', ['missing', 'frontmatter-missing']],
    ['comments-only slice is not absent', frontmatter(['# Fixture comment']), ['missing', 'description-missing']],
    ['closing line at EOF', '---\ndescription: Fixture\n---', {}],
    ['body does not participate in the grammar', `${validText}Unsupported: [fixture]\n  body: More text\n`, {}],
  ]);
});

test('frontmatter caps: exact UTF-8 bytes, normalized lines, and UTF-16 line units', async () => {
  const analyze = await analyzer();
  const description = 'description: Fixture';
  const longLine = `#${'😀'.repeat(2047)}a`; // 4096 UTF-16 units, more UTF-8 bytes.
  const lines = [description, ...Array.from({ length: 253 }, () => ''), '# Count the empty lines'];
  const head = [description, ...Array.from({ length: 15 }, () => `#${'é'.repeat(2047)}a`)].join('\n') + '\n#';
  const cap = 64 * 1024;
  const atCap = head + 'a'.repeat(cap - Buffer.byteLength(head));
  assert.equal(Buffer.byteLength(atCap), cap);
  const bytesDoc = (body: string) => `---\n${body}\n---\n`;
  checkCases(analyze, [
    ['exact byte cap after CRLF normalization', bytesDoc(atCap).replaceAll('\n', '\r\n'), {}],
    ['one UTF-8 byte above cap', bytesDoc(`${atCap}a`), ['unsupported', 'limit']],
    ['255 lines counting empty ones', frontmatter(lines), {}],
    ['256 lines before syntax and duplicate checks', frontmatter([...lines.slice(0, -1), 'description: Again', '  bad']), ['unsupported', 'limit']],
    ['4096 UTF-16 units in comment', frontmatter([description, longLine]), {}],
    ['4097 UTF-16 units in comment', frontmatter([description, `${longLine}a`]), ['unsupported', 'limit']],
    ['delimiter before an overlong line', `---suffix\n${description}\n${longLine}a\n---`, ['unsupported', 'delimiter']],
  ]);
});

test('grammar: accepts plain strings, ASCII spaces, comments, simple quotes and core scalars', async () => {
  const analyze = await analyzer();
  checkCases(analyze, [
    ['permitted keys and unknown values', frontmatter([
      '', '# Inert comment containing [flow] and a : sign', 'description:   Fixture:unit#tag   ',
      `${'K'.repeat(64)}: A`, 'key_2-Extra: True', 'unknown: NULL', 'unknown2: ~', 'empty:',
      'constructor: Yes', 'TrUe: Off', 'toString: Value', 'Key: One', 'key: Two',
    ]), {}],
    ['quoted literals do not resolve as scalars', frontmatter([
      'description: "true"   ', "name: 'fixture'  ", 'unrelated: "x: #y \'z\'"',
    ]), { nameSource: 'frontmatter' }],
    ['mixed case outside core boolean spellings stays a string', frontmatter(['description: TrUe']), {}],
    ['mixed case outside core null spellings stays a string', frontmatter(['description: nUlL']), {}],
    ['non-ASCII outside quoted value is not trimmed', frontmatter(['description: Fixture', 'name: fixture\u00A0']),
      { nameSource: 'frontmatter', nameValid: false, nameMatchesDirectory: false }],
  ]);
});

test('grammar: refuses unsupported syntax for every key; syntax wins over duplicates', async () => {
  const analyze = await analyzer();
  const badLines = [
    ['space-only line', '  '], ['indented key', ' key: Value'], ['indented comment', ' # Comment'],
    ['space before colon', 'key : Value'], ['no separator', 'key:Value'], ['non-ASCII separator', 'key:\u00A0Value'],
    ['invalid leading key character', '_key: Value'], ['invalid key punctuation', 'a.b: Value'],
    ['non-ASCII key', 'clé: Value'], ['65-unit key', `${'K'.repeat(65)}: Value`],
    ['closing quote plus text', 'key: "Value" extra'], ['closing quote plus non-ASCII space', "key: 'Value'\u00A0"],
    ['quoted inline comment', 'key: "Value" # Comment'], ['escape', 'key: "Fixture\\n"'],
    ['single-quoted backslash', "key: 'Fixture\\x'"], ['doubled matching quote', "key: 'it''s'"],
    ['unterminated quote', 'key: "Value'], ['plain colon-space', 'key: Value: Other'],
    ['plain trailing colon', 'key: Value:  '], ['plain inline comment', 'key: Value # Comment'],
    ['comment in place of value', 'key: # Comment'],
    ['starts with digit', 'key: 1abc'], ['starts with minus', 'key: -2'], ['starts with plus', 'key: +2'],
    ['starts with dot', 'key: .nan'], ['plain non-ASCII start', 'key: élan'],
    ['block', 'key: |'], ['folded block', 'key: >-'], ['flow list', 'key: [Value]'],
    ['flow map', 'key: {k: Value}'], ['tag', 'key: !fixture Value'], ['anchor', 'key: &fixture Value'],
    ['alias', 'key: *fixture'], ['bare text', 'Continuation text'], ['YAML directive', '%YAML 1.2'],
    ...['null', 'Null', 'NULL', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE'].map((k) => [`core key ${k}`, `${k}: Value`]),
    ...['\t', '\x01', '\x1f', '\x7f', '\x85', '\x9f', '\uFEFF', '\uFFFE', '\uFFFF', '\u2028', '\u2029']
      .map((c) => [`forbidden character U+${c.charCodeAt(0).toString(16)}`, `# Fixture comment${c}`]),
  ];
  for (const [label, line] of badLines) {
    checkCases(analyze, [[label, frontmatter(['description: Fixture', line]), ['unsupported', 'syntax']]]);
  }
  checkCases(analyze, [
    ['capture-compatible block is outside this subset', captureCompatibleBlock, ['unsupported', 'syntax']],
    ['indented continuation despite preceding scalars', frontmatter(['description: Fixture', 'key: Value', ' continued']), ['unsupported', 'syntax']],
    ['later syntax failure overrides an earlier duplicate', frontmatter(['description: Fixture', 'description: Again', 'unrelated: [Fixture]']), ['unsupported', 'syntax']],
    ['duplicate unknown key before missing description', frontmatter(['unrelated: One', 'unrelated: Two']), ['invalid', 'frontmatter-invalid']],
    ['duplicate known key before invalid description', frontmatter(['description: True', 'description: Fixture']), ['invalid', 'frontmatter-invalid']],
  ]);
});

test('semantics: description, exact manual-only value and name errors have fixed precedence', async () => {
  const analyze = await analyzer();
  checkCases(analyze, [
    ['absent description before manual-only and name', frontmatter(['disable-model-invocation: TRUE', 'name: False']), ['missing', 'description-missing']],
    ...['', ' ~', ' Null', ' NULL', ' null', ' ""', " '   '", ' "\u00A0"'].map((suffix) =>
      [`empty description ${JSON.stringify(suffix)}`, frontmatter([`description:${suffix}`]), ['missing', 'description-missing']] as const),
    ...['true', 'True', 'TRUE', 'false', 'False', 'FALSE'].map((value) =>
      [`boolean description ${value}`, frontmatter([`description: ${value}`, 'disable-model-invocation: "false"', 'name: true']),
        ['invalid', 'description-invalid']] as const),
    ...['True', 'TRUE', 'False', 'FALSE', '"true"', "'false'", 'Yes', '~', 'null', ''].map((value) =>
      [`bad manual-only ${JSON.stringify(value)}`, frontmatter(['description: Fixture', 'name: true',
        value ? `disable-model-invocation: ${value}` : 'disable-model-invocation:']), ['invalid', 'manual-only-invalid']] as const),
    ['explicit lowercase true', frontmatter(['description: Fixture', 'disable-model-invocation:   true   ']), { manualOnly: true }],
    ['explicit lowercase false', frontmatter(['description: Fixture', 'disable-model-invocation: false']), {}],
    ['boolean name after valid manual-only', frontmatter(['description: Fixture', 'disable-model-invocation: false', 'name: TRUE']), ['invalid', 'name-invalid']],
  ]);
});

test('semantics: name source, exact match, conservative name validity and description length are only flags', async () => {
  const analyze = await analyzer();
  const description = 'description: Fixture';
  checkCases(analyze, [
    ...['name:', 'name: ~', 'name: Null', 'name: ""'].map((line) => [line, frontmatter([description, line]), {}] as const),
    ['exact frontmatter name', frontmatter([description, 'name: fixture']), { nameSource: 'frontmatter' }],
    ['exact 64-unit name with digit and internal hyphen', frontmatter([description, `name: "1-${'a'.repeat(62)}"`]),
      { nameSource: 'frontmatter', nameMatchesDirectory: false }],
    ...['Fixture', ' fixture ', ' ', `${'a'.repeat(65)}`, '-fixture', 'fixture-', 'fix--ture', 'fix_ture', 'fïxture'].map((value) =>
      [`nonempty invalid name ${JSON.stringify(value)}`, frontmatter([description, `name: "${value}"`]),
        { nameSource: 'frontmatter', nameValid: false, nameMatchesDirectory: false }] as const),
    ['1024 UTF-16 units, not bytes', frontmatter([`description: "${'😀'.repeat(512)}"`]), {}],
    ['1025 UTF-16 units, not code points', frontmatter([`description: "${'😀'.repeat(512)}a"`]), { descriptionTooLong: true }],
  ]);
  const fallback = skillEntry('UPPER');
  const exact = skillEntry('two-dashes');
  assert.deepEqual(analyze([payload(exact, frontmatter([description, 'name: two-dashes'])), payload(fallback)]), complete(
    recognized(fallback, { nameValid: false }), recognized(exact, { nameSource: 'frontmatter' }),
  ));
});
