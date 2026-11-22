/** Offline diagnostic for the closed pi-dev-kit 6.0.0 models schema subset. */
import { invalid, ToolError } from './errors.ts';
import { decodeUtf8, isObject, parseJsonBytes, type JsonValue } from './json.ts';
import { LIMITS } from './schema.ts';

const slots = ['architect', 'developer', 'reviewer', 'qa', 'researcher', 'reviewer-alternate'] as const;
const profileNames = ['work', 'private'] as const;
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const triggerPattern = /^[\x20-\x7e]{0,256}$/;
type Model = { model: string; thinking: string };
type Upgrade = Model & { when: string };
type Row = Model & { upgrade?: Upgrade };
type Profile = { providers: string[]; roles: Row[] };
type Report = { status: 'recognized' } | { status: 'invalid'; reason: 'json' | 'shape' | 'value' | 'rule' } |
  { status: 'unsupported'; reason: 'limit' | 'version' | 'syntax' };

function hasKeys(value: Record<string, JsonValue>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function readProfile(value: JsonValue): Profile | undefined {
  if (!isObject(value) || !hasKeys(value, ['providers', 'roles'])) return;
  const { providers, roles } = value;
  if (!Array.isArray(providers) || !providers.every(p => typeof p === 'string') ||
      !isObject(roles) || !hasKeys(roles, slots)) return;
  const rows: Row[] = [];
  for (const slot of slots) {
    const row = roles[slot];
    if (!isObject(row) || !hasKeys(row, ['model', 'thinking'], ['upgrade']) ||
        typeof row.model !== 'string' || typeof row.thinking !== 'string') return;
    const out: Row = { model: row.model, thinking: row.thinking };
    if (Object.hasOwn(row, 'upgrade')) {
      const up = row.upgrade;
      if (!isObject(up) || !hasKeys(up, ['when', 'model', 'thinking']) ||
          typeof up.when !== 'string' || typeof up.model !== 'string' || typeof up.thinking !== 'string') return;
      out.upgrade = { when: up.when, model: up.model, thinking: up.thinking };
    }
    rows.push(out);
  }
  return { providers, roles: rows };
}

/** Closed shape leaves only the version number outside JSON strings. */
function hasIntegerVersion(text: string): boolean {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && !/[{},:\[\] \t\r\n]/.test(c)) {
      return c === '1' && /[,} \t\r\n]/.test(text[i + 1]);
    }
  }
  return false;
}

function modelSpelling(model: string): boolean {
  if (model.length > 256) return false;
  const [provider, ...segments] = model.split('/');
  return providerPattern.test(provider) && segments.length > 0 && segments.every(segment => segmentPattern.test(segment));
}
function family(model: string): string | undefined {
  const lastSegment = model.slice(model.lastIndexOf('/') + 1).toLowerCase();
  return ['claude', 'gpt', 'gemini'].find(prefix => lastSegment.startsWith(prefix));
}
function profileRules(profile: Profile): boolean {
  const reviewer = profile.roles[slots.indexOf('reviewer')];
  const alternate = profile.roles[slots.indexOf('reviewer-alternate')];
  return family(reviewer.model) !== family(alternate.model) && [reviewer, alternate].every(row =>
    !row.upgrade || family(row.upgrade.model) === family(row.model));
}
function profilesAgree(a: Row, b: Row): boolean {
  const defaultFamily = family(a.model);
  if (!defaultFamily || defaultFamily !== family(b.model) || a.thinking !== b.thinking) return false;
  if (!a.upgrade || !b.upgrade) return a.upgrade === b.upgrade;
  const upgradeFamily = family(a.upgrade.model);
  return upgradeFamily !== undefined && upgradeFamily === family(b.upgrade.model) &&
    a.upgrade.when === b.upgrade.when && a.upgrade.thinking === b.upgrade.thinking;
}

export function analyzeDevKitModels(bytes: Uint8Array): Report {
  if (!(bytes instanceof Uint8Array)) throw invalid('devkit-models-input-invalid');
  if (bytes.byteLength > LIMITS.fileBytes) return { status: 'unsupported', reason: 'limit' };
  let root: JsonValue;
  try { root = parseJsonBytes(bytes); }
  catch (error) {
    if (error instanceof ToolError) return { status: 'invalid', reason: 'json' };
    throw error;
  }
  const shape = { status: 'invalid', reason: 'shape' } as const;
  const version = { status: 'unsupported', reason: 'version' } as const;
  if (!isObject(root)) return shape;
  if (root.schemaVersion !== 1) return version;
  if (!hasKeys(root, ['schemaVersion', 'hostTasksProfile', 'profiles']) || typeof root.hostTasksProfile !== 'string' ||
      !isObject(root.profiles) || !hasKeys(root.profiles, profileNames)) return shape;
  const work = readProfile(root.profiles.work), privateProfile = readProfile(root.profiles.private);
  if (!work || !privateProfile) return shape;
  if (!hasIntegerVersion(decodeUtf8(bytes))) return version;
  const profiles = [work, privateProfile];
  if (profiles.some(profile => profile.providers.some(provider => !providerPattern.test(provider)) ||
      profile.roles.some(row => !modelSpelling(row.model) || (row.upgrade !== undefined &&
        (!modelSpelling(row.upgrade.model) || !triggerPattern.test(row.upgrade.when)))))) {
    return { status: 'unsupported', reason: 'syntax' };
  }
  const providerSets = profiles.map(profile => new Set(profile.providers));
  if (root.hostTasksProfile !== 'work' && root.hostTasksProfile !== 'private' || profiles.some((profile, i) => {
    const providers = providerSets[i];
    const validModel = (binding: Model) => thinkingLevels.has(binding.thinking) &&
      providers.has(binding.model.slice(0, binding.model.indexOf('/')));
    return providers.size === 0 || providers.size !== profile.providers.length || profile.roles.some(row =>
      !validModel(row) || (row.upgrade !== undefined && (!validModel(row.upgrade) || !row.upgrade.when.trim())));
  })) return { status: 'invalid', reason: 'value' };
  if (work.providers.some(provider => providerSets[1].has(provider)) || profiles.some(profile => !profileRules(profile)) ||
      work.roles.some((row, i) => !profilesAgree(row, privateProfile.roles[i]))) return { status: 'invalid', reason: 'rule' };
  return { status: 'recognized' };
}
