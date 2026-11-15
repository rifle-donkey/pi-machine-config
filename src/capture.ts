/**
 * Capture: project exactly the approved settings, package declarations and
 * files from an explicit source agent directory into a new bundle.
 *
 * `captureReview` is the read-only first step: it validates the policy, reads
 * only the permitted inputs and returns the capture-review token (see
 * approval.ts) with counts. `capture` requires that token, recomputes the
 * intent and refuses a mismatch before the bundle directory is created.
 *
 * All inputs are read and validated before the bundle directory is created,
 * including the size of the exact inclusion-approval record capture would
 * write, so `captureReview` never returns a token for a bundle no consumer
 * could read.
 * After the exclusive root mkdir the canonical output parent is synced.
 * Payloads are written exclusively, re-read and verified; the policy, layer
 * manifests and inclusion-approval record follow, and the completion marker,
 * which binds their digests, is written last. A failure after the bundle
 * directory exists leaves it without a completion marker, so every consumer
 * refuses it as incomplete. Nothing is deleted.
 */
import path from 'node:path';
import { approvalDocument, captureToken, isTokenSyntax, reviewDescriptor } from './approval.ts';
import { failure, invalid } from './errors.ts';
import {
  absentTarget,
  existingDir,
  existingFile,
  fsyncDir,
  guardLiveLexical,
  hasSiblingAlias,
  liveLocations,
  mkdirPrivate,
  overlaps,
  readFileRoot,
  readUnder,
  requireAbsolute,
  writeExclusive,
  type DirRoot,
  type GuardContext,
} from './fsafe.ts';
import { isObject, parseJsonBytes, prettyJson, type JsonObject, type JsonValue } from './json.ts';
import { APPROVAL_PATH, COMPLETE_PATH, MANIFEST_NAME, POLICY_PATH, layerDir, payloadPath } from './bundle.ts';
import {
  BUNDLE_LAYERS,
  LIMITS,
  checkContent,
  completionDocument,
  isResourceSetting,
  manifestDocument,
  packageDecl,
  packageIdentity,
  parseManifest,
  parsePolicy,
  resourceEntry,
  sameJson,
  settingValue,
  sha256Hex,
  type BundleLayer,
  type FileRecord,
  type LayerManifest,
  type PackageDecl,
  type Platform,
  type Policy,
} from './schema.ts';

export interface CaptureInputs {
  policy: string;
  sourceAgent: string;
  platform: Platform;
  sourceLensConfig?: string;
  env?: Record<string, string | undefined>;
  /** Internal test seam for the live-path guard; see `GuardContext`. The CLI never sets it. */
  guard?: GuardContext;
}

export interface CaptureOptions extends CaptureInputs {
  out: string;
  /** Capture-review token the operator approved; required. */
  approveInclusion?: string;
}

type LayerCounts = Record<string, { settings: number; packages: number; files: number }>;

export interface CaptureResult {
  layers: LayerCounts;
  skipped: { settings: number; packages: number };
}

export interface ReviewResult extends CaptureResult {
  captureReviewToken: string;
}

interface Planned {
  manifest: LayerManifest;
  payloads: Map<string, Uint8Array>;
}

interface Inputs {
  arg: { policy: string; source: string; lens: string | undefined };
  policyRoot: DirRoot;
  source: DirRoot;
  lensRoot: DirRoot | undefined;
}

interface Prepared {
  policyBytes: Uint8Array;
  planned: Map<BundleLayer, Planned>;
  token: string;
  /** Exact `manifests/inclusion-approval.json` bytes for `token`, already size-checked. */
  approvalBytes: Uint8Array;
  result: CaptureResult;
}

/**
 * Convert one settings resource entry: approved absolute paths inside the
 * source agent directory become agent-relative; other absolute paths fail.
 */
function convertResourceEntry(key: string, v: unknown, agentPaths: string[]): string {
  if (typeof v !== 'string' || v.length === 0) return resourceEntry(v, key);
  const prefix = '+-!'.includes(v[0]) ? v[0] : '';
  const body = v.slice(prefix.length);
  if (!body.startsWith('/')) return resourceEntry(v, key);
  const norm = path.posix.normalize(body);
  for (const a of agentPaths) {
    if (norm.startsWith(`${a}/`)) return resourceEntry(prefix + norm.slice(a.length + 1), key);
  }
  throw invalid('resource-path-outside-agent');
}

