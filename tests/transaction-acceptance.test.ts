import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { applyRestore, inspectRestore, resolveRestore, rollbackRestore, type RestorePacket, type TxOptions } from '../src/transaction.ts';
import { ToolError } from '../src/errors.ts';
import type { Platform } from '../src/schema.ts';

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const platform = process.platform as Platform;
function optionsFor(home: string): TxOptions { return { env: {}, guard: { home }, deps: {
  platform, bootId: () => '11111111-2222-4333-8444-555555555555', hostname: () => 'qa-host',
  uid: () => typeof process.getuid === 'function' ? process.getuid() : 0,
  pid: () => 4000001, probePid: () => 'esrch',
} }; }
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-restore-qa-'))); roots.push(root);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const options = optionsFor(home);
  const bytes = Buffer.from('# Independent rules\n');
  const packet: RestorePacket = { planToken: `sha256:${'a'.repeat(64)}`, platform,
    state: path.join(root, 'state'), agentTarget: path.join(root, 'agent'), lensTarget: null,
    settings: { defaultProvider: 'anthropic' }, packages: [], protectedRoots: [],
    files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
  return { root, home, options, packet, doc: path.join(packet.agentTarget, 'AGENTS.md'), settings: path.join(packet.agentTarget, 'settings.json') };
}
function code(fn: () => unknown, expected: string) {
  assert.throws(fn, (err: unknown) => err instanceof ToolError && err.code === expected, `expected ToolError ${expected}`);
}
function listing(root: string): string[] {
  const result: string[] = [];
  function walk(p: string) { for (const n of fs.readdirSync(p).sort()) { const f = path.join(p, n); const s = fs.lstatSync(f); result.push(`${path.relative(root, f)}:${s.mode}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.isFile() ? fs.readFileSync(f).toString('base64') : ''}`); if (s.isDirectory()) walk(f); } }
  walk(root); return result;
}

test('fresh apply uses private files, inspect is read-only, rollback preserves unrelated runtime and directories', () => {
  const f = fixture(); const { options } = f; const r = applyRestore(f.packet, options);
  assert.equal(r.status, 'applied');
  assert.equal(fs.statSync(f.packet.agentTarget).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.packet.state).mode & 0o777, 0o700);
  for (const p of [f.doc, f.settings]) assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.mkdirSync(path.join(f.packet.agentTarget, 'runtime')); fs.writeFileSync(path.join(f.packet.agentTarget, 'runtime', 'keep'), 'runtime');
  const before = listing(f.root); const inspection = inspectRestore(f.packet.state, options);
  assert.equal(inspection.class, 'applied'); assert.deepEqual(listing(f.root), before);
  assert.equal(rollbackRestore(f.packet.state, r.tx, options).status, 'rolled-back');
  assert.equal(fs.existsSync(f.doc), false); assert.equal(fs.existsSync(f.settings), false);
  assert.equal(fs.readFileSync(path.join(f.packet.agentTarget, 'runtime', 'keep'), 'utf8'), 'runtime');
  assert.ok(fs.statSync(f.packet.agentTarget).isDirectory());
});

for (const kind of ['edited', 'identical-replacement', 'missing'] as const) test(`rollback protects entire group when one file is ${kind}`, () => {
  const f = fixture(); const { options } = f; const r = applyRestore(f.packet, options);
  if (kind === 'edited') fs.writeFileSync(f.doc, 'changed');
  if (kind === 'identical-replacement') { const b = fs.readFileSync(f.doc); fs.unlinkSync(f.doc); fs.writeFileSync(f.doc, b); }
  if (kind === 'missing') fs.unlinkSync(f.doc);
  const prior = fs.readFileSync(f.settings);
  const priorDoc = kind === 'missing' ? null : fs.readFileSync(f.doc);
  const inspection = inspectRestore(f.packet.state, options);
  assert.equal(inspection.class, 'conflict');
  assert.throws(() => rollbackRestore(f.packet.state, r.tx, options), (e: unknown) => e instanceof ToolError);
  assert.deepEqual(fs.readFileSync(f.settings), prior);
  if (priorDoc !== null) assert.deepEqual(fs.readFileSync(f.doc), priorDoc);
  assert.equal(inspectRestore(f.packet.state, options).class, 'conflict');
});

