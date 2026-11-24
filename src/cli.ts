#!/usr/bin/env node
/** Public scan/deploy command and fixed-code failure reporting. */
import { ToolError, invalid } from './errors.ts';
import { relativePath } from './env-files.ts';
import { scan } from './env-scan.ts';
import { deploy } from './env-deploy.ts';

const usage = `Usage:
  node src/cli.ts scan --out <file.tar.gz> [--include <path>]... [--exclude <path>]... [--allow-secret <path>]...
  node src/cli.ts deploy <file.tar.gz> [--yes] [--pin-versions]
`;
function main(args: string[]) {
  const [cmd, ...rest] = args;
  if (cmd === '--help' && !rest.length) { process.stdout.write(usage); return; }
  if (!(process.platform === 'darwin' || process.platform === 'linux') || Number(process.versions.node.split('.')[0]) < 24) throw invalid('unsupported-runtime');
  if (cmd === 'scan') {
    const paths = { '--include': [] as string[], '--exclude': [] as string[], '--allow-secret': [] as string[] };
    let out: string | undefined;
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]!, value = rest[i + 1];
      if (!value || value.startsWith('--')) throw invalid('usage');
      if (key === '--out' && !out) out = value;
      else if (Object.hasOwn(paths, key)) paths[key as keyof typeof paths].push(relativePath(value));
      else throw invalid('usage');
    }
    if (!out) throw invalid('usage');
    process.stdout.write(`${JSON.stringify(scan(out, paths['--include'], paths['--exclude'], paths['--allow-secret']))}\n`);
    return;
  }
  if (cmd === 'deploy') {
    const [archive, ...flags] = rest;
    if (!archive || archive.startsWith('--') || new Set(flags).size !== flags.length || flags.some(s => s !== '--yes' && s !== '--pin-versions')) throw invalid('usage');
    deploy(archive, flags.includes('--yes'), flags.includes('--pin-versions'));
    return;
  }
  throw invalid('usage');
}
try { main(process.argv.slice(2)); } catch (err) {
  const e = err instanceof ToolError ? err : undefined;
  process.stderr.write(`${JSON.stringify({ error: e?.code ?? 'operation-failed' })}\n`);
  process.exitCode = e?.exit ?? 1;
}