function projectSetting(key: string, v: unknown, agentPaths: string[]): JsonValue {
  if (isResourceSetting(key)) {
    if (!Array.isArray(v)) throw invalid('setting-invalid');
    return settingValue(key, v.map((e) => convertResourceEntry(key, e, agentPaths)));
  }
  return settingValue(key, v);
}

function readSourcePackages(settings: JsonObject): PackageDecl[] {
  if (!('packages' in settings)) return [];
  const raw = settings.packages;
  if (!Array.isArray(raw) || raw.length > LIMITS.arrayItems) throw invalid('settings-invalid');
  const out: PackageDecl[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    // Any unsupported source is an inclusion exception that blocks capture.
    const d = packageDecl(e, true);
    const id = packageIdentity(d);
    if (seen.has(id)) throw invalid('package-duplicate');
    seen.add(id);
    out.push(d);
  }
  return out;
}

type InputArgs = Inputs['arg'];

/** Validate the input path arguments lexically and apply the live-path guard; no filesystem access. */
function lexicalInputs(opts: CaptureInputs, live: string[], extraLexical: string[]): InputArgs {
  const policy = requireAbsolute(opts.policy, 'usage');
  const source = requireAbsolute(opts.sourceAgent, 'usage');
  const lens = opts.sourceLensConfig === undefined ? undefined : requireAbsolute(opts.sourceLensConfig, 'usage');
  for (const p of [policy, source, lens, ...extraLexical]) if (p !== undefined) guardLiveLexical(p, live);
  return { policy, source, lens };
}

/**
 * Canonicalize the input roots and apply the live-path guard and input
 * overlap rules. Reads path metadata only, no file content.
 */
function openInputs(arg: InputArgs, live: string[]): Inputs {
  const { policy: policyArg, source: sourceArg, lens: lensArg } = arg;
  const policyRoot = existingFile(policyArg, 'policy-missing');
  const source = existingDir(sourceArg, 'source-missing');
  const lensRoot = lensArg === undefined ? undefined : existingFile(lensArg, 'source-missing');
  for (const p of [policyRoot.path, source.path, lensRoot?.path]) if (p !== undefined) guardLiveLexical(p, live);
  // Whole-file inputs never come from inside the source agent directory, so an
  // argument cannot redirect capture to a credential or runtime file there.
  for (const p of [policyRoot.path, lensRoot?.path]) {
    if (p !== undefined && overlaps(source.path, p)) throw invalid('roots-overlap');
  }
  return { arg, policyRoot, source, lensRoot };
}

/**
 * Read only the permitted inputs and project the layer manifests and payloads
 * capture would write, plus the review token and the approval record. The policy
 * is validated in full (including prohibited destinations) before
 * `settings.json` or any listed file is opened. Writes nothing.
 */
