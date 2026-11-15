/**
 * Recorded inclusion approval for capture.
 *
 * `capture-review` computes the capture-review token over a review descriptor:
 * the tool and discovery model, the source platform, the SHA-256 of the exact
 * policy bytes, and every layer manifest as capture would write it (projected
 * settings, ordered package declarations, and each selected payload's root,
 * path, class, template flag, expectation, size and digest). `capture
 * --approve-inclusion <token>` recomputes the descriptor before creating any
 * output and refuses a mismatch; the bundle then records the supplied token
 * and the descriptor in `manifests/inclusion-approval.json`, whose digest the
 * completion marker binds. Consumers recompute the token from the recorded
 * descriptor and compare the descriptor with the bundle's own manifests.
 *
 * Token: `sha256:<hex>` over `CAPTURE_TOKEN_DOMAIN`, a NUL byte, and the
 * canonical JSON of the descriptor. The record is explicit caller consent for
 * this exact intent. It is not a signature and does not authenticate anyone:
 * anyone able to rewrite a bundle can rewrite a consistent record.
 */
import { invalid } from './errors.ts';
import { canonicalJson, isObject, type JsonObject } from './json.ts';
import {
  BUNDLE_LAYERS,
  DISCOVERY_MODEL,
  PLATFORMS,
  SCHEMA_VERSION,
  TOOL_ID,
  manifestDocument,
  parseManifest,
  sha256Hex,
  type BundleLayer,
  type LayerManifest,
  type Platform,
} from './schema.ts';

export const CAPTURE_TOKEN_DOMAIN = 'pi-machine-config/capture-review-token/v1';
export const APPROVAL_KIND = 'pi-machine-config/inclusion-approval';

const TOKEN_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Whether a string has the approval-token syntax `sha256:<64 lowercase hex>`. */
export function isTokenSyntax(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export interface ReviewInput {
  platform: Platform;
  policySha256: string;
  manifests: Record<BundleLayer, LayerManifest>;
  /** Tool identity recorded in the descriptor; defaults to this tool. */
  tool?: string;
}

/** The reviewed capture intent the capture-review token covers. */
export function reviewDescriptor(r: ReviewInput): JsonObject {
  const doc = Object.create(null) as JsonObject;
  doc.tool = r.tool ?? TOOL_ID;
  doc.discoveryModel = DISCOVERY_MODEL;
  doc.platform = r.platform;
  doc.policySha256 = r.policySha256;
  const layers = Object.create(null) as JsonObject;
  for (const l of BUNDLE_LAYERS) layers[l] = manifestDocument(r.manifests[l]);
  doc.layers = layers;
  return doc;
}

export function captureToken(descriptor: JsonObject): string {
  const body = Buffer.concat([
    Buffer.from(CAPTURE_TOKEN_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalJson(descriptor), 'utf8'),
  ]);
  return `sha256:${sha256Hex(body)}`;
}

/** Serializable `manifests/inclusion-approval.json` document. */
export function approvalDocument(token: string, descriptor: JsonObject): JsonObject {
  const doc = Object.create(null) as JsonObject;
  doc.schemaVersion = SCHEMA_VERSION;
  doc.kind = APPROVAL_KIND;
  doc.approvalToken = token;
  doc.intent = descriptor;
  return doc;
}

export interface ApprovalRecord {
  token: string;
  platform: Platform;
  policySha256: string;
  tool: string;
  descriptor: JsonObject;
}

function bad(): never {
  throw invalid('inclusion-approval-invalid');
}

function exactKeys(o: JsonObject, keys: readonly string[]): void {
  const got = Object.keys(o);
  if (got.length !== keys.length || !keys.every((k) => k in o)) bad();
}

/**
 * Validate a parsed approval record: strict shape, a valid descriptor whose
 * layer manifests pass the strict manifest validator, and a token that equals
 * the recomputed token of the recorded descriptor.
 */
export function parseApproval(v: unknown): ApprovalRecord {
  if (!isObject(v)) bad();
  exactKeys(v, ['schemaVersion', 'kind', 'approvalToken', 'intent']);
  if (v.schemaVersion !== SCHEMA_VERSION || v.kind !== APPROVAL_KIND || !isTokenSyntax(v.approvalToken)) bad();
  const intent = v.intent;
  if (!isObject(intent)) bad();
  exactKeys(intent, ['tool', 'discoveryModel', 'platform', 'policySha256', 'layers']);
  const { tool, platform, policySha256, layers } = intent;
  if (typeof tool !== 'string' || !/^pi-machine-config@[0-9A-Za-z.+-]{1,64}$/.test(tool)) bad();
  if (intent.discoveryModel !== DISCOVERY_MODEL) bad();
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) bad();
  if (typeof policySha256 !== 'string' || !SHA_RE.test(policySha256)) bad();
  if (!isObject(layers)) bad();
  exactKeys(layers, BUNDLE_LAYERS);
  const manifests = Object.create(null) as Record<BundleLayer, LayerManifest>;
  for (const l of BUNDLE_LAYERS) manifests[l] = parseManifest(layers[l], l);
  const descriptor = reviewDescriptor({ platform: platform as Platform, policySha256, manifests, tool });
  // The recorded descriptor must be exactly what the validator reproduces, and its token must match.
  if (canonicalJson(descriptor) !== canonicalJson(intent)) bad();
  if (captureToken(descriptor) !== v.approvalToken) bad();
  return { token: v.approvalToken, platform: platform as Platform, policySha256, tool, descriptor };
}

/**
 * Require that a validated approval record describes exactly this bundle's
 * policy bytes and all three layer manifests.
 */
export function checkApprovalMatchesBundle(
  record: ApprovalRecord,
  policySha256: string,
  manifests: Record<BundleLayer, LayerManifest>,
): void {
  const expected = reviewDescriptor({ platform: record.platform, policySha256, manifests, tool: record.tool });
  if (canonicalJson(expected) !== canonicalJson(record.descriptor)) throw invalid('inclusion-approval-bundle-mismatch');
}
