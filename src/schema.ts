/**
 * Strict schemas for the inclusion policy, layer manifests and completion
 * marker, plus the typed settings allowlist, npm package identity rules,
 * file destination classes and payload content checks.
 *
 * Every validator rejects unknown fields and returns fresh null-prototype
 * objects. Errors carry fixed codes only.
 */
import crypto from 'node:crypto';
import { invalid } from './errors.ts';
import { canonicalJson, decodeUtf8, isObject, parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';

export const TOOL_NAME = 'pi-machine-config';
export const TOOL_VERSION = '0.1.0';
export const TOOL_ID = `${TOOL_NAME}@${TOOL_VERSION}`;
export const SCHEMA_VERSION = 1;
/** Static Pi discovery model this release understands. */
export const DISCOVERY_MODEL = 'pi@1.5.2';
export const POLICY_KIND = 'pi-machine-config/inclusion';
export const COMPLETE_KIND = 'pi-machine-config/capture-complete';
/**
 * Built-in extensions Pi 1.5.2 accepts as `builtin:<name>` entries, and only
 * in the `extensions` setting (Pi docs settings.md "Resources").
 */
export const BUILTIN_EXTENSIONS: ReadonlySet<string> = new Set(['mcp', 'llama.cpp', 'codemode', 'tool-search']);
/** Built-in theme names Pi 1.5.2 ships (Pi docs themes.md). Custom names refer to theme files. */
export const BUILTIN_THEMES: ReadonlySet<string> = new Set(['system', 'dark', 'light']);

export const MIB = 1024 * 1024;
export const LIMITS = {
  fileBytes: MIB,
  layerBytes: 16 * MIB,
  totalBytes: 48 * MIB,
  pathDepth: 32,
  arrayItems: 4096,
  stringLength: 4096,
} as const;

export type Platform = 'darwin' | 'linux';
export const PLATFORMS: readonly Platform[] = ['darwin', 'linux'];
export type BundleLayer = 'common' | 'platform:darwin' | 'platform:linux';
export type LayerName = BundleLayer | 'overlay';
export const BUNDLE_LAYERS: readonly BundleLayer[] = ['common', 'platform:darwin', 'platform:linux'];

export type FileRoot = 'agent' | 'lens-config';
export type FileClass =
  | 'agent-context'
  | 'extension-source'
  | 'skill-source'
  | 'prompt'
  | 'theme'
  | 'tool-config'
  | 'external-config';
const FILE_CLASSES: readonly FileClass[] = [
  'agent-context',
  'extension-source',
  'skill-source',
  'prompt',
  'theme',
  'tool-config',
  'external-config',
];
/** Classes whose payload is JSON and is parsed strictly. */
export const JSON_CLASSES: ReadonlySet<FileClass> = new Set(['theme', 'tool-config', 'external-config']);
/** Classes that may carry `{{HOME}}`/`{{AGENT_DIR}}` template tokens. Never code or instruction source. */
const TEMPLATE_CLASSES: ReadonlySet<FileClass> = new Set(['agent-context', 'tool-config', 'external-config']);
const TOOL_CONFIG_PATHS = new Set(['keybindings.json', 'dev-kit/models.json', 'herdr-agents/config.json']);
const OVERLAY_TOOL_CONFIG_PATHS = new Set(['sandbox.json']);
/** Suffixes allowed for individually listed extension and skill source files. */
const SOURCE_SUFFIXES: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yaml', '.yml', '.py', '.sh'];
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TEMPLATE_TOKENS = ['HOME', 'AGENT_DIR'] as const;

export interface Expect {
  frontmatter: { [key: string]: boolean | string };
}

export interface FileRule {
  root: FileRoot;
  path: string;
  class: FileClass;
  template: boolean;
  expect?: Expect;
  /** Optional reviewed payload digest (64 lowercase hex) that capture must match. */
  sha256?: string;
}

export interface FileRecord {
  root: FileRoot;
  path: string;
  class: FileClass;
  bytes: number;
  sha256: string;
  template: boolean;
  expect?: Expect;
}

export type PackageObject = {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};
export type PackageDecl = string | PackageObject;

export interface PolicyLayer {
  settings: string[];
  packages: PackageDecl[];
  files: FileRule[];
}

export interface Policy {
  layers: Record<BundleLayer, PolicyLayer>;
  overlay: { files: FileRule[]; packagesRemove: string[] };
}

export interface LayerManifest {
  layer: LayerName;
  settings: JsonObject;
  packages: PackageDecl[];
  files: FileRecord[];
  packagesRemove: string[];
}

export interface CompletionMarker {
  tool: string;
  policySha256: string;
  /** Digest of `manifests/inclusion-approval.json`. */
  approvalSha256: string;
  layers: Record<BundleLayer, string>;
}

// ---------------------------------------------------------------- helpers

const SHA_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(data: Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function obj(): JsonObject {
  return Object.create(null) as JsonObject;
}

function requireObject(v: unknown, code: string): JsonObject {
  if (!isObject(v)) throw invalid(code);
  return v;
}

function checkKeys(o: JsonObject, required: readonly string[], optional: readonly string[], code: string): void {
  for (const k of required) if (!(k in o)) throw invalid(code);
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) throw invalid(code);
}

function requireArray(v: unknown, code: string): JsonValue[] {
  if (!Array.isArray(v) || v.length > LIMITS.arrayItems) throw invalid(code);
  return v;
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** A bounded single-line string without control characters or template tokens. */
function plainString(v: unknown, code: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.stringLength || hasControl(v) || v.includes('{{')) {
    throw invalid(code);
  }
  return v;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------- resource selections

/**
 * Validate one resource selection entry (settings resource arrays and package
 * filters). An optional single `+`, `-` or `!` prefix is preserved. The body
 * is a relative path without `..`, `~`, backslashes or template tokens, or,
 * only in the `extensions` setting (`context === 'extensions'`), one of the
 * reviewed `BUILTIN_EXTENSIONS` as `builtin:<name>` with no `!` prefix. Any
 * other `builtin:` value is refused rather than guessed. Absolute paths are
 * rejected here; capture converts approved source-agent absolute paths before
 * validation.
 */
export function resourceEntry(v: unknown, context: string, code = 'resource-entry-invalid'): string {
  const s = plainString(v, code);
  if (s.includes('\\')) throw invalid(code);
  const body = '+-!'.includes(s[0]) ? s.slice(1) : s;
  if (body.length === 0) throw invalid(code);
  if (body.startsWith('builtin:')) {
    const name = body.slice('builtin:'.length);
    if (context !== 'extensions' || s[0] === '!' || !BUILTIN_EXTENSIONS.has(name)) throw invalid('resource-builtin-unsupported');
    return s;
  }
  if (body.startsWith('/')) throw invalid('resource-path-absolute');
  if (body.startsWith('~')) throw invalid('resource-path-unsupported');
  if (body.split('/').some((c) => c === '..')) throw invalid('resource-path-traversal');
  return s;
}

/** Whether a resource entry activates a local path (positive, not builtin). */
export function isPositiveLocalEntry(s: string): boolean {
  if (s.startsWith('-') || s.startsWith('!')) return false;
  const body = s.startsWith('+') ? s.slice(1) : s;
  return !body.startsWith('builtin:');
}

function resourceArray(v: unknown, context: string, code: string): string[] {
  return requireArray(v, code).map((e) => resourceEntry(e, context));
}

// ---------------------------------------------------------------- settings

/** Pi 1.5.2 `defaultThinkingLevel` values (Pi docs settings.md). */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Pi 1.5.2 `tuiMode` values. */
const TUI_MODES = new Set(['regular', 'fullscreen']);

/**
 * Whether a validated `theme` setting names only built-in themes (`name` or
 * the automatic `light/dark` pair form). Custom names refer to theme files
 * this release cannot validate.
 */
export function isBuiltinThemeSetting(v: string): boolean {
  return v.split('/').every((n) => BUILTIN_THEMES.has(n));
}
const RESOURCE_SETTINGS = new Set(['extensions', 'skills', 'prompts', 'themes']);

/** Settings that load code, instructions or tools at startup. */
export const ACTIVATION_SETTINGS: ReadonlySet<string> = new Set(['defaultTools', 'extensions', 'skills', 'prompts', 'themes']);

export const SETTINGS_ALLOWLIST: readonly string[] = [
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'enabledModels',
  'modelThinkingLevels',
  'defaultTools',
  'theme',
  'tuiMode',
  'editorPaddingX',
  'fullscreenCopyOnSelect',
  'showCacheMissNotices',
  'extensions',
  'skills',
  'prompts',
  'themes',
];

export function isResourceSetting(key: string): boolean {
  return RESOURCE_SETTINGS.has(key);
}

/** Validate one allowlisted setting value and return a fresh copy. */
export function settingValue(key: string, v: unknown): JsonValue {
  const code = 'setting-invalid';
  switch (key) {
    case 'defaultProvider':
    case 'defaultModel':
      return plainString(v, code);
    case 'theme': {
      // One theme name, or `light/dark` for automatic mode; names never contain `/`.
      const s = plainString(v, code);
      const parts = s.split('/');
      if (parts.length > 2 || parts.some((p) => p.length === 0 || p.trim() !== p)) throw invalid(code);
      return s;
    }
    case 'tuiMode':
      if (typeof v !== 'string' || !TUI_MODES.has(v)) throw invalid(code);
      return v;
    case 'defaultThinkingLevel':
      if (typeof v !== 'string' || !THINKING_LEVELS.has(v)) throw invalid(code);
      return v;
    case 'enabledModels':
    case 'defaultTools':
      return requireArray(v, code).map((e) => plainString(e, code));
    case 'modelThinkingLevels': {
      const src = requireObject(v, code);
      const out = obj();
      const keys = Object.keys(src);
      if (keys.length > LIMITS.arrayItems) throw invalid(code);
      for (const k of keys) {
        plainString(k, code);
        const lvl = src[k];
        if (typeof lvl !== 'string' || !THINKING_LEVELS.has(lvl)) throw invalid(code);
        out[k] = lvl;
      }
      return out;
    }
    case 'editorPaddingX':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 3) throw invalid(code);
      return v;
    case 'fullscreenCopyOnSelect':
    case 'showCacheMissNotices':
      if (typeof v !== 'boolean') throw invalid(code);
      return v;
    case 'extensions':
    case 'skills':
    case 'prompts':
    case 'themes':
      return resourceArray(v, key, code);
    default:
      throw invalid('setting-not-allowed');
  }
}

function settingsObject(v: unknown): JsonObject {
  const src = requireObject(v, 'manifest-invalid');
  const out = obj();
  for (const k of Object.keys(src)) {
    if (!SETTINGS_ALLOWLIST.includes(k)) throw invalid('setting-not-allowed');
    out[k] = settingValue(k, src[k]);
  }
  return out;
}

// ---------------------------------------------------------------- npm packages

const NPM_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const NPM_SUFFIX = /^[A-Za-z0-9._+-]+$/;
const PACKAGE_KEYS = ['source', 'autoload', 'extensions', 'skills', 'prompts', 'themes'] as const;

/**
 * Parse a registry-only npm source. Returns the unversioned identity
 * `npm:<name>`. A conservative version/tag suffix is accepted only when
 * `allowSuffix` is true (capture input) and is removed.
 */
export function npmIdentity(source: unknown, allowSuffix: boolean): string {
  if (typeof source !== 'string' || !source.startsWith('npm:') || source.length > 300) throw invalid('package-unsupported');
  const rest = source.slice(4);
  let scope: string | null = null;
  let tail = rest;
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/');
    if (slash < 0) throw invalid('package-unsupported');
    scope = rest.slice(1, slash);
    tail = rest.slice(slash + 1);
  }
  const at = tail.lastIndexOf('@');
  let name = tail;
  if (at >= 0) {
    name = tail.slice(0, at);
    const suffix = tail.slice(at + 1);
    if (!NPM_SUFFIX.test(suffix)) throw invalid('package-unsupported');
    if (!allowSuffix) throw invalid('package-versioned');
  }
  if (!NPM_SEGMENT.test(name) || (scope !== null && !NPM_SEGMENT.test(scope))) throw invalid('package-unsupported');
  const full = scope === null ? name : `@${scope}/${name}`;
  if (full.length > 214) throw invalid('package-unsupported');
  return `npm:${full}`;
}

