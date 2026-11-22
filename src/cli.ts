#!/usr/bin/env node
/**
 * Command-line entry point. Prints one JSON document on stdout for results
 * and one on stderr for errors; never prints raw configuration values,
 * rejected input strings, paths or exception text.
 *
 * Exit status: 0 success, 1 conflict/operational failure (including
 * incomplete or conflicting plans), 2 invalid input or invocation.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditAppliedPlan } from './applied-plan.ts';
import { capture, captureReview } from './capture.ts';
import { ToolError, invalid } from './errors.ts';
import type { GuardContext } from './fsafe.ts';
import { plan } from './plan.ts';
import { preflight } from './preflight.ts';
import { PLATFORMS, type Platform } from './schema.ts';
import { restoreFromPlan } from './restore.ts';
import { inspectRestore, resolveRestore, rollbackRestore } from './transaction.ts';

export const USAGE = `Usage:
  pi-machine-config preflight [--npm-package <abs-dir>] [--pi-package <abs-dir>]
  pi-machine-config capture-review --policy <file> --source-agent <dir> --platform <darwin|linux> [--source-lens-config <file>]
  pi-machine-config capture --policy <file> --source-agent <dir> --platform <darwin|linux> --out <new-dir> --approve-inclusion <token> [--source-lens-config <file>]
  pi-machine-config plan --bundle <dir> --platform <darwin|linux> --target-agent <new-dir> [--overlay <dir>] [--lens-config <new-file>]
  pi-machine-config apply --bundle <dir> --platform <darwin|linux> --target-agent <new-dir> --state-dir <new-dir> --approve-activation <token> [--overlay <dir>] [--lens-config <new-file>]
  pi-machine-config doctor --bundle <dir> --platform <darwin|linux> --target-agent <dir> --state-dir <dir> --tx <id> [--overlay <dir>] [--lens-config <file>]
  pi-machine-config doctor --extension-imports --bundle <dir> --platform <darwin|linux> --target-agent <dir> [--overlay <dir>] [--lens-config <file>]
  pi-machine-config doctor --resource-checks --bundle <dir> --platform <darwin|linux> --target-agent <dir> [--overlay <dir>] [--lens-config <file>]
  pi-machine-config rollback --state-dir <dir> --target-agent <dir> --tx <id> [--lens-config <file>]
  pi-machine-config recover --state-dir <dir> --target-agent <dir> --inspect [--lens-config <file>]
  pi-machine-config recover --state-dir <dir> --target-agent <dir> --resolve --tx <id> --expect <class> --action <action> [--lens-config <file>]
All paths must be absolute. Real Pi locations remain refused.
`;

export interface CliOutput {
  code: number;
  stdout: string;
  stderr: string;
}

const SPECS: Record<string, { required: string[]; optional: string[]; flags?: string[] }> = {
  preflight: { required: [], optional: ['npm-package', 'pi-package'] },
  'capture-review': { required: ['policy', 'source-agent', 'platform'], optional: ['source-lens-config'] },
  // A missing approval is reported as `inclusion-approval-required`, not `usage`.
  capture: { required: ['policy', 'source-agent', 'platform', 'out'], optional: ['source-lens-config', 'approve-inclusion'] },
  plan: { required: ['bundle', 'platform', 'target-agent'], optional: ['overlay', 'lens-config'] },
  apply: { required: ['bundle', 'platform', 'target-agent', 'state-dir'], optional: ['overlay', 'lens-config', 'approve-activation'] },
  doctor: { required: ['bundle', 'platform', 'target-agent', 'state-dir', 'tx'], optional: ['overlay', 'lens-config'] },
  rollback: { required: ['state-dir', 'target-agent', 'tx'], optional: ['lens-config'] },
  recover: { required: ['state-dir', 'target-agent'], optional: ['lens-config', 'tx', 'expect', 'action'], flags: ['inspect', 'resolve'] },
};

function parseArgs(spec: (typeof SPECS)[string], args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('--')) throw invalid('usage');
    const name = flag.slice(2);
    if (out.has(name)) throw invalid('usage');
    if (spec.flags?.includes(name)) {
      out.set(name, 'true');
      continue;
    }
    if (!spec.required.includes(name) && !spec.optional.includes(name)) throw invalid('usage');
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw invalid('usage');
    out.set(name, value);
  }
  for (const r of spec.required) if (!out.has(r)) throw invalid('usage');
  return out;
}

function platformArg(v: string | undefined): Platform {
  if (v === undefined || !(PLATFORMS as readonly string[]).includes(v)) throw invalid('usage');
  return v as Platform;
}

function json(v: unknown): string {
  return `${JSON.stringify(v)}\n`;
}

/**
 * Run one command. `guard` is an internal test seam for in-process tests
 * (see `GuardContext`); the executable entry point never passes it.
 */
