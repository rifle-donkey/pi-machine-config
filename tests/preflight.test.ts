import assert from 'node:assert/strict';
import { test } from 'node:test';
import projectPackage from '../package.json' with { type: 'json' };
import { NODE_BASELINE_MAJOR, nodeBaselineMet } from '../src/preflight.ts';

test('Node baseline matches package engines and includes the exact threshold', () => {
  assert.equal(projectPackage.engines.node, `>=${NODE_BASELINE_MAJOR}`);
  assert.equal(nodeBaselineMet(`${NODE_BASELINE_MAJOR - 1}.99.99`), false);
  assert.equal(nodeBaselineMet(`${NODE_BASELINE_MAJOR}.0.0`), true);
});
