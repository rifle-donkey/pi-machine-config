/* Local metadata probes and fixed, bounded external commands. */
import { spawnSync } from 'node:child_process';
import { constants, accessSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure, invalid } from './errors.ts';
import { file, MiB } from './env-files.ts';
import { object } from './env-archive.ts';
import { parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';

export const catalog = ['node', 'npm', 'gh', 'git', 'uv', 'python3', 'brew', 'typescript-language-server'];
export const machineKeys = ['deviceId', 'lastChangelogVersion', 'extensionChangelogVersions'];
export const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const spec = /^(?:npm:)((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/;
export function packageSource(v: JsonValue) { return typeof v === 'string' ? v : object(v).source; }
export function registry(source: JsonValue | undefined) {
  if (typeof source !== 'string' || source.length > 320) return;
  const m = spec.exec(source);
  if (m && (!m[2] || version.test(m[2]))) return { name: m[1]!, pin: m[2] };
}
export function piInstallSource(source: NonNullable<ReturnType<typeof registry>>, pin: boolean, recorded: string | null) {
  const wanted = pin ? recorded : source.pin;
  if (pin && !wanted) throw invalid('missing-pin-version');
  return { wanted: wanted ?? undefined, effective: `npm:${source.name}${wanted ? `@${wanted}` : ''}` };
}
export function exe(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, name);
    try { accessSync(path, constants.X_OK); return path; } catch { /* Try the next path. */ }
  }
}
export function run(path: string, args: string[], options: { cwd: string; apply?: boolean; git?: boolean }): Buffer | undefined {
  const duration = options.apply ? 300_000 : 5_000;
  const helper = fileURLToPath(new URL('./env-command.ts', import.meta.url));
  const result = spawnSync(process.execPath, [helper, path, `${duration}`, ...args], {
    cwd: options.cwd, timeout: duration + 5_000, killSignal: 'SIGKILL', maxBuffer: 2 * MiB,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false',
      ...(options.apply ? { npm_config_registry: 'https://registry.npmjs.org/' } : {}),
      ...(options.git ? { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'https:ssh' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!result.error && result.status === 0) return result.stdout;
  if (options.apply) throw failure('external-command-failed');
}
export function readObject(path: string): JsonObject | undefined {
  const found = file(path);
  if (found) return object(parseJsonBytes(found.bytes));
}
export function installed(root: string, name: string, pin?: string): boolean {
  const pkg = readObject(join(root, 'node_modules', name, 'package.json'));
  return !!pkg && pkg.name === name && typeof pkg.version === 'string' && version.test(pkg.version) && (!pin || pkg.version === pin);
}
export function globals(home: string): JsonObject {
  const npm = exe('npm');
  const data = npm && run(npm, ['ls', '-g', '--depth=0', '--json'], { cwd: home });
  if (!data) return {};
  return object(object(parseJsonBytes(data)).dependencies ?? {});
}
export function registryOrigin(name: string, v: string, metadata: JsonObject) {
  return !metadata.link && typeof metadata.resolved === 'string' &&
    metadata.resolved === `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${v}.tgz`;
}
export function hasUrlCredential(v: string): boolean {
  return /\bhttps?:\/\/[^/\s]*@/i.test(v) || /\bssh:\/\/[^/\s@]*:[^/\s@]*@/i.test(v);
}
export function safeRemote(s: string): boolean {
  if (s.length > 1024 || hasUrlCredential(s)) return false;
  return /^(?:https:\/\/|ssh:\/\/(?:[a-zA-Z0-9_-]+@)?)[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?\/[a-zA-Z0-9._/-]+$/.test(s) ||
    /^[a-zA-Z0-9_-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*:[a-zA-Z0-9._/-]+$/.test(s);
}
export function checkMetadata(value: JsonValue) {
  if (typeof value === 'string') {
    if (hasUrlCredential(value) || /(?:github_pat_|ghp_|xox[baprs]-|AKIA[0-9A-Z]{16}|sk-[0-9A-Za-z_-]{16})/.test(value)) throw invalid('metadata-secret');
  } else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) { checkMetadata(key); checkMetadata(v); }
}
