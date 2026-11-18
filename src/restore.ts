/**
 * Plan-to-transaction integration used by the fixture-only apply command.
 *
 * Compile through the same path as the public preview, require a complete ready
 * plan and explicit matching activation token, then let the engine re-check that
 * token under its state lock before its first journal or target write. Neither
 * the guard, OS dependencies nor verifier are command-line/environment options.
 *
 * A locked revalidation failure creates no target configuration. The engine may
 * retain its new private state directory without a journal; existing recovery
 * rules classify that as journal-missing rather than adopting or deleting it.
 * A reserved package-attempt entry instead blocks analysis before journal reads;
 * it is never adopted, opened or cleared by this service.
 */
import { isTokenSyntax } from './approval.ts';
import { failure, invalid } from './errors.ts';
import { guardLiveLexical, liveLocations, requireAbsolute } from './fsafe.ts';
import { preparePlan, type PlanOptions, type PreparedPlan } from './plan.ts';
import { PLATFORMS } from './schema.ts';
import { applyRestore, type ApplyResult, type RestorePacket } from './transaction.ts';
import type { TxDeps } from './transaction-fs.ts';

export interface RestoreOptions extends PlanOptions {
  stateDir: string;
  approveActivation?: string;
  /** Internal deterministic OS/fault test seam; never supplied by CLI/environment. */
  deps?: Partial<TxDeps>;
}

function approvedPlan(opts: PlanOptions, token: string): PreparedPlan {
  const prepared = preparePlan(opts);
  if (prepared.result.status !== 'ready' || prepared.result.approvalToken === null) throw failure('plan-not-ready');
  if (prepared.result.approvalToken !== token) throw failure('activation-approval-mismatch');
  return prepared;
}

export function restoreFromPlan(opts: RestoreOptions): ApplyResult {
  const approved = opts.approveActivation;
  if (approved === undefined) throw invalid('activation-approval-required');
  if (!isTokenSyntax(approved)) throw invalid('approval-token-invalid');
  if (!(PLATFORMS as readonly string[]).includes(opts.platform) || opts.platform !== (opts.deps?.platform ?? process.platform)) {
    throw invalid('platform-mismatch');
  }
  const state = requireAbsolute(opts.stateDir, 'usage');
  guardLiveLexical(state, liveLocations(opts.env ?? process.env, opts.guard));
  const planOptions: PlanOptions = {
    bundle: opts.bundle,
    platform: opts.platform,
    targetAgent: opts.targetAgent,
    overlay: opts.overlay,
    lensConfig: opts.lensConfig,
    env: opts.env,
    guard: opts.guard,
  };
  const initial = approvedPlan(planOptions, approved);
  const packet: RestorePacket = {
    planToken: approved,
    platform: opts.platform,
    state,
    agentTarget: initial.targets.agent,
    lensTarget: initial.targets.lensConfig,
    settings: initial.settings,
    packages: initial.packages,
    files: initial.files,
    protectedRoots: initial.protectedRoots,
  };
  return applyRestore(packet, {
    env: opts.env,
    guard: opts.guard,
    deps: opts.deps,
    verifyLockedIntent: () => {
      const locked = approvedPlan(planOptions, approved);
      // approvedPlan proves this is the exact non-null token supplied by the operator.
      return locked.result.approvalToken!;
    },
  });
}
