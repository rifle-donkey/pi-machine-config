import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piInstallSource, registry } from '../src/env-host.ts';

test('default Pi install and version comparison retain an explicit declaration pin', () => {
  const source = registry('npm:@fixture/pkg@1.2.3')!;
  assert.deepEqual(piInstallSource(source, false, '2.0.0'), { effective: 'npm:@fixture/pkg@1.2.3', wanted: '1.2.3' });
});

test('recorded version is selected only in pin mode, which requires evidence', () => {
  const source = registry('npm:@fixture/pkg')!;
  assert.deepEqual(piInstallSource(source, false, '2.0.0'), { effective: 'npm:@fixture/pkg', wanted: undefined });
  assert.deepEqual(piInstallSource(source, true, '2.0.0'), { effective: 'npm:@fixture/pkg@2.0.0', wanted: '2.0.0' });
  assert.throws(() => piInstallSource(source, true, null), /missing-pin-version/);
});
