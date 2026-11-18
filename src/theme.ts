/**
 * Pure, bounded Pi 1.5.2 local-theme readiness adapter; never imports Pi,
 * evaluates resource code or accesses the filesystem. Sources: vendor
 * theme-schema.js, theme-tokens.js and pi-tui/colors.js at that revision.
 *
 * False means invalid OR outside the supported conservative subset, not
 * permission to omit the file. Plan must keep such an intent incomplete.
 * Unused variables and HTML-export colors are checked too. A reference chain
 * contains at most 32 variable names, including the first referenced name.
 */
import { isObject, parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';
import { BUILTIN_THEMES, LIMITS } from './schema.ts';

const REQUIRED = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning', 'muted', 'dim', 'text',
  'thinkingText', 'selectedBg', 'userMessageBg', 'userMessageText', 'customMessageBg', 'customMessageText',
  'customMessageLabel', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg', 'toolTitle', 'toolOutput',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder',
  'mdHr', 'mdListBullet', 'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext', 'syntaxComment',
  'syntaxKeyword', 'syntaxFunction', 'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType',
  'syntaxOperator', 'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium',
  'thinkingHigh', 'thinkingXhigh', 'bashMode',
] as const;
const TOKENS = new Set<string>([...REQUIRED, 'scrollbarTrack', 'scrollbarThumb', 'searchMatchBg', 'searchMatchText', 'thinkingMax']);
const TOP_KEYS = new Set(['$schema', 'name', 'appearance', 'vars', 'colors', 'export']);
const EXPORT_KEYS = new Set(['pageBg', 'cardBg', 'infoBg']);
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const OKLCH = new RegExp(`^oklch\\(\\s*(${NUMBER})(%)?\\s+(${NUMBER})\\s+(${NUMBER})(?:deg)?\\s*\\)$`, 'i');
const OKHSL = new RegExp(`^okhsl\\(\\s*(${NUMBER})(?:deg)?\\s+(${NUMBER})(%)?\\s+(${NUMBER})(%)?\\s*\\)$`, 'i');
const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
const string = (v: unknown): v is string => typeof v === 'string' && v.length <= LIMITS.stringLength;

/** Native grammar/ranges, narrowed to avoid extreme color-conversion arithmetic. */
function literal(v: string): boolean {
  if (v === '' || /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v)) return true;
  const lch = OKLCH.exec(v);
  if (lch) {
    const l = Number(lch[1]) / (lch[2] ? 100 : 1);
    const c = Number(lch[3]); const h = Number(lch[4]);
    return unit(l) && Number.isFinite(c) && c >= 0 && c <= 1e6 && Number.isFinite(h) && Math.abs(h) <= 1e6;
  }
  const hsl = OKHSL.exec(v);
  if (hsl) {
    const h = Number(hsl[1]); const s = Number(hsl[2]) / (hsl[3] ? 100 : 1);
    const l = Number(hsl[4]) / (hsl[5] ? 100 : 1);
    // Pi's OKHSL conversion divides by powers of lightness-dependent chroma.
    // Keep exact black/white but refuse near-endpoint numerical extremes.
    return Number.isFinite(h) && Math.abs(h) <= 1e6 && unit(s) && unit(l) &&
      (l === 0 || l === 1 || (l >= 1e-6 && l <= 1 - 1e-6));
  }
  return false;
}

/** Iterative and bounded, including when checking long unused-variable chains. */
function color(value: JsonValue, vars: JsonObject, first?: string): boolean {
  const seen = new Set<string>(first === undefined ? [] : [first]);
  for (;;) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 255;
    if (!string(value)) return false;
    if (value === '' || value.startsWith('#') || /^ok(lch|hsl)\(/i.test(value)) return literal(value);
    if (seen.has(value) || !Object.hasOwn(vars, value)) return false;
    seen.add(value);
    if (seen.size > 32) return false;
    value = vars[value];
  }
}

/** Validate already-approved bytes; strict JSON errors retain their fixed codes. */
export function themeReady(bytes: Uint8Array, expectedName: string): boolean {
  if (bytes.length > LIMITS.fileBytes) return false;
  const doc = parseJsonBytes(bytes);
  if (!isObject(doc) || Object.keys(doc).some((k) => !TOP_KEYS.has(k))) return false;
  if (!string(doc.name) || doc.name.length === 0 || doc.name.trim() !== doc.name || doc.name.includes('/') ||
      doc.name !== expectedName || BUILTIN_THEMES.has(doc.name)) return false;
  if (Object.hasOwn(doc, '$schema') && !string(doc.$schema)) return false;
  if (Object.hasOwn(doc, 'appearance') && doc.appearance !== 'dark' && doc.appearance !== 'light') return false;
  const vars = Object.hasOwn(doc, 'vars') ? doc.vars : Object.create(null) as JsonObject;
  if (!isObject(vars) || Object.keys(vars).length > LIMITS.arrayItems) return false;
  for (const k of Object.keys(vars)) if (!string(k) || !color(vars[k], vars, k)) return false;
  if (!isObject(doc.colors) || Object.keys(doc.colors).some((k) => !TOKENS.has(k)) ||
      REQUIRED.some((k) => !Object.hasOwn(doc.colors as JsonObject, k))) return false;
  for (const value of Object.values(doc.colors)) if (!color(value, vars)) return false;
  if (Object.hasOwn(doc, 'export')) {
    if (!isObject(doc.export) || Object.keys(doc.export).some((k) => !EXPORT_KEYS.has(k))) return false;
    for (const value of Object.values(doc.export)) if (!color(value, vars)) return false;
  }
  return true;
}
