/**
 * Read-only new-target plan and activation approval token.
 *
 * The plan never creates directories, locks or files and never invokes Pi or
 * a package manager. It verifies the bundle and optional overlay, merges the
 * layers, revalidates the merged intent, renders templates in memory, checks
 * that every target is absent with an existing parent, and classifies each
 * item. Only a plan whose items are all `create` or `activation-required`
 * receives an approval token.
 *
 * Token: `sha256:<hex>` over `PLAN_TOKEN_DOMAIN`, a NUL byte, and the
 * canonical JSON of the reviewed intent (see `tokenDocument`). It identifies
 * what was reviewed; it is not a signature and does not prove who approved it.
 */
import os from 'node:os';
import path from 'node:path';
import { invalid } from './errors.ts';
import { themeReady } from './theme.ts';
import { promptReferencesReady } from './prompts.ts';
import {
  absentTarget,
  existingDir,
  guardLiveLexical,
  hasSiblingAlias,
  liveLocations,
  overlaps,
  requireAbsolute,
  type AbsentTarget,
  type GuardContext,
} from './fsafe.ts';
import { canonicalJson, type JsonObject, type JsonValue } from './json.ts';
import { loadBundle, loadOverlay, mergeLayers, type LoadedLayer, type Merged } from './bundle.ts';
import {
  ACTIVATION_SETTINGS,
  DISCOVERY_MODEL,
  LIMITS,
  TOOL_ID,
  checkContent,
  isBuiltinThemeSetting,
  isPositiveLocalEntry,
  isResourceSetting,
  renderTemplate,
  settingValue,
  sha256Hex,
  type FileClass,
  type FileRoot,
  type PackageDecl,
  type Platform,
} from './schema.ts';

export const PLAN_TOKEN_DOMAIN = 'pi-machine-config/plan-token/v1';

export type Operation = 'create' | 'activation-required' | 'conflict' | 'incomplete';

export type PlanItem =
  | { kind: 'setting'; key: string; operation: Operation; reason?: string }
  | { kind: 'package'; source: string; operation: Operation }
  | { kind: 'file'; root: FileRoot; path: string; class: FileClass; operation: Operation; reason?: string }
  | { kind: 'target'; target: 'agent' | 'lens-config'; operation: Operation; reason?: string };

export interface PlanOptions {
  bundle: string;
  platform: Platform;
  targetAgent: string;
  overlay?: string;
  lensConfig?: string;
  env?: Record<string, string | undefined>;
  /** Internal test seam for the live-path guard; see `GuardContext`. The CLI never sets it. */
  guard?: GuardContext;
}

export interface PlanResult {
  status: 'ready' | 'incomplete' | 'conflict';
  platform: Platform;
  overlay: boolean;
  items: PlanItem[];
  approvalToken: string | null;
}

/** Private rendered bytes for restore integration; never serialize this as CLI output. */
export interface PreparedFile {
  root: FileRoot;
  path: string;
  class: FileClass;
  bytes: Uint8Array;
  sha256: string;
}

/** Compilation is not authorization: callers must require ready and match the token. */
export interface PreparedPlan {
  result: PlanResult;
  /** Private comparison for proven existing restores; never an activation token. */
  intentToken: string | null;
  settings: JsonObject;
  packages: PackageDecl[];
  files: PreparedFile[];
  targets: { agent: string; lensConfig: string | null };
  protectedRoots: string[];
}

/**
 * Classes whose readiness needs an adapter this release does not have yet:
 * local-resource import/dependency analysis and executable-bit needs for
 * extension/skill sources and reviewed schema adapters for tool and external
 * configuration. Themes have a separate bounded adapter and discovery gate.
 * They are reported, never silently omitted.
 */
const INCOMPLETE_CLASSES: ReadonlyMap<FileClass, string> = new Map([
  ['extension-source', 'dependency-analysis-unavailable'],
  ['skill-source', 'dependency-analysis-unavailable'],
  ['tool-config', 'schema-adapter-unavailable'],
  ['external-config', 'schema-adapter-unavailable'],
]);
const ACTIVATION_CLASSES: ReadonlySet<FileClass> = new Set(['agent-context', 'extension-source', 'skill-source', 'prompt']);

