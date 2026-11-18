/** Report runtime and optional package manifest versions without executing tools. */
import { ToolError } from './errors.ts';
import { existingDir, guardLiveLexical, liveLocations, readUnder, requireAbsolute, type GuardContext } from './fsafe.ts';
import { isObject, parseJsonBytes } from './json.ts';
import { DISCOVERY_MODEL } from './schema.ts';

export const NODE_BASELINE_MAJOR = 24;
export function nodeBaselineMet(version: string): boolean {
  return Number(version.split('.')[0]) >= NODE_BASELINE_MAJOR;
}

const numberId = '(?:0|[1-9][0-9]*)';
const prereleaseId = `(?:${numberId}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numberId}\\.${numberId}\\.${numberId}(?:-${prereleaseId}(?:\\.${prereleaseId})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?![\\s\\S])`);
const manifestLimit = 64 * 1024;
type PackageCheck = { status: 'reported'; version: string } | {
  status: 'not-checked' | 'protected-location' | 'missing' | 'invalid'; version: null;
};

function checkPackage(dir: string | undefined, name: string, live: string[]): PackageCheck {
  if (dir === undefined) return { status: 'not-checked', version: null };
  try {
    guardLiveLexical(dir, live);
    const root = existingDir(dir, 'source-missing');
    guardLiveLexical(root.path, live);
    const manifest = parseJsonBytes(readUnder(root, 'package.json', manifestLimit));
    if (isObject(manifest) && manifest.name === name && typeof manifest.version === 'string' &&
        manifest.version.length <= 64 && semver.test(manifest.version)) {
      return { status: 'reported', version: manifest.version };
    }
  } catch (error) {
    if (error instanceof ToolError) {
      if (error.code === 'live-path-refused') return { status: 'protected-location', version: null };
      if (error.code === 'source-missing') return { status: 'missing', version: null };
    }
  }
  return { status: 'invalid', version: null };
}

export function preflight(npmArg: string | undefined, piArg: string | undefined,
  env: Record<string, string | undefined>, guard?: GuardContext) {
  const npmDir = npmArg === undefined ? undefined : requireAbsolute(npmArg, 'usage');
  const piDir = piArg === undefined ? undefined : requireAbsolute(piArg, 'usage');
  const live = npmDir !== undefined || piDir !== undefined ? liveLocations(env, guard) : [];
  const version = process.versions.node;
  const baselineMet = nodeBaselineMet(version);
  const npm = checkPackage(npmDir, 'npm', live);
  const pi = checkPackage(piDir, '@earendil-works/pi-coding-agent', live);
  const passes = (tool: PackageCheck) => tool.status === 'reported' || tool.status === 'not-checked';
  return {
    ok: baselineMet && passes(npm) && passes(pi),
    node: { version, status: baselineMet ? 'baseline-met' : 'below-baseline' },
    npm,
    pi: { ...pi, discoveryModel: DISCOVERY_MODEL, modelStatus: pi.version === null ? null :
      pi.version === DISCOVERY_MODEL.slice('pi@'.length) ? 'match' : 'discovery-model-stale' },
  };
}