function prepare(inputs: Inputs, platform: Platform): Prepared {
  const { source, lensRoot } = inputs;
  const policyBytes = readFileRoot(inputs.policyRoot, LIMITS.fileBytes);
  const policy: Policy = parsePolicy(parseJsonBytes(policyBytes));
  const captured: BundleLayer[] = ['common', `platform:${platform}`];
  for (const l of BUNDLE_LAYERS) {
    if (captured.includes(l)) continue;
    const r = policy.layers[l];
    if (r.settings.length > 0 || r.packages.length > 0 || r.files.length > 0) throw invalid('policy-platform-mismatch');
  }
  const needLens = captured.some((l) => policy.layers[l].files.some((f) => f.root === 'lens-config'));
  if (needLens && !lensRoot) throw invalid('lens-config-required');
  if (!needLens && lensRoot) throw invalid('lens-config-unused');

  const needSettings = captured.some((l) => policy.layers[l].settings.length > 0 || policy.layers[l].packages.length > 0);
  let srcSettings: JsonObject = Object.create(null) as JsonObject;
  if (needSettings) {
    const parsed = parseJsonBytes(readUnder(source, 'settings.json', LIMITS.fileBytes));
    if (!isObject(parsed)) throw invalid('settings-invalid');
    srcSettings = parsed;
  }
  const srcPackages = readSourcePackages(srcSettings);
  const agentPaths = [...new Set([inputs.arg.source, source.path])];

  const planned = new Map<BundleLayer, Planned>();
  let total = 0;
  const usedSettings = new Set<string>();
  const usedPackages = new Set<string>();
  for (const l of BUNDLE_LAYERS) {
    const rules = policy.layers[l];
    const manifest: LayerManifest = { layer: l, settings: Object.create(null) as JsonObject, packages: [], files: [], packagesRemove: [] };
    const payloads = new Map<string, Uint8Array>();
    if (captured.includes(l)) {
      for (const key of rules.settings) {
        if (!(key in srcSettings)) throw invalid('setting-missing', l);
        manifest.settings[key] = projectSetting(key, srcSettings[key], agentPaths);
        usedSettings.add(key);
      }
      for (const rule of rules.packages) {
        if (!srcPackages.some((d) => packageIdentity(d) === packageIdentity(rule))) throw invalid('package-missing', l);
      }
      // Source order is load order; keep it.
      for (const d of srcPackages) {
        const rule = rules.packages.find((r) => packageIdentity(r) === packageIdentity(d));
        if (!rule) continue;
        if (!sameJson(rule, d)) throw invalid('package-filter-mismatch', l);
        manifest.packages.push(rule);
        usedPackages.add(packageIdentity(d));
      }
      let layerBytes = 0;
      for (const rule of rules.files) {
        const bytes = rule.root === 'lens-config' ? readLens(lensRoot) : readUnder(source, rule.path, LIMITS.fileBytes);
        checkContent(rule, bytes);
        const sha = sha256Hex(bytes);
        if (rule.sha256 !== undefined && rule.sha256 !== sha) throw invalid('file-digest-mismatch', l);
        const rec: FileRecord = { root: rule.root, path: rule.path, class: rule.class, bytes: bytes.length, sha256: sha, template: rule.template };
        if (rule.expect) rec.expect = rule.expect;
        manifest.files.push(rec);
        payloads.set(payloadPath(rec), bytes);
        layerBytes += bytes.length;
      }
      if (layerBytes > LIMITS.layerBytes) throw invalid('layer-too-large', l);
      total += layerBytes;
    }
    // Round-trip through the strict manifest validator before anything is written.
    parseManifest(parseJsonBytes(Buffer.from(prettyJson(manifestDocument(manifest)))), l);
    planned.set(l, { manifest, payloads });
  }
  if (total > LIMITS.totalBytes) throw invalid('bundle-too-large');

  const manifests = Object.create(null) as Record<BundleLayer, LayerManifest>;
  for (const l of BUNDLE_LAYERS) manifests[l] = (planned.get(l) as Planned).manifest;
  const descriptor = reviewDescriptor({ platform, policySha256: sha256Hex(policyBytes), manifests });
  const token = captureToken(descriptor);
  // The approval record embeds all three layer manifests, so it can exceed the
  // JSON read limit every consumer applies even when each manifest fits (and it
  // is larger than each manifest it embeds). Check the exact bytes capture
  // records, before review returns a token or capture creates output.
  const approvalBytes = Buffer.from(prettyJson(approvalDocument(token, descriptor)));
  if (approvalBytes.length > LIMITS.fileBytes) throw invalid('inclusion-approval-too-large');

  const layers: LayerCounts = {};
  for (const l of captured) {
    const m = manifests[l];
    layers[l] = { settings: Object.keys(m.settings).length, packages: m.packages.length, files: m.files.length };
  }
  const skippedSettings = Object.keys(srcSettings).filter((k) => k !== 'packages' && !usedSettings.has(k)).length;
  const skippedPackages = srcPackages.filter((d) => !usedPackages.has(packageIdentity(d))).length;
  return {
    policyBytes,
    planned,
    token,
    approvalBytes,
    result: { layers, skipped: { settings: skippedSettings, packages: skippedPackages } },
  };
}

/**
 * Read-only capture review: validate the policy, read only the permitted
 * source inputs, and return the capture-review token with counts. Creates
 * nothing.
 */
export function captureReview(opts: CaptureInputs): ReviewResult {
  const live = liveLocations(opts.env ?? process.env, opts.guard);
  const inputs = openInputs(lexicalInputs(opts, live, []), live);
  const p = prepare(inputs, opts.platform);
  return { ...p.result, captureReviewToken: p.token };
}

/**
 * Capture a new bundle. Requires the capture-review token of exactly the
 * intent being captured; the intent is recomputed and compared before the
 * output directory is created.
 */