function targetItem(target: 'agent' | 'lens-config', t: AbsentTarget): PlanItem {
  let reason: string | undefined;
  if (!t.parentExists) reason = 'target-parent-missing';
  else if (t.exists) reason = 'target-exists';
  else if (hasSiblingAlias(path.dirname(t.path), path.basename(t.path))) reason = 'target-alias-exists';
  return reason ? { kind: 'target', target, operation: 'conflict', reason } : { kind: 'target', target, operation: 'create' };
}

interface RenderedFile {
  root: FileRoot;
  path: string;
  class: FileClass;
  template: boolean;
  target: string;
  sha256: string;
}

function revalidate(merged: Merged): void {
  for (const k of Object.keys(merged.settings)) settingValue(k, merged.settings[k]);
  for (const f of merged.files) checkContent(f.record, f.bytes);
}

export function preparePlan(opts: PlanOptions): PreparedPlan {
  const live = liveLocations(opts.env ?? process.env, opts.guard);
  const bundleArg = requireAbsolute(opts.bundle, 'usage');
  const agentArg = requireAbsolute(opts.targetAgent, 'usage');
  const overlayArg = opts.overlay === undefined ? undefined : requireAbsolute(opts.overlay, 'usage');
  const lensArg = opts.lensConfig === undefined ? undefined : requireAbsolute(opts.lensConfig, 'usage');
  for (const p of [bundleArg, agentArg, overlayArg, lensArg]) if (p !== undefined) guardLiveLexical(p, live);

  const bundleRoot = existingDir(bundleArg, 'bundle-missing');
  const overlayRoot = overlayArg === undefined ? undefined : existingDir(overlayArg, 'overlay-missing');
  const agent = absentTarget(agentArg);
  const lens = lensArg === undefined ? undefined : absentTarget(lensArg);
  const roots = [bundleRoot.path, overlayRoot?.path, agent.path, lens?.path].filter((p): p is string => p !== undefined);
  for (const p of roots) guardLiveLexical(p, live);
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) if (overlaps(roots[i], roots[j])) throw invalid('roots-overlap');
  }

  const bundle = loadBundle(bundleRoot, opts.platform);
  const layers: LoadedLayer[] = [bundle.common, bundle.platform];
  const overlay = overlayRoot === undefined ? undefined : loadOverlay(overlayRoot, bundle.policy);
  if (overlay) layers.push(overlay);
  const merged = mergeLayers(layers);
  revalidate(merged);

  const needLens = merged.files.some((f) => f.record.root === 'lens-config');
  if (needLens && !lens) throw invalid('lens-config-required');
  if (!needLens && lens) throw invalid('lens-config-unused');

  // Inspect only winning, already-approved payloads. Never scan a live theme
  // directory or infer package contents from an uninstalled declaration.
  const themes = new Map<string, boolean>();
  for (const f of merged.files) if (f.record.class === 'theme') {
    themes.set(f.record.path, themeReady(f.bytes, path.basename(f.record.path, '.json')));
  }
  const canResolveLocalThemes = merged.packages.length === 0 &&
    (!Array.isArray(merged.settings.themes) || merged.settings.themes.length === 0);
  const items: PlanItem[] = [];
  for (const key of Object.keys(merged.settings)) {
    const v = merged.settings[key];
    if (isResourceSetting(key) && Array.isArray(v) && v.some((e) => typeof e === 'string' && isPositiveLocalEntry(e)) &&
      !(key === 'prompts' && promptReferencesReady(v as string[], merged.files, merged.packages.length > 0))) {
      items.push({ kind: 'setting', key, operation: 'incomplete', reason: 'resource-reference-unverified' });
    } else if (key === 'theme' && typeof v === 'string' && !isBuiltinThemeSetting(v) &&
      (!canResolveLocalThemes || v.split('/').some((name) => !isBuiltinThemeSetting(name) && themes.get(`themes/${name}.json`) !== true))) {
      items.push({ kind: 'setting', key, operation: 'incomplete', reason: 'theme-reference-unverified' });
    } else {
      items.push({ kind: 'setting', key, operation: ACTIVATION_SETTINGS.has(key) ? 'activation-required' : 'create' });
    }
  }
  for (const d of merged.packages) {
    items.push({ kind: 'package', source: typeof d === 'string' ? d : d.source, operation: 'activation-required' });
  }

  const home = os.userInfo().homedir;
  const rendered: RenderedFile[] = [];
  const files: PreparedFile[] = [];
  for (const { record, bytes } of merged.files) {
    const text = new TextDecoder().decode(bytes);
    const out = record.template ? renderTemplate(record.class, text, { HOME: home, AGENT_DIR: agent.path }) : bytes;
    if (out.length > LIMITS.fileBytes) throw invalid('file-too-large');
    let target: string;
    if (record.root === 'agent') target = path.join(agent.path, ...record.path.split('/'));
    else if (lens) target = lens.path;
    else throw invalid('lens-config-required');
    const sha256 = sha256Hex(out);
    rendered.push({ root: record.root, path: record.path, class: record.class, template: record.template, target, sha256 });
    files.push({ root: record.root, path: record.path, class: record.class, bytes: Buffer.from(out), sha256 });
    const reason = record.class === 'theme'
      ? themes.get(record.path) !== true ? 'theme-invalid' : merged.packages.length > 0 ? 'package-theme-discovery-unverified' : undefined
      : INCOMPLETE_CLASSES.get(record.class);
    const base = { kind: 'file' as const, root: record.root, path: record.path, class: record.class };
    if (reason) items.push({ ...base, operation: 'incomplete', reason });
    else items.push({ ...base, operation: ACTIVATION_CLASSES.has(record.class) ? 'activation-required' : 'create' });
  }

  items.push(targetItem('agent', agent));
  // A lens target inside the agent target was already refused as an overlapping root.
  if (lens) items.push(targetItem('lens-config', lens));

  const status = items.some((i) => i.operation === 'conflict')
    ? 'conflict'
    : items.some((i) => i.operation === 'incomplete')
      ? 'incomplete'
      : 'ready';
  let intentToken: string | null = null;
  const comparable = items.every((item) => item.operation === 'create' || item.operation === 'activation-required' ||
    (item.kind === 'target' && item.operation === 'conflict' && item.reason === 'target-exists'));
  if (comparable) {
    const doc = tokenDocument({
      bundle: {
        policy: bundle.policySha256,
        completion: bundle.completionSha256,
        common: bundle.common.manifestSha256,
        platform: bundle.platform.manifestSha256,
      },
      platform: opts.platform,
      overlay: overlay ? overlay.manifestSha256 : null,
      merged,
      files: rendered,
      targets: { agent: agent.path, lensConfig: lens ? lens.path : null },
    });
    intentToken = planToken(doc);
  }
  const approvalToken = status === 'ready' ? intentToken : null;
  return {
    result: { status, platform: opts.platform, overlay: overlay !== undefined, items, approvalToken },
    intentToken,
    settings: merged.settings,
    packages: merged.packages,
    files,
    targets: { agent: agent.path, lensConfig: lens ? lens.path : null },
    protectedRoots: [bundleRoot.path, ...(overlayRoot ? [overlayRoot.path] : [])],
  };
}