/** Identity of an already-validated declaration. */
export function packageIdentity(d: PackageDecl): string {
  return typeof d === 'string' ? d : d.source;
}

/**
 * Validate a package declaration, preserving string/object form, key presence
 * and filter order. With `allowSuffix`, the source is normalized to its
 * unversioned identity.
 */
export function packageDecl(v: unknown, allowSuffix: boolean): PackageDecl {
  if (typeof v === 'string') return npmIdentity(v, allowSuffix);
  const src = requireObject(v, 'package-unsupported');
  checkKeys(src, ['source'], PACKAGE_KEYS, 'package-unsupported');
  const out = Object.create(null) as PackageObject;
  out.source = npmIdentity(src.source, allowSuffix);
  if ('autoload' in src) {
    if (typeof src.autoload !== 'boolean') throw invalid('package-unsupported');
    out.autoload = src.autoload;
  }
  for (const k of ['extensions', 'skills', 'prompts', 'themes'] as const) {
    if (k in src) out[k] = requireArray(src[k], 'package-filter-invalid').map((e) => resourceEntry(e, 'package-filter', 'package-filter-invalid'));
  }
  return out;
}

function packageList(v: unknown, code: string): PackageDecl[] {
  const out: PackageDecl[] = [];
  const seen = new Set<string>();
  for (const e of requireArray(v, code)) {
    const d = packageDecl(e, false);
    const id = packageIdentity(d);
    if (seen.has(id)) throw invalid('package-duplicate');
    seen.add(id);
    out.push(d);
  }
  return out;
}