test('existing target is not adopted even with identical bytes', () => {
  const f = fixture(); const { options } = f; fs.mkdirSync(f.packet.agentTarget); fs.writeFileSync(f.doc, f.packet.files[0].bytes);
  code(() => applyRestore(f.packet, options), 'target-exists');
  assert.equal(fs.readFileSync(f.doc, 'utf8'), '# Independent rules\n'); assert.equal(fs.existsSync(f.packet.state), false);
});

test('reject settings injected as file and unknown setting before state creation', () => {
  const f = fixture(); const { options } = f; f.packet.files[0].path = 'settings.json';
  code(() => applyRestore(f.packet, options), 'path-prohibited'); assert.equal(fs.existsSync(f.packet.state), false);
  const g = fixture(); g.packet.settings = { maliciousOption: true };
  assert.throws(() => applyRestore(g.packet, g.options), (e: unknown) => e instanceof ToolError && e.exit === 2);
  assert.equal(fs.existsSync(g.packet.state), false);
});

test('wrong transaction and expected class cannot change the restore', () => {
  const f = fixture(); const { options } = f; const r = applyRestore(f.packet, options); const before = listing(f.root);
  code(() => resolveRestore(f.packet.state, { tx: r.tx, expect: 'unfinished', action: 'abandon' }, options), 'expect-mismatch');
  code(() => rollbackRestore(f.packet.state, '0'.repeat(32), options), 'tx-mismatch');
  assert.deepEqual(listing(f.root), before);
});

test('published pair is not finalized after its bytes change', () => {
  const f = fixture(); const { options } = f;
  const injected: TxOptions = { ...options, deps: { ...options.deps, fault: (point) => { if (point === 'link-dirsync') throw new Error('injected'); } } };
  code(() => applyRestore(f.packet, injected), 'publish-failed');
  const first = inspectRestore(f.packet.state, options);
  assert.equal(first.class, 'published-unfinished');
  const names = fs.readdirSync(f.packet.agentTarget).filter((n) => n.startsWith('.pi-machine-config-stage-'));
  assert.equal(names.length, 1);
  const stage = path.join(f.packet.agentTarget, names[0]);
  assert.equal(fs.statSync(stage).nlink, 2);
  fs.appendFileSync(f.doc, 'changed');
  const changedBytes = fs.readFileSync(f.doc);
  const changed = inspectRestore(f.packet.state, options);
  assert.equal(changed.class, 'conflict');
  assert.throws(() => resolveRestore(f.packet.state, { tx: first.tx!, expect: 'published-unfinished', action: 'finalize' }, options), (e: unknown) => e instanceof ToolError && e.code === 'expect-mismatch');
  for (const action of ['finalize', 'rollback']) {
    code(() => resolveRestore(f.packet.state, { tx: first.tx!, expect: 'conflict', action }, options), 'action-not-allowed');
  }
  resolveRestore(f.packet.state, { tx: first.tx!, expect: 'conflict', action: 'record-conflict' }, options);
  assert.equal(inspectRestore(f.packet.state, options).class, 'preserved');
  assert.deepEqual(fs.readFileSync(stage), changedBytes);
  assert.deepEqual(fs.readFileSync(f.doc), changedBytes);
});

test('corrupt journal is inspectable but cannot authorize cleanup', () => {
  const f = fixture(); const { options } = f; const r = applyRestore(f.packet, options);
  fs.writeFileSync(path.join(f.packet.state, 'journal.json'), '{');
  const before = fs.readFileSync(f.doc); const i = inspectRestore(f.packet.state, options);
  assert.equal(i.class, 'corrupt'); assert.deepEqual(i.actions, []);
  assert.throws(() => rollbackRestore(f.packet.state, r.tx, options), (e: unknown) => e instanceof ToolError);
  assert.deepEqual(fs.readFileSync(f.doc), before); assert.ok(fs.existsSync(f.settings));
});

test('overlapping state and target is rejected before writes', () => {
  const f = fixture(); const { options } = f; f.packet.state = f.packet.agentTarget;
  code(() => applyRestore(f.packet, options), 'roots-overlap'); assert.equal(fs.existsSync(f.packet.state), false);
});