/** Public read-only result: rendered payloads and settings are deliberately omitted. */
export function plan(opts: PlanOptions): PlanResult {
  return preparePlan(opts).result;
}

interface TokenInput {
  bundle: { policy: string; completion: string; common: string; platform: string };
  platform: Platform;
  overlay: string | null;
  merged: Merged;
  files: RenderedFile[];
  targets: { agent: string; lensConfig: string | null };
}

/**
 * The reviewed intent the plan token covers: bundle policy/manifest/completion
 * digests, selected platform, overlay manifest digest, merged settings,
 * ordered package declarations (filters and autoload included), every file's
 * class, template flag, canonical target and rendered digest, canonical
 * targets, discovery model and tool version.
 */
export function tokenDocument(t: TokenInput): JsonObject {
  const doc = Object.create(null) as JsonObject;
  doc.tool = TOOL_ID;
  doc.discoveryModel = DISCOVERY_MODEL;
  doc.bundle = { ...t.bundle };
  doc.platform = t.platform;
  doc.overlay = t.overlay;
  doc.settings = t.merged.settings;
  // SAFETY: package declarations are validated JSON strings/objects.
  doc.packages = t.merged.packages as JsonValue[];
  doc.files = t.files.map((f) => ({ ...f }));
  doc.targets = { ...t.targets };
  return doc;
}

export function planToken(doc: JsonObject): string {
  const body = Buffer.concat([Buffer.from(PLAN_TOKEN_DOMAIN, 'utf8'), Buffer.from([0]), Buffer.from(canonicalJson(doc), 'utf8')]);
  return `sha256:${sha256Hex(body)}`;
}