export function main(argv: string[], env: Record<string, string | undefined> = process.env, guard?: GuardContext): CliOutput {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') return { code: 0, stdout: USAGE, stderr: '' };
  try {
    if (command === undefined || !Object.hasOwn(SPECS, command)) throw invalid('usage');
    const a = parseArgs(SPECS[command], rest);
    if (command === 'preflight') {
      const r = preflight(a.get('npm-package'), a.get('pi-package'), env, guard);
      return { code: r.ok ? 0 : 1, stdout: json({ command, ...r }), stderr: '' };
    }
    if (command === 'capture-review') {
      const r = captureReview({
        policy: a.get('policy') ?? '',
        sourceAgent: a.get('source-agent') ?? '',
        platform: platformArg(a.get('platform')),
        sourceLensConfig: a.get('source-lens-config'),
        env,
        guard,
      });
      return { code: 0, stdout: json({ ok: true, command, ...r }), stderr: '' };
    }
    if (command === 'capture') {
      const r = capture({
        policy: a.get('policy') ?? '',
        sourceAgent: a.get('source-agent') ?? '',
        platform: platformArg(a.get('platform')),
        out: a.get('out') ?? '',
        sourceLensConfig: a.get('source-lens-config'),
        approveInclusion: a.get('approve-inclusion'),
        env,
        guard,
      });
      return { code: 0, stdout: json({ ok: true, command, ...r }), stderr: '' };
    }
    if (command === 'plan') {
      const r = plan({
        bundle: a.get('bundle') ?? '', platform: platformArg(a.get('platform')),
        targetAgent: a.get('target-agent') ?? '', overlay: a.get('overlay'), lensConfig: a.get('lens-config'), env, guard,
      });
      return { code: r.status === 'ready' ? 0 : 1, stdout: json({ ok: r.status === 'ready', command, ...r }), stderr: '' };
    }
    if (command === 'apply') {
      const r = restoreFromPlan({
        bundle: a.get('bundle') ?? '', platform: platformArg(a.get('platform')),
        targetAgent: a.get('target-agent') ?? '', stateDir: a.get('state-dir') ?? '',
        approveActivation: a.get('approve-activation'), overlay: a.get('overlay'), lensConfig: a.get('lens-config'), env, guard,
      });
      return { code: 0, stdout: json({ ok: true, command, ...r }), stderr: '' };
    }
    if (command === 'doctor') {
      auditAppliedPlan({
        bundle: a.get('bundle') ?? '', platform: platformArg(a.get('platform')),
        targetAgent: a.get('target-agent') ?? '', stateDir: a.get('state-dir') ?? '', tx: a.get('tx') ?? '',
        overlay: a.get('overlay'), lensConfig: a.get('lens-config'), env, guard, lockPolicy: 'presence',
      });
      return { code: 0, stdout: json({ ok: true, command, status: 'match' }), stderr: '' };
    }
    if (command === 'recover') {
      if (a.has('inspect') === a.has('resolve')) throw invalid('usage');
      const mutation = ['tx', 'expect', 'action'];
      if (a.has('inspect') && mutation.some((k) => a.has(k))) throw invalid('usage');
      if (a.has('resolve') && mutation.some((k) => !a.has(k))) throw invalid('usage');
    }
    const state = a.get('state-dir') ?? '';
    const context = { env, guard, expectedTargets: { agent: a.get('target-agent') ?? '', lens: a.get('lens-config') ?? null } };
    if (command === 'rollback') {
      const r = rollbackRestore(state, a.get('tx') ?? '', context);
      return { code: 0, stdout: json({ ok: true, command, ...r }), stderr: '' };
    }
    if (a.has('inspect')) {
      const r = inspectRestore(state, context);
      const ok = ['applied', 'rolled-back', 'closed'].includes(r.class);
      return { code: ok ? 0 : 1, stdout: json({ ok, command, ...r }), stderr: '' };
    }
    const r = resolveRestore(state, { tx: a.get('tx') ?? '', expect: a.get('expect') ?? '', action: a.get('action') ?? '' }, context);
    return { code: 0, stdout: json({ ok: true, command, tx: r.tx, action: r.action, previousClass: r.class, removed: r.removed }), stderr: '' };
  } catch (e) {
    if (e instanceof ToolError) {
      if (command === 'doctor' && e.exit === 1) {
        const status = e.code === 'restore-intent-mismatch' ? 'mismatch' : 'unverified';
        return { code: 1, stdout: json({ ok: false, command, status, reason: e.code }), stderr: '' };
      }
      const body: Record<string, unknown> = { ok: false, error: e.code };
      if (e.layer !== undefined) body.layer = e.layer;
      return { code: e.exit, stdout: '', stderr: json(body) };
    }
    return { code: 1, stdout: '', stderr: json({ ok: false, error: 'internal-error' }) };
  }
}

/** Executable dispatch; load opt-in diagnostics only when selected. */
export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env,
  guard?: GuardContext): Promise<CliOutput> {
  const [command, ...rest] = argv;
  if (command !== 'doctor') return main(argv, env, guard);
  let mode: 'extension-imports' | 'resource-checks' = 'extension-imports';
  try {
    const a = parseArgs({ required: ['bundle', 'platform', 'target-agent'],
      optional: ['overlay', 'lens-config', 'state-dir', 'tx'], flags: ['extension-imports', 'resource-checks'] }, rest);
    const extensions = a.has('extension-imports'), resources = a.has('resource-checks');
    if (!extensions && !resources) return main(argv, env, guard);
    if ((extensions && resources) || a.has('tx') || a.has('state-dir')) throw invalid('usage');
    if (resources) mode = 'resource-checks';
    const opts = { bundle: a.get('bundle')!, platform: platformArg(a.get('platform')), targetAgent: a.get('target-agent')!,
      overlay: a.get('overlay'), lensConfig: a.get('lens-config'), env, guard };
    const report = resources ? (await import('./doctor-resources.ts')).diagnoseBundleResources(opts) :
      await (await import('./doctor-extensions.ts')).diagnoseBundleExtensions(opts);
    const ok = report.status === 'complete';
    return { code: ok ? 0 : 1, stdout: json({ ok, command, mode, ...report }), stderr: '' };
  } catch (e) {
    if (e instanceof ToolError) {
      if (e.exit === 1) return { code: 1, stdout: json({ ok: false, command, mode,
        status: 'unverified', reason: e.code }), stderr: '' };
      return { code: e.exit, stdout: '', stderr: json({ ok: false, error: e.code, layer: e.layer }) };
    }
    return { code: 1, stdout: '', stderr: json({ ok: false, error: 'internal-error' }) };
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const r = await runCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
