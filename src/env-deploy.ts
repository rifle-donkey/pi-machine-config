/* Plan from local evidence; apply ordered changes only after explicit consent. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { array, decode, object, str, totalLimit, type Entry } from './env-archive.ts';
import { directory, excluded, file, relativePath, roots, stat } from './env-files.ts';
import { failure, invalid } from './errors.ts';
import { jsonBytes, render } from './env-render.ts';
import { catalog, checkMetadata, exe, globals, installed, machineKeys, npmName, packageSource, piInstallSource, registry, registryOrigin, run, safeRemote, version } from './env-host.ts';
import { parseJsonBytes, type JsonObject, type JsonValue } from './json.ts';

const log = (action: string, target: string, details: JsonObject = {}) => process.stdout.write(`${JSON.stringify({ action, target, ...details })}\n`);
type Current = ReturnType<typeof file>;
const equal = (a: Current, b: Current) => a === b || (!!a && !!b && a.mode === b.mode && a.bytes.equals(b.bytes));
function writeAtomic(path: string, bytes: Buffer, mode: number, old: Current) {
  directory(dirname(path), true);
  const tmp = join(dirname(path), `.pi-env-${randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); } finally { fs.closeSync(fd); }
    if (!equal(file(path), old)) throw failure('target-changed');
    if (old) fs.renameSync(tmp, path);
    else { fs.linkSync(tmp, path); fs.unlinkSync(tmp); }
  } catch (err) { if (stat(tmp)) fs.unlinkSync(tmp); throw err; }
}
function mapVersions(rows: JsonValue | undefined) {
  const seen = new Set<string>();
  return array(rows).map(v => {
    const row = object(v), name = str(row.name), ver = str(row.version);
    if (!npmName.test(name) || !version.test(ver) || seen.has(name)) throw invalid('invalid-package');
    seen.add(name);
    return { row, name, ver };
  });
}
export function deploy(archive: string, yes: boolean, pin: boolean) {
  const compressed = file(resolve(archive), totalLimit);
  if (!compressed) throw invalid('missing-archive');
  const { metadata, entries } = decode(compressed.bytes);
  checkMetadata(metadata);
  const { home, agent, lens, backup } = roots();
  const launcher = join(agent, 'bin', 'pi');
  if (!directory(dirname(launcher)) || !stat(launcher)?.isFile()) throw failure('missing-pi-launcher');
  fs.accessSync(launcher, fs.constants.X_OK);
  const ps = exe('ps');
  const processes = ps && run(ps, ['-eo', 'pid,comm,args'], { cwd: home });
  if (!processes) throw failure('process-check-failed');
  if (processes.toString().split('\n').some(line => /^\s*\d+\s+(?:\S*\/)?pi(?:\s|$)/.test(line) ||
      /^\s*\d+\s+(?:\S*\/)?node(?:\s|$)/.test(line) && /(?:\/pi\/|\/pi-coding-agent\/|\/bin\/pi(?:\s|$))/.test(line))) throw failure('pi-running');
  directory(backup);
  const settings = entries.find(e => e.root === 'agent' && e.path === 'settings.json')!;
  const settingsPath = join(agent, 'settings.json');
  const previous = file(settingsPath);
  const prior = previous ? object(parseJsonBytes(previous.bytes)) : {};
  const desired = object(parseJsonBytes(render(settings.path, settings.bytes, home, settings.templated)));
  const stored = object(parseJsonBytes(settings.bytes));
  const restored = array(desired.packages ?? []), declarations = array(stored.packages ?? []);
  const info = array(metadata.piPackages);
  if (info.length !== declarations.length) throw invalid('invalid-packages');
  const seenPi = new Set<string>();
  const pi = restored.map((declaration, i) => {
    const row = object(info[i]);
    if (JSON.stringify(row.declaration) !== JSON.stringify(declarations[i])) throw invalid('invalid-packages');
    const source = packageSource(declaration);
    if (typeof source !== 'string' || !source || hasControl(source)) throw invalid('invalid-package');
    const reg = registry(source), recorded = row.installedVersion;
    if (recorded !== null && (typeof recorded !== 'string' || !version.test(recorded))) throw invalid('invalid-package');
    if (!reg) return { declaration, source, recorded, action: 'manual' };
    if (seenPi.has(reg.name)) throw invalid('duplicate-package');
    seenPi.add(reg.name);
    const { wanted, effective } = piInstallSource(reg, pin, recorded);
    const updated = pin ? typeof declaration === 'string' ? effective : { ...object(declaration), source: effective } : declaration;
    return { declaration: updated, source: effective, recorded, name: reg.name, action: installed(join(agent, 'npm'), reg.name, wanted) ? 'same' : 'install' };
  });
  desired.packages = pi.map(p => p.declaration);
  for (const key of machineKeys) {
    delete desired[key];
    if (Object.hasOwn(prior, key)) desired[key] = prior[key];
  }
  const sameSources = new Set(pi.map(p => registry(p.source)?.name ?? p.source));
  const dropped = array(prior.packages ?? []).map(packageSource).filter((s): s is string => typeof s === 'string' && !sameSources.has(registry(s)?.name ?? s));
  const planFile = (entry: Entry, input?: Buffer, old?: Current) => {
    const path = join(entry.root === 'agent' ? agent : lens, entry.path);
    const before = input ? old : file(path);
    const bytes = input ?? render(entry.path, entry.bytes, home, entry.templated);
    const mode = entry.mode & 0o755;
    return { entry, path, before, bytes, mode, action: !before ? 'create' : equal(before, { bytes, mode }) ? 'same' : 'replace' };
  };
  const others = entries.filter(e => e !== settings).map(e => planFile(e));
  const final = planFile(settings, jsonBytes(desired), previous);
  const npm = exe('npm'), git = exe('git');
  const current = globals(home);
  const globalsPlan = mapVersions(metadata.npmGlobals).map(p => {
    const existing = current[p.name];
    const wanted = registryOrigin(p.name, p.ver, p.row);
    const present = existing && typeof existing === 'object' && !Array.isArray(existing) && existing.version === p.ver;
    return { ...p, action: present ? 'same' : !existing && wanted && npm ? 'install' : 'manual' };
  });
  if (globalsPlan.some(p => p.action === 'install')) {
    const prefix = run(npm!, ['prefix', '-g'], { cwd: home })?.toString().trim();
    let writable = false;
    if (prefix && isAbsolute(prefix)) {
      try { fs.accessSync(prefix, fs.constants.W_OK); writable = true; } catch { /* Prefix is not writable. */ }
    }
    if (!writable) for (const p of globalsPlan) if (p.action === 'install') p.action = 'manual';
  }
  const memberPaths = entries.filter(e => e.root === 'agent').map(e => e.path);
  const gitPaths = new Set<string>();
  const clones = array(metadata.gitDirs).map(row => {
    const item = object(row), path = relativePath(str(item.path)), remote = str(item.remote);
    if (excluded(path) || gitPaths.has(path) || path.includes('/') || !safeRemote(remote) ||
        memberPaths.some(p => p === path || p.startsWith(path + '/'))) throw invalid('invalid-git-directory');
    gitPaths.add(path);
    const dest = join(agent, path);
    const present = directory(dest);
    return { path, dest, remote, action: present ? 'skip' : git ? 'clone' : 'manual' };
  });
  const lensRoot = join(lens, 'tools'), lensPath = join(lensRoot, 'package.json');
  const addons = mapVersions(metadata.lensTools);
  const lensPlan = pi.some(p => p.name === 'pi-lens') && addons.length ? {
    old: file(lensPath), bytes: jsonBytes({ private: true, dependencies: Object.fromEntries(addons.map(p => [p.name, p.ver])) }),
    needed: addons.some(p => !installed(lensRoot, p.name, p.ver)),
  } : undefined;
  const formulas: Readonly<Record<string, string>> = { gh: 'gh', git: 'git', uv: 'uv', python3: 'python' };
  const brew = process.platform === 'darwin' ? exe('brew') : undefined;
  const sourceTools = new Set<string>();
  for (const item of array(metadata.tools)) {
    const id = str(object(item).id);
    if (!catalog.includes(id) || sourceTools.has(id)) throw invalid('invalid-tool');
    sourceTools.add(id);
  }
  const tools = catalog.filter(id => sourceTools.has(id)).map(id => ({
    id, formula: Object.hasOwn(formulas, id) ? formulas[id] : undefined, action: exe(id) ? 'installed' : 'manual',
  }));
  if (brew && tools.some(t => t.action === 'manual' && t.formula)) {
    const prefix = run(brew, ['--prefix'], { cwd: home })?.toString().trim();
    if (prefix && isAbsolute(prefix)) {
      try {
        fs.accessSync(prefix, fs.constants.W_OK);
        for (const t of tools) if (t.action === 'manual' && t.formula) t.action = 'install';
      } catch { /* No unattended recipe for this prefix. */ }
    }
  }
  for (const t of tools) log(t.action, t.id, t.action === 'install' ? { command: `brew install ${t.formula}` } : {});
  for (const p of globalsPlan) log(p.action, p.name, { version: p.ver });
  for (const f of [...others, final]) log(f.action, `${f.entry.root}/${f.entry.path}`);
  for (const s of dropped) log('drop-package', registry(s)?.name ?? 'manual package');
  for (const p of pi) log(p.action, p.source, { recorded: p.recorded });
  for (const c of clones) log(c.action, c.path);
  if (lensPlan?.needed) log(npm ? 'install' : 'manual', 'pi-lens/tools');
  if (!yes) return;
  let backupRun: string | undefined;
  const save = (label: string, before: Current) => {
    if (!before) return;
    if (!backupRun) {
      directory(backup, true);
      backupRun = fs.mkdtempSync(join(backup, 'deploy-'));
      log('backup', `~/.pi-env-backup/${backupRun.slice(backup.length + 1)}`);
    }
    writeAtomic(join(backupRun, label), before.bytes, 0o600, undefined);
  };
  const applyFile = (f: ReturnType<typeof planFile>) => {
    if (f.action === 'same') return;
    const label = `${f.entry.root}/${f.entry.path}`;
    save(label, f.before);
    writeAtomic(f.path, f.bytes, f.mode, f.before);
    log('done', label);
  };
  for (const t of tools) if (t.action === 'install') {
    run(brew!, ['install', t.formula!], { cwd: home, apply: true });
    log('done', t.id);
  }
  for (const p of globalsPlan) if (p.action === 'install') {
    run(npm!, ['install', '-g', `${p.name}@${p.ver}`], { cwd: home, apply: true });
    log('done', p.name);
  }
  for (const f of others) applyFile(f);
  if (pi.some(p => p.action === 'install')) {
    save('agent/settings.json', previous);
    writeAtomic(settingsPath, jsonBytes({ ...desired, packages: [] }), final.mode, previous);
    for (const p of pi) if (p.action === 'install') {
      run(launcher, ['install', p.source], { cwd: home, apply: true });
      log('done', p.name!);
    }
    writeAtomic(settingsPath, final.bytes, final.mode, file(settingsPath));
    log('done', 'agent/settings.json');
  } else applyFile(final);
  for (const c of clones) if (c.action === 'clone') {
    if (stat(c.dest)) throw failure('target-changed');
    run(git!, ['clone', '--', c.remote, c.dest], { cwd: agent, apply: true, git: true });
    log('done', c.path);
  }
  if (lensPlan?.needed && npm && installed(join(agent, 'npm'), 'pi-lens')) {
    if (!lensPlan.old?.bytes.equals(lensPlan.bytes)) {
      save('pi-lens/tools/package.json', lensPlan.old);
      writeAtomic(lensPath, lensPlan.bytes, 0o600, lensPlan.old);
    }
    run(npm, ['install'], { cwd: lensRoot, apply: true });
    log('done', 'pi-lens/tools');
  }
  for (const item of ['Pi /login', 'gh auth login', 'Recreate MCP credentials and local secrets', 'Configure SSH separately']) log('manual', item);
}
function hasControl(s: string) { return /[\x00-\x1f\x7f]/.test(s); }