function identityList(v: unknown, code: string): string[] {
  const out: string[] = [];
  for (const e of requireArray(v, code)) {
    const id = npmIdentity(e, false);
    if (out.includes(id)) throw invalid('package-duplicate');
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- file paths and classes

/**
 * Validate a payload-relative path's syntax: NFC, forward slashes, no empty,
 * `.`/`..` or dot-prefixed components, no control characters, backslashes,
 * colons (drive/UNC prefixes), dependency directories or log files.
 */
export function relPath(p: unknown): string {
  const code = 'path-invalid';
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024 || hasControl(p)) throw invalid(code);
  if (p !== p.normalize('NFC') || p.includes('\\') || p.includes(':') || p.startsWith('/')) throw invalid(code);
  const parts = p.split('/');
  if (parts.length > LIMITS.pathDepth) throw invalid(code);
  for (const c of parts) {
    if (c.length === 0 || c.startsWith('.') || c.length > 255) throw invalid(code);
    if (c.toLowerCase() === 'node_modules') throw invalid(code);
  }
  if (parts[parts.length - 1].toLowerCase().endsWith('.log')) throw invalid(code);
  return p;
}

/**
 * Reserved agent files that a file record may name only at one exact
 * destination with one class; everywhere else their basename is prohibited.
 */
const EXACT_EXCEPTIONS: ReadonlyMap<string, FileClass> = new Map([
  ['AGENTS.md', 'agent-context'],
  ['keybindings.json', 'tool-config'],
  ['dev-kit/models.json', 'tool-config'],
  ['sandbox.json', 'tool-config'],
]);

/**
 * Basenames (compared case-insensitively) that never name a file record:
 * settings, credentials and trust, MCP and root model definitions, context
 * files and their variants, system prompts, reserved tool files outside their
 * exact destination, and dependency lock files.
 */
const PROHIBITED_BASENAMES: ReadonlySet<string> = new Set([
  'settings.json',
  'auth.json',
  'trust.json',
  'mcp.json',
  'models.json',
  'keybindings.json',
  'sandbox.json',
  'agents.md',
  'claude.md',
  'system.md',
  'append_system.md',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
]);

const PROHIBITED_BASENAME_PATTERNS: readonly RegExp[] = [
  // Context files and variants such as AGENTS.override.md or CLAUDE.local.md; system prompts.
  /^(agents|claude|system|append_system)(\.[^/]*)?\.md$/i,
  // Credential, trust and MCP variants.
  /^(auth|trust|mcp)([._-][^/]*)?\.json$/i,
  /^(credentials?|secrets?)([._-][^/]*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  // Locks, logs, sessions and other runtime state.
  /\.(lock|lockb|lck|pid|sock|log|jsonl|sqlite|sqlite3|db)$/i,
  /\.log\.[0-9]+$/i,
  // Binaries.
  /\.(node|so|dylib|dll|exe|wasm|bin)$/i,
];

/** Path components (case-insensitive) that mark dependency, runtime, log or binary directories. */
const PROHIBITED_COMPONENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  '__pycache__',
  'venv',
  'site-packages',
  'bin',
  'sessions',
  'session',
  'cache',
  'caches',
  'logs',
  'log',
  'tmp',
  'temp',
  'locks',
  'run',
  'trash',
]);

