/** Private package-state publication in temporary directories; no processes or live roots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { ToolError } from '../src/errors.ts';
import {
  fileId, replaceFile, replacePrivate, resolveDeps, sameFile, systemDeps,
  type PrivateStateKind, type TxDeps,
} from '../src/transaction-fs.ts';

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(kind: PrivateStateKind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-state-fs-')));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const target = path.join(root, `package-${kind}.json`);
  fs.writeFileSync(target, 'old', { mode: 0o600 });
  const id = fileId(fs.lstatSync(target, { bigint: true }));
  const deps = resolveDeps({ randomHex: () => 'a'.repeat(16),
    bootId: () => { assert.fail('publication never queries boot identity'); },
    probePid: () => { assert.fail('publication never probes processes'); } });
  return { root, target, id, deps, temp: `${target}.tmp-${'a'.repeat(16)}` };
}
const refused = (e: unknown) => e instanceof ToolError && e.exit === 1 && /^[a-z][a-z0-9-]+$/.test(e.code);

for (const kind of ['ledger', 'attempt'] as const) {
  test(`${kind}: replacement proves the new inode and refreshes identity after sync`, () => {
    const f = fixture(kind);
    const events: string[] = [];
    const next = replacePrivate({ ...f.deps, fault: p => events.push(p) }, f.root, kind, f.id, Buffer.from('new'));
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'new');
    assert.equal(fs.existsSync(f.temp), false);
    const st = fs.lstatSync(f.target, { bigint: true });
    assert.ok(sameFile(st, next));
    assert.equal(sameFile(st, f.id), false);
    assert.equal(st.mode & 0o777n, 0o600n);
    assert.deepEqual(events, [`${kind}-write`, `${kind}-write-sync`, `${kind}-rename`, kind === 'ledger' ? 'ledger-dirsync' : 'attempt-rename-dirsync']);
  });
  test(`${kind}: null identity permits only an absent destination`, () => {
    const f = fixture(kind);
    assert.throws(() => replacePrivate(f.deps, f.root, kind, null, Buffer.from('new')), refused);
    assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.target)]);
    fs.unlinkSync(f.target);
    const next = replacePrivate(f.deps, f.root, kind, null, Buffer.from('new'));
    assert.ok(sameFile(fs.lstatSync(f.target, { bigint: true }), next));
  });
  test(`${kind}: old destination replacement is not adopted even with identical bytes`, () => {
    const f = fixture(kind);
    const deps: TxDeps = { ...f.deps, fault(point) {
      if (point !== `${kind}-rename`) return;
      const replacement = path.join(f.root, 'replacement');
      fs.writeFileSync(replacement, 'old', { mode: 0o600 });
      fs.renameSync(replacement, f.target);
    } };
    assert.throws(() => replacePrivate(deps, f.root, kind, f.id, Buffer.from('new')), refused);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'old');
    assert.equal(fs.existsSync(f.temp), true);
  });
  test(`${kind}: changed staged bytes are never published`, () => {
    const f = fixture(kind);
    const deps: TxDeps = { ...f.deps, fault(point) {
      if (point === `${kind}-rename`) fs.writeFileSync(f.temp, 'changed');
    } };
    assert.throws(() => replacePrivate(deps, f.root, kind, f.id, Buffer.from('new')), refused);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'old');
    assert.equal(fs.readFileSync(f.temp, 'utf8'), 'changed');
  });
  for (const point of [`${kind}-write`, `${kind}-write-sync`, `${kind}-rename`, kind === 'ledger' ? 'ledger-dirsync' : 'attempt-rename-dirsync']) {
    test(`${kind}: ${point} failure never returns a committed identity`, () => {
      const f = fixture(kind);
      let reached = false;
      assert.throws(() => replacePrivate({ ...f.deps, fault(p) {
        if (p === point) { reached = true; throw new Error('private exception sentinel'); }
      } }, f.root, kind, f.id, Buffer.from('new')), (e: unknown) => {
        assert.ok(refused(e));
        assert.ok(e instanceof ToolError);
        assert.equal(e.code.includes('sentinel'), false);
        return true;
      });
      assert.equal(reached, true);
      const afterRename = point === 'ledger-dirsync' || point === 'attempt-rename-dirsync';
      assert.equal(fs.readFileSync(f.target, 'utf8'), afterRename ? 'new' : 'old');
    });
  }
  test(`${kind}: symlinks and hardlinks never satisfy the expected old identity`, () => {
    const f = fixture(kind);
    const witness = path.join(f.root, 'witness');
    fs.writeFileSync(witness, 'old', { mode: 0o600 });
    fs.unlinkSync(f.target);
    fs.symlinkSync(witness, f.target);
    assert.throws(() => replacePrivate(f.deps, f.root, kind, f.id, Buffer.from('new')), refused);
    fs.unlinkSync(f.target);
    fs.linkSync(witness, f.target);
    const linked = fileId(fs.lstatSync(f.target, { bigint: true }));
    assert.throws(() => replacePrivate(f.deps, f.root, kind, linked, Buffer.from('new')), refused);
    assert.equal(fs.readFileSync(witness, 'utf8'), 'old');
  });
}

test('package destinations are closed before any filesystem access', () => {
  const deps = resolveDeps();
  assert.throws(() => replacePrivate(deps, '/nonexistent-fixture', '../settings' as PrivateStateKind, null, Buffer.alloc(0)),
    (e: unknown) => e instanceof ToolError && e.code === 'package-state-kind-invalid');
});

test('production executor stays disabled and group probes never send a signal', () => {
  const deps = systemDeps();
  assert.equal(deps.packageExecutor, null);
  assert.ok(deps.probeGroup);
  const kill = mock.method(process, 'kill', () => true);
  try {
    for (const pgid of [0, 1, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(deps.probeGroup(pgid), 'unknown');
    }
    assert.equal(kill.mock.calls.length, 0);
    assert.equal(deps.probeGroup(42), 'alive');
    assert.deepEqual(kill.mock.calls[0].arguments, [-42, 0]);
  } finally { kill.mock.restore(); }
});

test('group probe errors become fixed observations without raw exception text', () => {
  const deps = systemDeps();
  assert.ok(deps.probeGroup);
  for (const [code, expected] of [['ESRCH', 'esrch'], ['EPERM', 'eperm'], ['EIO', 'unknown']] as const) {
    const kill = mock.method(process, 'kill', () => { throw Object.assign(new Error('private sentinel'), { code }); });
    try { assert.equal(deps.probeGroup(42), expected); }
    finally { kill.mock.restore(); }
  }
});

test('existing journal publication retains its exact fault order', () => {
  const f = fixture('ledger');
  const events: string[] = [];
  replaceFile({ ...f.deps, fault: point => events.push(point) }, f.root, 'journal.json', Buffer.from('journal'));
  assert.deepEqual(events, ['journal-write', 'journal-write-sync', 'journal-rename', 'journal-dirsync']);
  assert.equal(fs.readFileSync(path.join(f.root, 'journal.json'), 'utf8'), 'journal');
});
