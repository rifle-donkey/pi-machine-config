/**
 * Read-only comparison of an approved bundle with a proven applied transaction.
 * This is the private foundation for doctor/package planning, not activation.
 * Returned rendered data and snapshot descriptors must never be CLI output.
 */
import { failure } from './errors.ts';
import { preparePlan, type PlanOptions, type PreparedPlan } from './plan.ts';
import { renderSettings } from './settings-output.ts';
import { sha256Hex } from './schema.ts';
import { readAppliedRestore, type AppliedRestoreSnapshot } from './transaction.ts';
import type { TxDeps } from './transaction-fs.ts';

export interface AppliedPlanOptions extends PlanOptions {
  stateDir: string;
  tx: string;
  /** Internal deterministic test seam, never set through CLI or environment. */
  deps?: Partial<TxDeps>;
}
export interface AppliedPlan {
  prepared: PreparedPlan;
  snapshot: AppliedRestoreSnapshot;
}

export function auditAppliedPlan(opts: AppliedPlanOptions): AppliedPlan {
  const snapshot = readAppliedRestore(opts.stateDir, opts.tx, {
    env: opts.env, guard: opts.guard, deps: opts.deps,
    expectedTargets: { agent: opts.targetAgent, lens: opts.lensConfig ?? null },
  });
  const prepared = preparePlan(opts);
  if (prepared.intentToken === null) throw failure('restore-intent-unverified');
  if (snapshot.platform !== opts.platform || prepared.intentToken !== snapshot.planToken) throw failure('restore-intent-mismatch');
  const expected = prepared.files.map((f) => ({ root: f.root, path: f.path, class: f.class as string, sha256: f.sha256, bytes: f.bytes.length }));
  const settings = renderSettings(prepared.settings, prepared.packages);
  if (settings !== null) expected.push({ root: 'agent', path: 'settings.json', class: 'settings', sha256: sha256Hex(settings), bytes: settings.length });
  if (expected.length !== snapshot.outputs.length || expected.some((f) => !snapshot.outputs.some((o) =>
    o.root === f.root && o.path === f.path && o.class === f.class && o.sha256 === f.sha256 && o.bytes === f.bytes))) {
    throw failure('restore-intent-mismatch');
  }
  return { prepared, snapshot };
}
