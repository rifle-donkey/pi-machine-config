/** Offline diagnostic for the documented pi-herdr-agents 3.12.1 subset, not the Maestro loader. */
import { invalid, ToolError } from './errors.ts';
import { isObject, parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';
import { LIMITS } from './schema.ts';

type Report = { status: 'recognized' } | { status: 'invalid'; reason: 'json' | 'shape' | 'value' } |
  { status: 'unsupported'; reason: 'limit' | 'key' | 'syntax' | 'value' };
const sections = {
  herdr: { backend: 'string' }, status: { enabled: 'boolean' },
  persistent: { maxAgents: 'number' }, spawning: { maxDepth: 'number' },
  supervision: { forcePolling: 'boolean', hangWarningMinutes: 'number' },
  panes: { mode: 'string', direction: 'string', maxPerTab: 'number' },
  guidelines: { launchRoster: 'boolean' },
  models: { default: 'string', agents: 'object', tasks: 'object', tasksThinking: 'object', tasksMeta: 'object' },
} as const;
const categories = ['coding', 'review', 'recon', 'qa', 'architecture', 'docs'];
const metaKeys = ['generatedAt', 'method'];
const spelling = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const segment = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const timestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;
const unknownKeys = (value: JsonObject, allowed: readonly string[]) => Object.keys(value).some(key => !allowed.includes(key));

function badKeys(root: JsonObject): boolean {
  if (!Object.hasOwn(root, 'status') || unknownKeys(root, [...Object.keys(sections), 'outcomeLedger'])) return true;
  for (const [name, fields] of Object.entries(sections)) {
    const value = root[name];
    if (isObject(value) && unknownKeys(value, Object.keys(fields))) return true;
  }
  if (isObject(root.status) && !Object.hasOwn(root.status, 'enabled')) return true;
  if (!isObject(root.models)) return false;
  const { tasks, tasksThinking, tasksMeta } = root.models;
  return [tasks, tasksThinking].some(map => isObject(map) && unknownKeys(map, categories)) ||
    (isObject(tasksMeta) && (unknownKeys(tasksMeta, metaKeys) || metaKeys.some(key => !Object.hasOwn(tasksMeta, key))));
}

function badShape(root: JsonObject): boolean {
  if (Object.hasOwn(root, 'outcomeLedger') && typeof root.outcomeLedger !== 'boolean') return true;
  for (const [name, fields] of Object.entries(sections)) {
    if (!Object.hasOwn(root, name)) continue;
    const value = root[name];
    if (!isObject(value)) return true;
    for (const [key, kind] of Object.entries(fields)) {
      if (Object.hasOwn(value, key) && (kind === 'object' ? !isObject(value[key]) : typeof value[key] !== kind)) return true;
    }
  }
  if (!isObject(root.models)) return false;
  const { agents, tasks, tasksThinking, tasksMeta } = root.models;
  return [agents, tasksThinking, tasksMeta].some(map => isObject(map) && Object.values(map).some(value => typeof value !== 'string')) ||
    (isObject(tasks) && Object.values(tasks).some(value => !Array.isArray(value) || value.some(item => typeof item !== 'string')));
}

function trimAsciiSpace(value: string): string {
  let start = 0, end = value.length;
  while (start < end && value[start] === ' ') start++;
  while (end > start && value[end - 1] === ' ') end--;
  return value.slice(start, end);
}

function validReference(ref: string): boolean {
  if (ref.length > 256) return false;
  const [provider, ...parts] = ref.split('/');
  return spelling.test(provider) && parts.length > 0 && parts.every(part => segment.test(part));
}

function dictionary(value: JsonValue | undefined): JsonObject {
  return isObject(value) ? value : {};
}
function outside(value: JsonValue | undefined, allowed: readonly string[]): boolean {
  return typeof value === 'string' && !allowed.includes(value);
}
function badInteger(value: JsonValue | undefined, min: number): boolean {
  return typeof value === 'number' && (!Number.isSafeInteger(value) || value < min);
}
const repeated = (values: readonly JsonValue[]): boolean => new Set(values).size !== values.length;

export function analyzeHerdrConfig(bytes: Uint8Array): Report {
  if (!(bytes instanceof Uint8Array)) throw invalid('herdr-config-input-invalid');
  if (bytes.byteLength > LIMITS.fileBytes) return { status: 'unsupported', reason: 'limit' };
  let root: JsonValue;
  try { root = parseJsonBytes(bytes); }
  catch (error) {
    if (error instanceof ToolError) return { status: 'invalid', reason: 'json' };
    throw error;
  }
  if (!isObject(root)) return { status: 'invalid', reason: 'shape' };
  if (badKeys(root)) return { status: 'unsupported', reason: 'key' };
  if (badShape(root)) return { status: 'invalid', reason: 'shape' };

  const models = dictionary(root.models), agents = dictionary(models.agents);
  const tasks = dictionary(models.tasks), thinking = dictionary(models.tasksThinking), meta = dictionary(models.tasksMeta);
  const candidateLists = Object.values(tasks).filter(Array.isArray);
  const fallbacks: string[][] = [];
  for (const value of [models.default, ...Object.values(agents)]) {
    if (typeof value === 'string') fallbacks.push(value.split(',').map(trimAsciiSpace));
  }
  if (Object.keys(agents).some(name => !spelling.test(name)) ||
      fallbacks.some(list => list.length > 8 || list.some(ref => !validReference(ref))) ||
      candidateLists.some(list => list.some(ref => typeof ref === 'string' && !validReference(ref))) ||
      (typeof meta.generatedAt === 'string' && !timestamp.test(meta.generatedAt))) return { status: 'unsupported', reason: 'syntax' };

  const panes = dictionary(root.panes);
  if (outside(dictionary(root.herdr).backend, ['auto', 'legacy', 'core']) ||
      outside(panes.mode, ['grouped', 'tab', 'split']) || outside(panes.direction, ['right', 'down']) ||
      badInteger(dictionary(root.spawning).maxDepth, 1) || badInteger(panes.maxPerTab, 1) ||
      Object.values(thinking).some(level => outside(level, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])) ||
      outside(meta.method, ['research', 'registry-only'])) return { status: 'invalid', reason: 'value' };

  if (badInteger(dictionary(root.persistent).maxAgents, 1) || badInteger(dictionary(root.supervision).hangWarningMinutes, 0) ||
      (Object.hasOwn(models, 'tasks') && candidateLists.length === 0) ||
      (Object.hasOwn(models, 'tasksThinking') && Object.keys(thinking).length === 0) ||
      candidateLists.some(list => list.length === 0 || repeated(list)) || fallbacks.some(repeated) ||
      Object.keys(thinking).some(category => !Object.hasOwn(tasks, category))) return { status: 'unsupported', reason: 'value' };
  return { status: 'recognized' };
}