for (const operation of ['inspect', 'rollback', 'resolve'] as const) test(`relocated ancestor into protected home refuses ${operation}`, () => {
  const f = fixture(); const { options } = f;
  const parent = path.join(f.root, 'outside'); fs.mkdirSync(parent);
  f.packet.agentTarget = path.join(parent, 'agent');
  const doc = path.join(f.packet.agentTarget, 'AGENTS.md');
  const settings = path.join(f.packet.agentTarget, 'settings.json');
  const r = applyRestore(f.packet, options);
  assert.equal(inspectRestore(f.packet.state, options).class, 'applied');
  const originalDoc = fs.readFileSync(doc); const originalSettings = fs.readFileSync(settings);
  const inode = fs.statSync(doc).ino; const rootInode = fs.statSync(f.packet.agentTarget).ino;
  const protectedDir = path.join(f.home, '.pi'); fs.mkdirSync(protectedDir);
  const moved = path.join(protectedDir, 'moved'); fs.renameSync(parent, moved); fs.symlinkSync(moved, parent);
  assert.equal(fs.statSync(doc).ino, inode); assert.equal(fs.statSync(f.packet.agentTarget).ino, rootInode);
  const stateBefore = listing(f.packet.state);
  let outcome: ReturnType<typeof inspectRestore> | undefined; let error: unknown;
  try {
    if (operation === 'inspect') outcome = inspectRestore(f.packet.state, options);
    else if (operation === 'rollback') rollbackRestore(f.packet.state, r.tx, options);
    else resolveRestore(f.packet.state, { tx: r.tx, expect: 'applied', action: 'rollback' }, options);
  } catch (e) { error = e; }
  assert.ok(fs.existsSync(doc), 'context must remain in the protected root');
  assert.ok(fs.existsSync(settings), 'settings must remain in the protected root');
  assert.deepEqual(fs.readFileSync(doc), originalDoc); assert.deepEqual(fs.readFileSync(settings), originalSettings);
  assert.deepEqual(listing(f.packet.state), stateBefore);
  if (operation === 'inspect' && error === undefined) {
    assert.ok(outcome!.class === 'conflict' || outcome!.class === 'corrupt');
    assert.notEqual(outcome!.reason, null);
    assert.ok(!outcome!.actions.includes('rollback') && !outcome!.actions.includes('finalize') && !outcome!.actions.includes('abandon'));
  } else assert.ok(error instanceof ToolError, 'operation must refuse with a ToolError');
});

test('rollback-pending never deletes a replacement after failed directory sync', () => {
  const f = fixture(); f.packet.files = [];
  const r = applyRestore(f.packet, f.options);
  const failing: TxOptions = { ...f.options, deps: { ...f.options.deps, fault: (point) => {
    if (point === 'rollback-dirsync') throw new Error('injected');
  } } };
  assert.throws(() => rollbackRestore(f.packet.state, r.tx, failing), (e: unknown) => e instanceof ToolError);
  assert.equal(fs.existsSync(f.settings), false);
  fs.writeFileSync(f.settings, 'replacement');
  assert.equal(inspectRestore(f.packet.state, f.options).class, 'conflict');
  assert.throws(() => rollbackRestore(f.packet.state, r.tx, f.options), (e: unknown) => e instanceof ToolError);
  assert.equal(fs.readFileSync(f.settings, 'utf8'), 'replacement');
});

test('rollback retries parent sync after unlink failure before marking completion', () => {
  const f = fixture(); f.packet.files = [];
  const r = applyRestore(f.packet, f.options);
  assert.equal(r.outputs, 1); assert.equal(inspectRestore(f.packet.state, f.options).class, 'applied');
  let calls = 0;
  const failing: TxOptions = { ...f.options, deps: { ...f.options.deps, fault: (point) => {
    if (point === 'rollback-dirsync') { calls++; throw new Error('injected'); }
  } } };
  assert.throws(() => rollbackRestore(f.packet.state, r.tx, failing), (e: unknown) => e instanceof ToolError);
  assert.equal(calls, 1); assert.equal(fs.existsSync(f.settings), false);
  assert.equal(inspectRestore(f.packet.state, f.options).class, 'rollback-pending');
  let retryError: unknown;
  try { rollbackRestore(f.packet.state, r.tx, failing); } catch (e) { retryError = e; }
  const retryCalls = calls; const retryClass = inspectRestore(f.packet.state, f.options).class;
  if (retryError instanceof ToolError && retryClass === 'rollback-pending') {
    assert.equal(rollbackRestore(f.packet.state, r.tx, f.options).status, 'rolled-back');
    assert.equal(inspectRestore(f.packet.state, f.options).class, 'rolled-back');
  }
  assert.equal(fs.existsSync(f.settings), false);
  assert.deepEqual({ refused: retryError instanceof ToolError, calls: retryCalls, class: retryClass },
    { refused: true, calls: 2, class: 'rollback-pending' }, 'retry must sync again and remain pending');
});
