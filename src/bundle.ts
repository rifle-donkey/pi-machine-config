/**
 * Bundle and overlay layout, verified loading, and deterministic layer merge.
 *
 * Bundle layout (all paths relative to the bundle root):
 *   manifests/inclusion.json        inclusion policy (exact bytes captured)
 *   manifests/inclusion-approval.json  recorded capture approval (see approval.ts)
 *   config/common/manifest.json     layer manifest
 *   config/common/files/<root>/<path>
 *   config/platforms/<os>/manifest.json and files/...
 *   manifests/complete.json         completion marker, written last
 * Overlay layout: <overlay>/manifest.json and <overlay>/files/<root>/<path>.
 *
 * Every consumer requires the completion marker, rechecks the policy,
 * approval-record and manifest digests it records, revalidates the approval
 * record against the policy and all three layer manifests, and rechecks every
 * selected payload's size and digest.
 */
import { checkApprovalMatchesBundle, parseApproval } from './approval.ts';
import { ToolError, invalid } from './errors.ts';
import { readUnder, type DirRoot } from './fsafe.ts';
import { parseJsonBytes, type JsonObject } from './json.ts';
import {
  BUNDLE_LAYERS,
  LIMITS,
  checkContent,
  checkLayerAgainstPolicy,
  checkOverlayAgainstPolicy,
  fileKey,
  packageIdentity,
  parseCompletion,
  parseManifest,
  parsePolicy,
  sha256Hex,
  type BundleLayer,
  type FileRecord,
  type LayerManifest,
  type LayerName,
  type PackageDecl,
  type Platform,
  type Policy,
} from './schema.ts';

export const POLICY_PATH = 'manifests/inclusion.json';
export const COMPLETE_PATH = 'manifests/complete.json';
export const APPROVAL_PATH = 'manifests/inclusion-approval.json';
export const MANIFEST_NAME = 'manifest.json';

/** Directory of a bundle layer relative to the bundle root. */
export function layerDir(layer: BundleLayer): string {
  return layer === 'common' ? 'config/common' : `config/platforms/${layer.slice('platform:'.length)}`;
}

/** Payload path of a file record relative to its layer directory. */
export function payloadPath(f: { root: string; path: string }): string {
  return `files/${f.root}/${f.path}`;
}

export interface LoadedLayer {
  manifest: LayerManifest;
  manifestSha256: string;
  payloads: Map<string, Uint8Array>;
}

export interface LoadedBundle {
  policy: Policy;
  policySha256: string;
  completionSha256: string;
  common: LoadedLayer;
  platform: LoadedLayer;
}

function readPayloads(root: DirRoot, dir: string, m: LayerManifest): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const f of m.files) {
    const prefix = dir === '' ? '' : `${dir}/`;
    const bytes = readUnder(root, `${prefix}${payloadPath(f)}`, LIMITS.fileBytes);
    if (bytes.length !== f.bytes || sha256Hex(bytes) !== f.sha256) throw invalid('payload-digest-mismatch', m.layer);
    checkContent(f, bytes);
    out.set(fileKey(f), bytes);
  }
  return out;
}

function readLayer(root: DirRoot, dir: string, layer: LayerName, expectedSha?: string, withPayloads = true): LoadedLayer {
  const prefix = dir === '' ? '' : `${dir}/`;
  const bytes = readUnder(root, `${prefix}${MANIFEST_NAME}`, LIMITS.fileBytes);
  const sha = sha256Hex(bytes);
  if (expectedSha !== undefined && sha !== expectedSha) throw invalid('manifest-digest-mismatch', layer);
  const manifest = parseManifest(parseJsonBytes(bytes), layer);
  const payloads = withPayloads ? readPayloads(root, dir, manifest) : new Map<string, Uint8Array>();
  return { manifest, manifestSha256: sha, payloads };
}

function missingAs<T>(code: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ToolError && e.code === 'source-missing') throw invalid(code);
    throw e;
  }
}

