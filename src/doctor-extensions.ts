/** Run bounded bundle extension diagnostics and project worker output onto public fields. */
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { preparePlan, type PlanOptions } from './plan.ts';

const counts = ['resolved', 'missing', 'outside-set', 'unsupported', 'unsupported-target', 'external'] as const;
const reasons = ['decode-error', 'parse-error', 'parse-limit', 'import-limit', 'node-limit'] as const;
type Counts = Record<(typeof counts)[number], number>;
type FileReport = { path: string } & ({ status: 'analyzed'; imports: Counts } | { status: 'not-module' } |
  { status: 'failed'; reason: (typeof reasons)[number] });
type Failure = 'analysis-limit' | 'analysis-timeout' | 'analyzer-unavailable' | 'analysis-failed';
type Result = { status: 'complete'; files: FileReport[] } | { status: 'unverified'; reason: Failure };
const unverified = (reason: Failure): Result => ({ status: 'unverified', reason });
const reportFailure = unverified('analysis-failed');
const timeout = unverified('analysis-timeout');

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function project(value: unknown, keys: ReadonlySet<string>): Result {
  if (!record(value)) return reportFailure;
  if (value.status === 'limit') return unverified('analysis-limit');
  if (value.status === 'analyzer-unavailable') return unverified('analyzer-unavailable');
  if (value.status !== 'complete' || !Array.isArray(value.files) || value.files.length !== keys.size) return reportFailure;
  const files: FileReport[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of value.files as unknown[]) {
    if (!record(item) || typeof item.path !== 'string' || !keys.has(item.path) || seen.has(item.path)) return reportFailure;
    const path = item.path;
    seen.add(path);
    if (item.status === 'not-module') files.push({ path, status: item.status });
    else if (item.status === 'failed') {
      const reason = reasons.find(r => r === item.reason);
      if (!reason) return reportFailure;
      files.push({ path, status: item.status, reason });
    } else if (item.status === 'analyzed' && Array.isArray(item.imports) && item.imports.length <= 4096) {
      total += item.imports.length;
      if (total > 16384) return reportFailure;
      const imports: Counts = { resolved: 0, missing: 0, 'outside-set': 0, unsupported: 0, 'unsupported-target': 0, external: 0 };
      for (const edge of item.imports as unknown[]) {
        if (!record(edge) || typeof edge.typeOnly !== 'boolean' ||
            !['static', 'reexport', 'dynamic', 'require'].some(k => k === edge.kind)) return reportFailure;
        const status = counts.find(s => s === edge.status);
        if (!status || (status === 'resolved' && (typeof edge.target !== 'string' || !keys.has(edge.target)))) return reportFailure;
        imports[status]++;
      }
      files.push({ path, status: item.status, imports });
    } else return reportFailure;
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: 'complete', files };
}

type Input = { path: string; bytes: Uint8Array };

/** Internal worker boundary. Callers supply only bounded prepared extension files. */
export async function analyzePreparedExtensions(files: readonly Input[], now = () => performance.now(),
  start: (url: URL, options: WorkerOptions) => Worker = (url, options) => new Worker(url, options)): Promise<Result> {
  if (files.length > 1024 || files.reduce((size, file) => size + file.bytes.byteLength, 0) > 8 * 1024 * 1024) return unverified('analysis-limit');
  if (files.length === 0) return { status: 'complete', files: [] };
  const input = files.map(({ path, bytes }) => ({ path, bytes: new Uint8Array(bytes) }));
  const keys = new Set(input.map(file => file.path));
  const deadline = now() + 2000;
  let worker: Worker;
  try {
    worker = start(new URL('./doctor-worker.ts', import.meta.url), {
      execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 },
      workerData: input, transferList: input.map(file => file.bytes.buffer),
    });
  } catch { return reportFailure; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Result;
  try {
    result = await new Promise<Result>(resolve => {
      let bytes = 0;
      let settled = false;
      const finish = (outcome: Result) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      const drain = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) finish(reportFailure);
      };
      worker.stdout.on('data', drain);
      worker.stderr.on('data', drain);
      worker.on('error', () => finish(reportFailure));
      worker.once('exit', () => finish(reportFailure));
      worker.once('messageerror', () => finish(reportFailure));
      worker.once('message', (message: unknown) => {
        if (settled) return;
        if (now() >= deadline) return finish(timeout);
        try { finish(project(message, keys)); }
        catch { finish(reportFailure); }
      });
      const remaining = deadline - now();
      if (remaining <= 0) finish(timeout);
      else timer = setTimeout(() => finish(timeout), Math.ceil(remaining));
    });
  } catch { result = reportFailure; }
  finally { if (timer !== undefined) clearTimeout(timer); }
  try { await worker.terminate(); }
  catch { return reportFailure; }
  return result;
}

export function diagnoseBundleExtensions(opts: PlanOptions): Promise<Result> {
  const prepared = preparePlan(opts);
  return analyzePreparedExtensions(prepared.files.filter(file => file.root === 'agent' && file.class === 'extension-source'));
}
