/** Diagnose a closed subset of Pi 1.5.2 keybindings without loading Pi. */
import { invalid, ToolError } from './errors.ts';
import { isObject, parseJsonBytes, type JsonValue } from './json.ts';
import { LIMITS } from './schema.ts';

// Pi 1.5.2: pi-coding-agent/dist/core/keybindings.js and pi-tui/dist/keybindings.js.
const actions = new Set([
  'app.interrupt', 'app.clear', 'app.exit', 'app.thinking.cycle', 'app.model.select', 'app.tools.expand',
  'tui.editor.cursorUp', 'tui.editor.cursorDown',
]);
// Narrow subset of pi-coding-agent/dist/core/key-id-schema.js and pi-tui/dist/keys.js.
const modifiers = ['ctrl', 'shift', 'alt', 'super'];
const namedBases = new Set(['escape', 'tab', 'enter', 'backspace', 'delete', 'home', 'end', 'space', 'up', 'down', 'left', 'right']);
type Report = { status: 'recognized'; actions: number } |
  { status: 'invalid'; reason: 'json' | 'shape' } |
  { status: 'unsupported'; reason: 'limit' | 'action' | 'key' | 'duplicate' };

function bindingIdentity(key: string): string | undefined {
  if (key.length > 64) return;
  const parts = key.split('+');
  const base = parts.pop()!;
  if (!(base.length === 1 && /^[a-z0-9]$/.test(base)) && !namedBases.has(base)) return;
  let mask = 0;
  for (const part of parts) {
    const index = modifiers.indexOf(part);
    if (index === -1 || (mask & (1 << index)) !== 0) return;
    mask |= 1 << index;
  }
  return `${mask}:${base}`;
}

export function analyzeKeybindings(bytes: Uint8Array): Report {
  if (!(bytes instanceof Uint8Array)) throw invalid('keybindings-input-invalid');
  if (bytes.byteLength > LIMITS.fileBytes) return { status: 'unsupported', reason: 'limit' };
  let parsed: JsonValue;
  try { parsed = parseJsonBytes(bytes); }
  catch (error) {
    if (error instanceof ToolError) return { status: 'invalid', reason: 'json' };
    throw error;
  }
  if (!isObject(parsed)) return { status: 'invalid', reason: 'shape' };
  const entries = Object.entries(parsed);
  if (entries.some(([id]) => !actions.has(id))) return { status: 'unsupported', reason: 'action' };
  const groups: string[][] = [];
  for (const [, value] of entries) {
    if (typeof value === 'string') groups.push([value]);
    else if (Array.isArray(value) && value.every(item => typeof item === 'string')) groups.push(value);
    else return { status: 'invalid', reason: 'shape' };
  }
  // All spellings are checked before counts, and all counts before duplicates.
  if (groups.some(keys => keys.some(key => bindingIdentity(key) === undefined))) return { status: 'unsupported', reason: 'key' };
  if (groups.some(keys => keys.length > 32)) return { status: 'unsupported', reason: 'limit' };
  if (groups.some(keys => new Set(keys.map(bindingIdentity)).size !== keys.length)) return { status: 'unsupported', reason: 'duplicate' };
  return { status: 'recognized', actions: entries.length };
}