/**
 * Refuse prohibited destinations independently of the declared class, so a
 * class label can never authorize reading a credential, settings, runtime,
 * dependency, log, lock or binary path. Runs during policy and manifest
 * validation, before any source or payload file is opened.
 */
export function checkProhibited(root: FileRoot, p: string, cls: FileClass): void {
  if (root === 'lens-config') return;
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  for (const c of parts.slice(0, -1)) if (PROHIBITED_COMPONENTS.has(c.toLowerCase())) throw invalid('path-prohibited');
  if (PROHIBITED_COMPONENTS.has(base.toLowerCase())) throw invalid('path-prohibited');
  // Reserved `.pi-machine-config*` names are dot-prefixed and already refused by relPath.
  const exception = EXACT_EXCEPTIONS.get(p);
  if (exception !== undefined && exception === cls) return;
  if (PROHIBITED_BASENAMES.has(base.toLowerCase())) throw invalid('path-prohibited');
  if (PROHIBITED_BASENAME_PATTERNS.some((re) => re.test(base))) throw invalid('path-prohibited');
}

/** Check that a (root, path, class) triple is an approved destination for the layer. */
export function checkPlacement(root: FileRoot, p: string, cls: FileClass, layer: LayerName): void {
  const parts = p.split('/');
  let ok = false;
  if (root === 'lens-config') {
    ok = cls === 'external-config' && p === 'config.json';
  } else if (layer === 'overlay') {
    ok = cls === 'tool-config' && OVERLAY_TOOL_CONFIG_PATHS.has(p);
  } else {
    switch (cls) {
      case 'agent-context':
        ok = p === 'AGENTS.md';
        break;
      case 'extension-source':
        ok = parts[0] === 'extensions' && parts.length >= 2 && sourceFile(parts.slice(1));
        break;
      case 'skill-source':
        ok = parts[0] === 'skills' && parts.length >= 3 && sourceFile(parts.slice(1));
        break;
      case 'prompt':
        ok = parts.length === 2 && parts[0] === 'prompts' && parts[1].endsWith('.md') && parts[1].length > 3;
        break;
      case 'theme':
        ok = parts.length === 2 && parts[0] === 'themes' && parts[1].endsWith('.json') && parts[1].length > 5;
        break;
      case 'tool-config':
        ok = TOOL_CONFIG_PATHS.has(p);
        break;
      default:
        ok = false;
    }
  }
  if (!ok) throw invalid('destination-not-allowed');
}

