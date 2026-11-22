/** Parse approved extension payloads in isolation. Never load the payloads as modules. */
import { parentPort, workerData } from 'node:worker_threads';

async function analyze() {
  let analyzer: typeof import('./extension-imports.ts');
  try { analyzer = await import('./extension-imports.ts'); }
  catch { parentPort?.postMessage({ status: 'analyzer-unavailable' }); return; }
  try { parentPort?.postMessage(analyzer.analyzeExtensionImports(workerData)); }
  catch { parentPort?.postMessage({ status: 'analysis-failed' }); }
}

void analyze();
