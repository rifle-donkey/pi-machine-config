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
import { capture, captureReview } from './capture.ts';
import { ToolError, invalid } from './errors.ts';
import type { GuardContext } from './fsafe.ts';
import { plan } from './plan.ts';
import { PLATFORMS, type Platform } from './schema.ts';

export const USAGE = `Usage:
  pi-machine-config capture-review --policy <file> --source-agent <dir> --platform <darwin|linux> [--source-lens-config <file>]
  pi-machine-config capture --policy <file> --source-agent <dir> --platform <darwin|linux> --out <new-dir> --approve-inclusion <token> [--source-lens-config <file>]
  pi-machine-config plan --bundle <dir> --platform <darwin|linux> --target-agent <new-dir> [--overlay <dir>] [--lens-config <new-file>]
All paths must be absolute.
`;

export interface CliOutput {
  code: number;
  stdout: string;
  stderr: string;
}

const SPECS: Record<string, { required: string[]; optional: string[] }> = {
  'capture-review': { required: ['policy', 'source-agent', 'platform'], optional: ['source-lens-config'] },
  // A missing approval is reported as `inclusion-approval-required`, not `usage`.
  capture: { required: ['policy', 'source-agent', 'platform', 'out'], optional: ['source-lens-config', 'approve-inclusion'] },
  plan: { required: ['bundle', 'platform', 'target-agent'], optional: ['overlay', 'lens-config'] },
};

function parseArgs(command: string, args: string[]): Map<string, string> {
  const spec = SPECS[command];
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag.startsWith('--') || value === undefined) throw invalid('usage');
    const name = flag.slice(2);
    if (!spec.required.includes(name) && !spec.optional.includes(name)) throw invalid('usage');
    if (out.has(name)) throw invalid('usage');
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
    if (command === undefined || !(command in SPECS)) throw invalid('usage');
    const a = parseArgs(command, rest);
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
    const r = plan({
      bundle: a.get('bundle') ?? '',
      platform: platformArg(a.get('platform')),
      targetAgent: a.get('target-agent') ?? '',
      overlay: a.get('overlay'),
      lensConfig: a.get('lens-config'),
      env,
      guard,
    });
    return { code: r.status === 'ready' ? 0 : 1, stdout: json({ ok: r.status === 'ready', command, ...r }), stderr: '' };
  } catch (e) {
    if (e instanceof ToolError) {
      const body: Record<string, unknown> = { ok: false, error: e.code };
      if (e.layer !== undefined) body.layer = e.layer;
      return { code: e.exit, stdout: '', stderr: json(body) };
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
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