/** Extension/skill source: simple component names and an allowed text source suffix. */
function sourceFile(parts: string[]): boolean {
  if (!parts.every((c) => SOURCE_NAME.test(c))) return false;
  const base = parts[parts.length - 1].toLowerCase();
  return SOURCE_SUFFIXES.some((s) => base.endsWith(s) && base.length > s.length);
}

function fileRoot(v: unknown): FileRoot {
  if (v !== 'agent' && v !== 'lens-config') throw invalid('destination-not-allowed');
  return v;
}

function fileClass(v: unknown): FileClass {
  if (typeof v !== 'string' || !FILE_CLASSES.includes(v as FileClass)) throw invalid('destination-not-allowed');
  return v as FileClass;
}

function expectValue(v: unknown): Expect {
  const src = requireObject(v, 'expect-invalid');
  checkKeys(src, ['frontmatter'], [], 'expect-invalid');
  const fm = requireObject(src.frontmatter, 'expect-invalid');
  const keys = Object.keys(fm);
  if (keys.length === 0 || keys.length > 64) throw invalid('expect-invalid');
  const out = Object.create(null) as Expect['frontmatter'];
  for (const k of keys) {
    if (!FRONTMATTER_KEY.test(k)) throw invalid('expect-invalid');
    const val = fm[k];
    if (typeof val === 'boolean') out[k] = val;
    else out[k] = plainString(val, 'expect-invalid');
  }
  return { frontmatter: out };
}

function fileCommon(src: JsonObject, layer: LayerName): FileRule {
  const root = fileRoot(src.root);
  const p = relPath(src.path);
  const cls = fileClass(src.class);
  checkProhibited(root, p, cls);
  checkPlacement(root, p, cls, layer);
  if (typeof src.template !== 'boolean') throw invalid('file-rule-invalid');
  if (src.template && !TEMPLATE_CLASSES.has(cls)) throw invalid('template-not-allowed');
  const out: FileRule = { root, path: p, class: cls, template: src.template };
  if ('expect' in src) out.expect = expectValue(src.expect);
  return out;
}

function fileRule(v: unknown, layer: LayerName): FileRule {
  const src = requireObject(v, 'file-rule-invalid');
  checkKeys(src, ['root', 'path', 'class', 'template'], ['expect', 'sha256'], 'file-rule-invalid');
  const out = fileCommon(src, layer);
  if ('sha256' in src) {
    if (typeof src.sha256 !== 'string' || !SHA_RE.test(src.sha256)) throw invalid('file-rule-invalid');
    out.sha256 = src.sha256;
  }
  return out;
}

function fileRecord(v: unknown, layer: LayerName): FileRecord {
  const src = requireObject(v, 'manifest-invalid');
  checkKeys(src, ['root', 'path', 'class', 'bytes', 'sha256', 'template'], ['expect'], 'manifest-invalid');
  const base = fileCommon(src, layer);
  if (typeof src.bytes !== 'number' || !Number.isSafeInteger(src.bytes) || src.bytes < 0 || src.bytes > LIMITS.fileBytes) {
    throw invalid('manifest-invalid');
  }
  if (typeof src.sha256 !== 'string' || !SHA_RE.test(src.sha256)) throw invalid('manifest-invalid');
  const out: FileRecord = { root: base.root, path: base.path, class: base.class, bytes: src.bytes, sha256: src.sha256, template: base.template };
  if (base.expect) out.expect = base.expect;
  return out;
}

export function fileKey(f: { root: FileRoot; path: string }): string {
  return `${f.root}:${f.path}`;
}

/** Reject case/normalization aliases among file destinations (exact duplicates handled by caller). */
function checkAliases(files: { root: FileRoot; path: string }[], allowExactRepeat: boolean): void {
  const seen = new Map<string, string>();
  for (const f of files) {
    const k = fileKey(f);
    const folded = k.normalize('NFC').toLowerCase();
    const prev = seen.get(folded);
    if (prev !== undefined) {
      if (prev !== k) throw invalid('path-alias');
      if (!allowExactRepeat) throw invalid('file-duplicate');
    }
    seen.set(folded, k);
  }
}

// ---------------------------------------------------------------- policy