export function capture(opts: CaptureOptions): CaptureResult {
  const live = liveLocations(opts.env ?? process.env, opts.guard);
  const outArg = requireAbsolute(opts.out, 'usage');
  const args = lexicalInputs(opts, live, [outArg]);
  if (opts.approveInclusion === undefined) throw invalid('inclusion-approval-required');
  if (!isTokenSyntax(opts.approveInclusion)) throw invalid('approval-token-invalid');
  const inputs = openInputs(args, live);

  const out = absentTarget(outArg);
  // Like plan targets, an existing output or a missing parent is a conflict (exit 1).
  if (!out.parentExists) throw failure('output-parent-missing');
  if (out.exists) throw failure('output-exists');
  guardLiveLexical(out.path, live);
  for (const p of [inputs.policyRoot.path, inputs.source.path, inputs.lensRoot?.path]) {
    if (p !== undefined && overlaps(out.path, p)) throw invalid('roots-overlap');
  }
  // A case or Unicode-normalization alias of the output already present in the
  // parent is refused before anything is created.
  if (hasSiblingAlias(path.dirname(out.path), path.basename(out.path))) throw failure('output-alias-exists');

  const p = prepare(inputs, opts.platform);
  if (p.token !== opts.approveInclusion) throw failure('inclusion-approval-mismatch');
  // The supplied token equals the recomputed one, so the prepared record is exactly the approved record.
  writeBundle(out.path, p.policyBytes, p.approvalBytes, p.planned);
  return p.result;
}

function readLens(root: DirRoot | undefined): Buffer {
  if (!root) throw invalid('lens-config-required');
  return readFileRoot(root, LIMITS.fileBytes);
}

function writeBundle(outPath: string, policyBytes: Uint8Array, approvalBytes: Uint8Array, planned: Map<BundleLayer, Planned>): void {
  const dirs: string[] = [];
  const made = new Set<string>();
  const mk = (rel: string): void => {
    if (made.has(rel)) return;
    const parent = path.posix.dirname(rel);
    if (parent !== '.') mk(parent);
    mkdirPrivate(path.join(outPath, rel));
    made.add(rel);
    dirs.push(rel);
  };
  mkdirPrivate(outPath);
  // Make the new root's directory entry durable in its canonical parent before
  // anything that could later be taken as a completed bundle is written.
  fsyncDir(path.dirname(outPath));
  mk('manifests');
  const written: { rel: string; sha: string }[] = [];
  for (const l of BUNDLE_LAYERS) {
    const { payloads } = planned.get(l) as Planned;
    const base = layerDir(l);
    mk(base);
    for (const [rel, bytes] of payloads) {
      const full = `${base}/${rel}`;
      mk(path.posix.dirname(full));
      writeExclusive(path.join(outPath, full), bytes);
      written.push({ rel: full, sha: sha256Hex(bytes) });
    }
  }
  for (const d of [...dirs].reverse()) fsyncDir(path.join(outPath, d));
  fsyncDir(outPath);

  const root = existingDir(outPath, 'write-failed');
  const verify = (rel: string, sha: string): void => {
    const got = readUnder(root, rel, LIMITS.fileBytes);
    if (sha256Hex(got) !== sha) throw invalid('capture-verify-failed');
  };
  for (const w of written) verify(w.rel, w.sha);

  writeExclusive(path.join(outPath, POLICY_PATH), policyBytes);
  const policySha = sha256Hex(policyBytes);
  verify(POLICY_PATH, policySha);
  const layerShas = Object.create(null) as Record<BundleLayer, string>;
  for (const l of BUNDLE_LAYERS) {
    const bytes = Buffer.from(prettyJson(manifestDocument((planned.get(l) as Planned).manifest)));
    const rel = `${layerDir(l)}/${MANIFEST_NAME}`;
    writeExclusive(path.join(outPath, rel), bytes);
    layerShas[l] = sha256Hex(bytes);
    verify(rel, layerShas[l]);
  }
  writeExclusive(path.join(outPath, APPROVAL_PATH), approvalBytes);
  const approvalSha = sha256Hex(approvalBytes);
  verify(APPROVAL_PATH, approvalSha);
  for (const d of [...dirs].reverse()) fsyncDir(path.join(outPath, d));
  // Completion marker last: its presence is the only signal of a usable bundle.
  writeExclusive(path.join(outPath, COMPLETE_PATH), Buffer.from(prettyJson(completionDocument(policySha, approvalSha, layerShas))));
  fsyncDir(path.join(outPath, 'manifests'));
  fsyncDir(outPath);
}
