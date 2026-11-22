/** Internal syntax diagnostics over approved in-memory extension payloads. Not a readiness check. */
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import type { parse as babelParse, ParseResult } from '@babel/parser';
import { invalid } from './errors.ts';
import { decodeUtf8 } from './json.ts';
import { checkPlacement, checkProhibited, relPath } from './schema.ts';

// Use the locked checkout dependency, never a parent/global package lookup.
const { parse }: { parse: typeof babelParse } = createRequire(import.meta.url)('../node_modules/@babel/parser/lib/index.js');
const moduleSuffix = /\.(?:[cm]?[jt]s)$/i;
const tsSuffix = /\.[cm]?ts$/i;
const fileLimit = 128 * 1024;
const inputLimit = 8 * 1024 * 1024;
const entryLimit = 1024;
const nodeLimit = 262144;
const edgeLimit = 4096;
const totalEdgeLimit = 16384;

type Input = { path: string; bytes: Uint8Array };
type Kind = 'static' | 'reexport' | 'dynamic' | 'require';
type Status = 'external' | 'missing' | 'outside-set' | 'unsupported' | 'unsupported-target';
type Edge = { kind: Kind; typeOnly: boolean } & ({ status: Status } | { status: 'resolved'; target: string });
type Reason = 'decode-error' | 'parse-error' | 'parse-limit' | 'import-limit' | 'node-limit';
type FileReport = { path: string } & ({ status: 'not-module' } | { status: 'failed'; reason: Reason } |
  { status: 'analyzed'; imports: Edge[] });
type Report = { status: 'limit' } | { status: 'complete'; files: FileReport[] };

// Only parser-created AST objects are traversed. Avoid a runtime dependency on Babel types.
type AstNode = { type: string; start?: number | null; [key: string]: unknown };
function isNode(v: unknown): v is AstNode {
  return v !== null && typeof v === 'object' && 'type' in v && typeof v.type === 'string';
}

function classify(file: string, kind: Kind, typeOnly: boolean, literal: unknown, inputs: ReadonlyMap<string, Uint8Array>): Edge {
  const edge = { kind, typeOnly };
  if (!isNode(literal) || literal.type !== 'StringLiteral' || typeof literal.value !== 'string') return { ...edge, status: 'unsupported' };
  const spec = literal.value;
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    const unsupported = spec === '.' || spec === '..' || /^[/#]/.test(spec) ||
      (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) && !spec.startsWith('node:'));
    return { ...edge, status: unsupported ? 'unsupported' : 'external' };
  }
  if (/[\\?#%\x00-\x1f\x7f-\x9f]/.test(spec) || spec.split('/').some(part => part === '')) return { ...edge, status: 'unsupported' };
  const target = posix.join(posix.dirname(file), spec);
  if (!target.startsWith('extensions/')) return { ...edge, status: 'outside-set' };
  if (!inputs.has(target)) return { ...edge, status: 'missing' };
  if (!moduleSuffix.test(target) && !/\.json$/i.test(target)) return { ...edge, status: 'unsupported-target' };
  return { ...edge, status: 'resolved', target };
}

function readEdge(node: AstNode, file: string, inputs: ReadonlyMap<string, Uint8Array>): Edge | undefined {
  switch (node.type) {
    case 'ImportDeclaration':
      return classify(file, 'static', node.importKind === 'type', node.source, inputs);
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      if (node.source != null) return classify(file, 'reexport', node.exportKind === 'type', node.source, inputs);
      break;
    case 'TSImportEqualsDeclaration':
      if (isNode(node.moduleReference) && node.moduleReference.type === 'TSExternalModuleReference') {
        return classify(file, 'require', node.importKind === 'type', node.moduleReference.expression, inputs);
      }
      break;
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const callee = node.callee;
      if (!isNode(callee) || !Array.isArray(node.arguments)) break;
      const args: unknown[] = node.arguments;
      if (callee.type === 'Import') return classify(file, 'dynamic', false, args[0], inputs);
      if (callee.type === 'Identifier' && callee.name === 'require') {
        return classify(file, 'require', false, node.type === 'CallExpression' && args.length === 1 ? args[0] : undefined, inputs);
      }
      break;
    }
  }
  return undefined;
}

function analyzeFile(path: string, bytes: Uint8Array, inputs: ReadonlyMap<string, Uint8Array>): FileReport {
  const failed = (reason: Reason): FileReport => ({ path, status: 'failed', reason });
  if (!moduleSuffix.test(path)) return { path, status: 'not-module' };
  if (bytes.byteLength > fileLimit) return failed('parse-limit');
  let source: string;
  try { source = decodeUtf8(bytes).replace(/^\uFEFF/, ''); }
  catch { return failed('decode-error'); }
  let tree: ParseResult;
  try {
    tree = parse(source, {
      sourceType: /\.m[jt]s$/i.test(path) ? 'module' : 'unambiguous',
      plugins: tsSuffix.test(path) ? ['typescript'] : [], errorRecovery: false,
      tokens: false, ranges: false, attachComment: false, createImportExpressions: false,
    });
  } catch (error) { return failed(error instanceof RangeError ? 'parse-limit' : 'parse-error'); }
  const stack: AstNode[] = [];
  if (isNode(tree)) stack.push(tree);
  const edges: { start: number; edge: Edge }[] = [];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++visited > nodeLimit) return failed('node-limit');
    if (node.type === 'TSImportType' || (node.type === 'TSModuleDeclaration' && node.declare === true)) continue;
    const edge = readEdge(node, path, inputs);
    if (edge) {
      if (edges.length === edgeLimit) return failed('import-limit');
      edges.push({ start: node.start ?? 0, edge });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra' || key === 'comments') continue;
      if (isNode(child)) stack.push(child);
      else if (Array.isArray(child)) for (const member of child) if (isNode(member)) stack.push(member);
    }
  }
  edges.sort((a, b) => a.start - b.start);
  return { path, status: 'analyzed', imports: edges.map(item => item.edge) };
}

export function analyzeExtensionImports(files: readonly Input[]): Report {
  if (!Array.isArray(files)) throw invalid('extension-import-input-invalid');
  if (files.length > entryLimit) return { status: 'limit' };
  const inputs = new Map<string, Uint8Array>();
  let bytesTotal = 0;
  try {
    for (const file of files as readonly Input[]) {
      const path = relPath(file.path), bytes = file.bytes;
      checkProhibited('agent', path, 'extension-source');
      checkPlacement('agent', path, 'extension-source', 'common');
      if (inputs.has(path) || !(bytes instanceof Uint8Array)) throw invalid('extension-import-input-invalid');
      inputs.set(path, bytes);
      bytesTotal += bytes.byteLength;
    }
  } catch { throw invalid('extension-import-input-invalid'); }
  if (bytesTotal > inputLimit) return { status: 'limit' };
  let edgeTotal = 0;
  const results: FileReport[] = [];
  for (const path of [...inputs.keys()].sort()) {
    const report = analyzeFile(path, inputs.get(path)!, inputs);
    if (report.status === 'analyzed') edgeTotal += report.imports.length;
    if (edgeTotal > totalEdgeLimit) return { status: 'limit' };
    results.push(report);
  }
  return { status: 'complete', files: results };
}