function policyLayer(v: unknown, layer: BundleLayer): PolicyLayer {
  const src = requireObject(v, 'policy-invalid');
  checkKeys(src, [], ['settings', 'packages', 'files'], 'policy-invalid');
  const settings: string[] = [];
  for (const k of requireArray(src.settings ?? [], 'policy-invalid')) {
    if (typeof k !== 'string' || !SETTINGS_ALLOWLIST.includes(k)) throw invalid('setting-not-allowed');
    if (settings.includes(k)) throw invalid('policy-invalid');
    settings.push(k);
  }
  const packages = packageList(src.packages ?? [], 'policy-invalid');
  const files = requireArray(src.files ?? [], 'policy-invalid').map((f) => fileRule(f, layer));
  checkAliases(files, false);
  return { settings, packages, files };
}

/** Validate a parsed inclusion policy. */
export function parsePolicy(v: unknown): Policy {
  const src = requireObject(v, 'policy-invalid');
  checkKeys(src, ['schemaVersion', 'kind', 'layers'], ['overlay'], 'policy-invalid');
  if (src.schemaVersion !== SCHEMA_VERSION) throw invalid('schema-version-unsupported');
  if (src.kind !== POLICY_KIND) throw invalid('policy-invalid');
  const layersSrc = requireObject(src.layers, 'policy-invalid');
  checkKeys(layersSrc, [], BUNDLE_LAYERS, 'policy-invalid');
  const layers = Object.create(null) as Record<BundleLayer, PolicyLayer>;
  for (const l of BUNDLE_LAYERS) layers[l] = policyLayer(layersSrc[l] ?? obj(), l);
  const ov = requireObject(src.overlay ?? obj(), 'policy-invalid');
  checkKeys(ov, [], ['files', 'packagesRemove'], 'policy-invalid');
  const ovFiles = requireArray(ov.files ?? [], 'policy-invalid').map((f) => fileRule(f, 'overlay'));
  checkAliases(ovFiles, false);
  const packagesRemove = identityList(ov.packagesRemove ?? [], 'policy-invalid');
  // Across layers the same destination must be spelled identically and keep its class.
  const all = [...BUNDLE_LAYERS.flatMap((l) => layers[l].files), ...ovFiles];
  checkAliases(all, true);
  const classes = new Map<string, FileClass>();
  for (const f of all) {
    const prev = classes.get(fileKey(f));
    if (prev !== undefined && prev !== f.class) throw invalid('class-mismatch');
    classes.set(fileKey(f), f.class);
  }
  return { layers, overlay: { files: ovFiles, packagesRemove } };
}

// ---------------------------------------------------------------- layer manifests

/** Validate a parsed layer manifest for the expected layer. */
export function parseManifest(v: unknown, layer: LayerName): LayerManifest {
  const src = requireObject(v, 'manifest-invalid');
  const optional = layer === 'overlay' ? ['packagesRemove'] : [];
  checkKeys(src, ['schemaVersion', 'layer', 'piDiscoveryModel', 'settings', 'packages', 'files'], optional, 'manifest-invalid');
  if (src.schemaVersion !== SCHEMA_VERSION) throw invalid('schema-version-unsupported', layer);
  if (src.layer !== layer) throw invalid('manifest-layer-mismatch', layer);
  if (src.piDiscoveryModel !== DISCOVERY_MODEL) throw invalid('discovery-model-unsupported', layer);
  const settings = settingsObject(src.settings);
  const packages = packageList(src.packages, 'manifest-invalid');
  const files = requireArray(src.files, 'manifest-invalid').map((f) => fileRecord(f, layer));
  checkAliases(files, false);
  let total = 0;
  for (const f of files) total += f.bytes;
  if (total > LIMITS.layerBytes) throw invalid('layer-too-large', layer);
  const packagesRemove = layer === 'overlay' ? identityList(src.packagesRemove ?? [], 'manifest-invalid') : [];
  if (layer === 'overlay') {
    if (Object.keys(settings).length > 0) throw invalid('overlay-setting-not-allowed', layer);
    if (packages.length > 0) throw invalid('overlay-package-not-allowed', layer);
  }
  return { layer, settings, packages, files, packagesRemove };
}

/** Serializable manifest document for writing. */
export function manifestDocument(m: LayerManifest): JsonObject {
  const doc = obj();
  doc.schemaVersion = SCHEMA_VERSION;
  doc.layer = m.layer;
  doc.piDiscoveryModel = DISCOVERY_MODEL;
  doc.settings = m.settings;
  doc.packages = m.packages as JsonValue[];
  // SAFETY: FileRecord holds only JSON scalars and the validated Expect object, so it is a JsonValue.
  doc.files = m.files as unknown as JsonValue[];
  if (m.layer === 'overlay') doc.packagesRemove = m.packagesRemove;
  return doc;
}

function ruleMatchesRecord(rule: FileRule, rec: FileRecord): boolean {
  if (rule.class !== rec.class || rule.template !== rec.template) return false;
  if (!sameJson(rule.expect ?? null, rec.expect ?? null)) return false;
  if (rule.sha256 !== undefined && rule.sha256 !== rec.sha256) return false;
  return true;
}

