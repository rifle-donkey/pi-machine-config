/* Capture only explicitly permitted files and local package metadata. */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { failure, invalid } from './errors.ts';
import { array, encode, entryLimit, object, totalLimit, type Entry } from './env-archive.ts';
import { directory, excluded, file, relativePath, roots, stat } from './env-files.ts';
import { captureBytes } from './env-render.ts';
import { catalog, checkMetadata, exe, globals, machineKeys, npmName, packageSource, readObject, registry, registryOrigin, run, safeRemote, version } from './env-host.ts';
import { parseJsonBytes, type JsonObject } from './json.ts';

const standard = ['AGENTS.md', 'settings.json', 'keybindings.json', 'models.json', 'sandbox.json', 'extensions', 'skills', 'prompts', 'themes', 'dev-kit/models.json', 'herdr-agents/config.json'];
const installer = 'official';
export function scan(out: string, include: string[], exclude: string[], allow: string[]) {
  const { home, agent, lens } = roots();
  if (!directory(agent)) throw failure('missing-agent-root');
  const output = resolve(out);
  if (!out.endsWith('.tar.gz') || !directory(dirname(output)) || stat(output)) throw invalid('invalid-output');
  const entries: Entry[] = [], paths = new Set<string>();
  const skipped: JsonObject[] = [], gitDirs: JsonObject[] = [];
  const reject = (path: string) => exclude.some(p => path === p || path.startsWith(p + '/'));
  const isRepo = (dir: string) => {
    const git = stat(join(dir, '.git'));
    return !!git && (!git.isDirectory() || !!stat(join(dir, '.git', 'HEAD')));
  };
  for (const path of include) {
    if (excluded(path) || reject(path)) continue;
    const components = path.split('/');
    for (let i = 1; i < components.length; i++) {
      const dir = join(agent, ...components.slice(0, i));
      if (!directory(dir)) break;
      if (isRepo(dir)) throw invalid('include-git-content');
    }
  }
  let skippedPrivate = 0, total = 0, visited = 0;
  const add = (root: Entry['root'], base: string, path: string) => {
    if (paths.has(`${root}/${path}`)) return;
    if (++visited > entryLimit * 4) throw invalid('scan-entry-limit');
    paths.add(`${root}/${path}`);
    if (excluded(path)) { skippedPrivate++; return; }
    if (root === 'agent' && reject(path)) return;
    relativePath(path);
    const target = join(base, path);
    if (!directory(dirname(target))) return;
    const s = stat(target);
    if (!s) return;
    if (s.isDirectory()) {
      if (root === 'pi-lens' || path === 'settings.json') throw invalid('expected-file');
      if (isRepo(target)) return;
      for (const child of fs.readdirSync(target).sort()) add(root, base, `${path}/${child}`);
      return;
    }
    if (!s.isFile() || s.nlink !== 1) { skippedPrivate++; return; }
    const input = file(target);
    if (!input) throw failure('changed-file');
    const settings = root === 'agent' && path === 'settings.json' ? object(parseJsonBytes(input.bytes)) : undefined;
    if (settings) for (const k of machineKeys) delete settings[k];
    const result = captureBytes(path, input.bytes, home, root === 'agent' && allow.includes(path), settings);
    total += result.bytes.length;
    if (total > totalLimit || entries.length >= entryLimit) throw invalid('archive-limit');
    entries.push({ root, path, mode: input.mode, ...result });
  };
  for (const path of [...standard, ...include]) add('agent', agent, path);
  add('pi-lens', lens, 'config.json');
  const settingsEntry = entries.find(e => e.root === 'agent' && e.path === 'settings.json');
  if (!settingsEntry) throw invalid('missing-settings');
  const settings = object(parseJsonBytes(settingsEntry.bytes));
  const lock = readObject(join(agent, 'npm', 'package-lock.json'));
  const packages = lock ? object(lock.packages ?? {}) : {};
  const piPackages = array(settings.packages ?? []).map(declaration => {
    const reg = registry(packageSource(declaration));
    const pkg = reg && readObject(join(agent, 'npm', 'node_modules', reg.name, 'package.json'));
    const meta = reg && packages[`node_modules/${reg.name}`];
    const v = pkg?.version ?? (meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.version : undefined);
    return { declaration, installedVersion: typeof v === 'string' && version.test(v) ? v : null };
  });
  const git = exe('git');
  for (const path of fs.readdirSync(agent).sort()) {
    if (++visited > entryLimit * 4) throw invalid('scan-entry-limit');
    if (excluded(path)) { skippedPrivate++; continue; }
    relativePath(path);
    if (reject(path)) continue;
    const dir = join(agent, path);
    if (git && stat(dir)?.isDirectory() && stat(join(dir, '.git'))?.isDirectory() && stat(join(dir, '.git', 'config'))?.isFile()) {
      const config = join(dir, '.git', 'config');
      file(config); // Refuse links and cap local Git configuration before the probe.
      const remote = run(git, ['-C', dir, 'config', '--no-includes', '--file', config, '--get', 'remote.origin.url'], { cwd: home })?.toString().trim();
      const head = file(join(dir, '.git', 'HEAD'))?.bytes.toString().trim();
      if (remote && safeRemote(remote)) gitDirs.push({ path, remote, branch: head?.startsWith('ref: refs/heads/') ? head.slice(16) : null });
      else if (remote) { if (/https?:\/\/[^/\s]*@/.test(remote)) throw invalid('metadata-secret'); skippedPrivate++; }
      continue;
    }
    if (!standard.some(p => p === path || p.startsWith(path + '/')) && !include.some(p => p === path || p.startsWith(path + '/'))) skipped.push({ path, reason: 'not-allowlisted' });
  }
  const tools = catalog.flatMap(id => {
    const location = exe(id);
    const result = location && run(location, ['--version'], { cwd: home });
    return location && result ? [{ id, location, version: result.toString().trim().slice(0, 256) }] : [];
  });
  const npmGlobals = Object.entries(globals(home)).flatMap(([name, v]) => {
    if (name === 'npm' || !npmName.test(name) || !v || typeof v !== 'object' || Array.isArray(v)) return [];
    const value = v.version;
    if (typeof value !== 'string' || !version.test(value)) return [];
    return [{ name, version: value, resolved: registryOrigin(name, value, v) ? v.resolved! : null }];
  });
  const deps = object(readObject(join(lens, 'tools', 'package.json'))?.dependencies ?? {});
  const lensTools = Object.entries(deps).flatMap(([name, spec]) => {
    if (!npmName.test(name) || typeof spec !== 'string' || !version.test(spec)) return [];
    const installedVersion = readObject(join(lens, 'tools', 'node_modules', name, 'package.json'))?.version;
    return [{ name, version: typeof installedVersion === 'string' && version.test(installedVersion) ? installedVersion : spec }];
  });
  const metadata: JsonObject = { source: { platform: process.platform, architecture: process.arch, scannedAt: new Date().toISOString(), piVersion: null, installMethod: installer },
    runtimes: { node: process.version, npm: tools.find(t => t.id === 'npm')?.version ?? null }, piPackages, gitDirs, npmGlobals, lensTools, tools,
    skipped: [...skipped, { count: skippedPrivate, reason: 'private-or-unsupported' }], manual: ['Pi /login', 'gh auth login', 'Recreate MCP credentials and local secrets', 'Set up SSH separately; ignored files and unpushed commits are not transferred'] };
  checkMetadata(metadata);
  const archive = encode(metadata, entries);
  const fd = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(fd, archive); } catch (err) { fs.closeSync(fd); fs.unlinkSync(output); throw err; }
  fs.closeSync(fd);
  return { files: entries.length, skipped: skipped.length + skippedPrivate };
}
