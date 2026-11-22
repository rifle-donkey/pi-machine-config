import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { analyzePreparedExtensions } from '../src/doctor-extensions.ts';

const key = 'extensions/example.ts';
const complete = { status: 'complete', files: [{ path: key, status: 'analyzed', imports: [] }] };
const cases = ['success', 'late', 'construction-delay', 'error', 'exit', 'unavailable', 'foreign-key', 'invalid-edge', 'stream-limit'] as const;

for (const scenario of cases) test(`diagnostic worker: ${scenario}`, async () => {
  let now = 10, terminated = 0;
  let cleaned!: () => void;
  const cleanup = new Promise<void>(resolve => { cleaned = resolve; });
  let instance!: FakeWorker;
  class FakeWorker extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    constructor(_url: URL, options: WorkerOptions) {
      super();
      instance = this;
      assert.deepEqual(options.execArgv, []);
      assert.deepEqual(options.resourceLimits, { maxOldGenerationSizeMb: 256 });
      assert.equal(options.stdout && options.stderr, true);
      const copy: Uint8Array = options.workerData[0].bytes;
      assert.equal(copy.buffer.byteLength, 2);
      assert.deepEqual([...copy], [2, 3]);
      assert.deepEqual(options.transferList, [copy.buffer]);
      if (scenario === 'construction-delay') now += 2000;
    }
    terminate() { terminated++; return cleanup.then(() => 0); }
  }
  try {
    const pending = analyzePreparedExtensions([{ path: key, bytes: Uint8Array.of(1, 2, 3, 4).subarray(1, 3) }], () => now,
      (url, options) => new FakeWorker(url, options) as unknown as Worker);
    let returned = false;
    void pending.then(() => { returned = true; });
    if (scenario === 'success') {
      instance.stdout.emit('data', Buffer.alloc(32768));
      instance.stderr.emit('data', Buffer.alloc(32768));
      now += 1999;
      instance.emit('message', complete);
      instance.emit('error', new Error('late event'));
    } else if (scenario === 'late') {
      now += 2000;
      instance.emit('message', complete);
    } else if (scenario === 'error') instance.emit('error', new Error('hidden'));
    else if (scenario === 'exit') instance.emit('exit', 0);
    else if (scenario === 'unavailable') instance.emit('message', { status: 'analyzer-unavailable' });
    else if (scenario === 'foreign-key') instance.emit('message', { ...complete, files: [{ path: '/hidden', status: 'not-module' }] });
    else if (scenario === 'invalid-edge') instance.emit('message', { ...complete, files: [{ path: key, status: 'analyzed', imports: [{ status: 'resolved', typeOnly: false, kind: 'static' }] }] });
    else if (scenario === 'stream-limit') {
      instance.stdout.emit('data', Buffer.alloc(32768));
      instance.stderr.emit('data', Buffer.alloc(32769));
      instance.emit('message', complete);
    }
    await Promise.resolve();
    assert.equal(returned, false);
    assert.equal(terminated, 1);
    cleaned();
    const result = await pending;
    if (scenario === 'success') assert.deepEqual(result, { status: 'complete', files: [{ path: key, status: 'analyzed',
      imports: { resolved: 0, missing: 0, 'outside-set': 0, unsupported: 0, 'unsupported-target': 0, external: 0 } }] });
    else assert.deepEqual(result, { status: 'unverified', reason: scenario === 'late' || scenario === 'construction-delay' ?
      'analysis-timeout' : scenario === 'unavailable' ? 'analyzer-unavailable' : 'analysis-failed' });
  } finally {
    cleaned();
  }
});

test('diagnostic worker: timer expiration requests cleanup without accepting a late message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let terminated = 0;
  let instance!: SilentWorker;
  class SilentWorker extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    constructor() { super(); instance = this; }
    async terminate() { terminated++; return 0; }
  }
  const pending = analyzePreparedExtensions([{ path: key, bytes: new Uint8Array() }], () => 0,
    () => new SilentWorker() as unknown as Worker);
  t.mock.timers.tick(1999);
  assert.equal(terminated, 0);
  t.mock.timers.tick(1);
  instance.emit('message', complete);
  assert.deepEqual(await pending, { status: 'unverified', reason: 'analysis-timeout' });
  assert.equal(terminated, 1);
});