/**
 * A common/platform manifest must hold exactly the policy's settings keys,
 * package declarations and file rules for that layer.
 */
export function checkLayerAgainstPolicy(m: LayerManifest, rules: PolicyLayer): void {
  const layer = m.layer;
  const keys = Object.keys(m.settings).sort();
  if (!sameJson(keys, [...rules.settings].sort())) throw invalid('policy-mismatch', layer);
  if (m.packages.length !== rules.packages.length) throw invalid('policy-mismatch', layer);
  for (const d of m.packages) {
    const rule = rules.packages.find((r) => packageIdentity(r) === packageIdentity(d));
    if (!rule || !sameJson(rule, d)) throw invalid('policy-mismatch', layer);
  }
  if (m.files.length !== rules.files.length) throw invalid('policy-mismatch', layer);
  for (const rec of m.files) {
    const rule = rules.files.find((r) => fileKey(r) === fileKey(rec));
    if (!rule || !ruleMatchesRecord(rule, rec)) throw invalid('policy-mismatch', layer);
  }
}

/** An overlay manifest may hold only individually approved overlay files and removals. */
export function checkOverlayAgainstPolicy(m: LayerManifest, policy: Policy): void {
  for (const rec of m.files) {
    const rule = policy.overlay.files.find((r) => fileKey(r) === fileKey(rec));
    if (!rule || !ruleMatchesRecord(rule, rec)) throw invalid('policy-mismatch', 'overlay');
  }
  for (const id of m.packagesRemove) {
    if (!policy.overlay.packagesRemove.includes(id)) throw invalid('policy-mismatch', 'overlay');
  }
}

// ---------------------------------------------------------------- completion marker

export function parseCompletion(v: unknown): CompletionMarker {
  const src = requireObject(v, 'completion-invalid');
  checkKeys(src, ['schemaVersion', 'kind', 'tool', 'policySha256', 'approvalSha256', 'layers'], [], 'completion-invalid');
  if (src.schemaVersion !== SCHEMA_VERSION) throw invalid('schema-version-unsupported');
  if (src.kind !== COMPLETE_KIND) throw invalid('completion-invalid');
  if (typeof src.tool !== 'string' || !/^pi-machine-config@[0-9A-Za-z.+-]{1,64}$/.test(src.tool)) throw invalid('completion-invalid');
  if (typeof src.policySha256 !== 'string' || !SHA_RE.test(src.policySha256)) throw invalid('completion-invalid');
  if (typeof src.approvalSha256 !== 'string' || !SHA_RE.test(src.approvalSha256)) throw invalid('completion-invalid');
  const ls = requireObject(src.layers, 'completion-invalid');
  checkKeys(ls, BUNDLE_LAYERS, [], 'completion-invalid');
  const layers = Object.create(null) as Record<BundleLayer, string>;
  for (const l of BUNDLE_LAYERS) {
    const h = ls[l];
    if (typeof h !== 'string' || !SHA_RE.test(h)) throw invalid('completion-invalid');
    layers[l] = h;
  }
  return { tool: src.tool, policySha256: src.policySha256, approvalSha256: src.approvalSha256, layers };
}

export function completionDocument(policySha: string, approvalSha: string, layers: Record<BundleLayer, string>): JsonObject {
  const doc = obj();
  doc.schemaVersion = SCHEMA_VERSION;
  doc.kind = COMPLETE_KIND;
  doc.tool = TOOL_ID;
  doc.policySha256 = policySha;
  doc.approvalSha256 = approvalSha;
  const l = obj();
  for (const k of BUNDLE_LAYERS) l[k] = layers[k];
  doc.layers = l;
  return doc;
}

// ---------------------------------------------------------------- payload content

const FRONTMATTER_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FRONTMATTER_MAX_LINES = 256;
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

/**
 * Bounded, fail-closed frontmatter reader. Supports only top-level
 * `key: value` lines; values of other keys may use block scalars or nested
 * blocks as indented continuation lines, which are skipped. Expected keys must
 * be plain single-line scalars: `true`/`false` become booleans, and plain or
 * simply quoted text becomes a string. Anything else is unsupported.
 */