/** Load and verify a complete bundle for one selected platform. */
export function loadBundle(root: DirRoot, platform: Platform): LoadedBundle {
  const markerBytes = missingAs('bundle-incomplete', () => readUnder(root, COMPLETE_PATH, LIMITS.fileBytes));
  const marker = parseCompletion(parseJsonBytes(markerBytes));
  const policyBytes = missingAs('bundle-invalid', () => readUnder(root, POLICY_PATH, LIMITS.fileBytes));
  const policySha256 = sha256Hex(policyBytes);
  if (policySha256 !== marker.policySha256) throw invalid('policy-digest-mismatch');
  const policy = parsePolicy(parseJsonBytes(policyBytes));
  const approvalBytes = missingAs('inclusion-approval-missing', () => readUnder(root, APPROVAL_PATH, LIMITS.fileBytes));
  if (sha256Hex(approvalBytes) !== marker.approvalSha256) throw invalid('inclusion-approval-digest-mismatch');
  const approval = parseApproval(parseJsonBytes(approvalBytes));
  const platformLayer: BundleLayer = `platform:${platform}`;
  // Every layer manifest is verified, so the approval record is checked against
  // the whole bundle; payloads are read only for the selected layers.
  const loaded = Object.create(null) as Record<BundleLayer, LoadedLayer>;
  for (const l of BUNDLE_LAYERS) {
    const withPayloads = l === 'common' || l === platformLayer;
    loaded[l] = missingAs('bundle-invalid', () => readLayer(root, layerDir(l), l, marker.layers[l], withPayloads));
    checkLayerAgainstPolicy(loaded[l].manifest, policy.layers[l]);
  }
  const manifests = Object.create(null) as Record<BundleLayer, LayerManifest>;
  for (const l of BUNDLE_LAYERS) manifests[l] = loaded[l].manifest;
  checkApprovalMatchesBundle(approval, policySha256, manifests);
  const common = loaded.common;
  const plat = loaded[platformLayer];
  let total = 0;
  for (const l of [common, plat]) for (const b of l.payloads.values()) total += b.length;
  if (total > LIMITS.totalBytes) throw invalid('bundle-too-large');
  return { policy, policySha256, completionSha256: sha256Hex(markerBytes), common, platform: plat };
}

/** Load and verify an optional machine overlay against the bundle's policy. */
export function loadOverlay(root: DirRoot, policy: Policy): LoadedLayer {
  const loaded = missingAs('overlay-invalid', () => readLayer(root, '', 'overlay'));
  checkOverlayAgainstPolicy(loaded.manifest, policy);
  return loaded;
}

export interface MergedFile {
  record: FileRecord;
  bytes: Uint8Array;
}

export interface Merged {
  settings: JsonObject;
  packages: PackageDecl[];
  files: MergedFile[];
}

/**
 * Merge common → platform → overlay. Settings replace whole top-level values
 * (omission inherits; empty arrays replace). Packages replace whole
 * declarations by identity at their first-seen position; the overlay may only
 * remove existing identities. Files replace by exact destination at their
 * first-seen position. Arrays are never sorted or deduplicated.
 */
export function mergeLayers(layers: LoadedLayer[]): Merged {
  const settings = Object.create(null) as JsonObject;
  const packages: PackageDecl[] = [];
  const files: MergedFile[] = [];
  for (const { manifest, payloads } of layers) {
    for (const k of Object.keys(manifest.settings)) settings[k] = manifest.settings[k];
    for (const d of manifest.packages) {
      const i = packages.findIndex((p) => packageIdentity(p) === packageIdentity(d));
      if (i >= 0) packages[i] = d;
      else packages.push(d);
    }
    for (const id of manifest.packagesRemove) {
      const i = packages.findIndex((p) => packageIdentity(p) === id);
      if (i < 0) throw invalid('overlay-remove-unknown', manifest.layer);
      packages.splice(i, 1);
    }
    for (const record of manifest.files) {
      const bytes = payloads.get(fileKey(record));
      if (!bytes) throw invalid('bundle-invalid', manifest.layer);
      const i = files.findIndex((f) => fileKey(f.record) === fileKey(record));
      if (i >= 0) {
        if (files[i].record.class !== record.class) throw invalid('class-mismatch', manifest.layer);
        files[i] = { record, bytes };
      } else files.push({ record, bytes });
    }
  }
  return { settings, packages, files };
}