export function checkFrontmatter(text: string, expect: Expect): void {
  const fail = (): never => {
    throw invalid('frontmatter-unsupported');
  };
  if (!text.startsWith('---\n')) fail();
  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length && i <= FRONTMATTER_MAX_LINES; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) fail();
  const values = new Map<string, string | null>();
  let continuationAllowed = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.includes('\r') || line.includes('\t')) fail();
    if (line.length === 0) continue;
    if (line.startsWith(' ')) {
      if (!continuationAllowed) fail();
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]{0,63}):(?: (.*))?$/.exec(line);
    if (!m) return fail();
    const key = m[1];
    if (values.has(key)) fail();
    const raw = (m[2] ?? '').trim();
    if (raw === '' || /^[|>][+-]?$/.test(raw)) {
      values.set(key, null);
      continuationAllowed = true;
    } else {
      values.set(key, raw);
      continuationAllowed = false;
      // A plain scalar followed by indented lines would continue it; refuse.
      if (lines[i + 1]?.startsWith(' ')) fail();
    }
  }
  for (const [key, want] of Object.entries(expect.frontmatter)) {
    const raw = values.get(key);
    if (raw === undefined || raw === null) throw invalid('expectation-failed');
    let got: boolean | string;
    if (raw === 'true') got = true;
    else if (raw === 'false') got = false;
    else if (/^"[^"\\]*"$/.test(raw) || /^'[^']*'$/.test(raw)) got = raw.slice(1, -1);
    else if (/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(raw) && !raw.includes(' #')) got = raw;
    else return fail();
    if (got !== want) throw invalid('expectation-failed');
  }
}

/**
 * Validate payload bytes for a file rule/record: strict UTF-8, no NUL, strict
 * JSON for JSON classes, approved template tokens only, and structural
 * expectations. Returns the decoded text.
 */
export function checkContent(f: { class: FileClass; template: boolean; expect?: Expect }, bytes: Uint8Array): string {
  if (bytes.length > LIMITS.fileBytes) throw invalid('file-too-large');
  const text = decodeUtf8(bytes, 'content-invalid');
  if (text.includes('\0')) throw invalid('content-invalid');
  if (JSON_CLASSES.has(f.class)) parseJsonBytes(bytes);
  // A trial render with neutral values applies the same syntax and
  // no-unresolved-token checks that plan applies with the real values.
  if (f.template) renderTemplate(f.class, text, { HOME: '/home', AGENT_DIR: '/agent' });
  if (f.expect) checkFrontmatter(text, f.expect);
  return text;
}

const VALID_TOKEN_RE = /\{\{(?:HOME|AGENT_DIR)\}\}/g;

/**
 * Refuse template syntax that is not exactly one approved token: unknown
 * names, unclosed openings, stray closings, nesting and braces adjacent to a
 * token. After approved tokens are blanked out, no `{{`, `}}`, `{<token>` or
 * `<token>}` may remain.
 */
function checkTemplateText(s: string): void {
  // NUL cannot occur in a payload, so it is a safe stand-in for a valid token.
  const blanked = s.replace(VALID_TOKEN_RE, '\0');
  if (/\{\{|\}\}|\{\0|\0\}/.test(blanked)) throw invalid('template-unresolved');
}

function eachJsonString(v: JsonValue, fn: (s: string) => void): void {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) for (const e of v) eachJsonString(e, fn);
  else if (isObject(v)) {
    for (const k of Object.keys(v)) {
      fn(k);
      eachJsonString(v[k], fn);
    }
  }
}

/**
 * Template syntax check. Every raw `{{...}}` must name an approved token. Text
 * classes are checked as a whole; JSON classes, whose structural `}}` is
 * ordinary syntax, are checked inside every decoded string (keys and values),
 * which is the only place a token can occur in valid JSON.
 */
function checkTemplateSyntax(text: string, parsed: JsonValue | undefined): void {
  for (const m of text.matchAll(TOKEN_RE)) {
    if (!(TEMPLATE_TOKENS as readonly string[]).includes(m[1])) throw invalid('template-unresolved');
  }
  if (parsed === undefined) checkTemplateText(text);
  else eachJsonString(parsed, checkTemplateText);
}

/** After rendering, no template syntax may remain (including tokens hidden behind JSON escapes). */
function checkRendered(json: boolean, out: string, bytes: Uint8Array): void {
  const unresolved = (s: string): void => {
    if (s.includes('{{') || s.includes('}}')) throw invalid('template-unresolved');
  };
  if (json) eachJsonString(parseJsonBytes(bytes), unresolved);
  else unresolved(out);
}

/**
 * Render a template payload. Text classes substitute tokens literally; JSON
 * classes substitute JSON-string-escaped values and are re-parsed strictly.
 * No shell expansion or other evaluation happens.
 */
export function renderTemplate(cls: FileClass, text: string, values: { HOME: string; AGENT_DIR: string }): Uint8Array {
  const json = JSON_CLASSES.has(cls);
  checkTemplateSyntax(text, json ? parseJsonBytes(new TextEncoder().encode(text)) : undefined);
  const out = text.replace(TOKEN_RE, (_m, name: string) => {
    if (name !== 'HOME' && name !== 'AGENT_DIR') throw invalid('template-unresolved');
    const v = values[name];
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
  const bytes = new TextEncoder().encode(out);
  if (bytes.length > LIMITS.fileBytes) throw invalid('file-too-large');
  checkRendered(json, out, bytes);
  return bytes;
}
