/** Diagnose resources from guarded, final bundle winners without authorizing readiness. */
import { analyzeDevKitModels } from './devkit-models.ts';
import { ToolError } from './errors.ts';
import { analyzeHerdrConfig } from './herdr-config.ts';
import { analyzeKeybindings } from './keybindings.ts';
import { preparePlan, type PlanOptions } from './plan.ts';
import { analyzeSkillDiscovery } from './skill-discovery.ts';
import { analyzeSkillEntries } from './skill-metadata.ts';

type ConfigAnalyzer = typeof analyzeKeybindings | typeof analyzeDevKitModels | typeof analyzeHerdrConfig;
const analyzers = new Map<string, ConfigAnalyzer>([
  ['keybindings.json', analyzeKeybindings],
  ['dev-kit/models.json', analyzeDevKitModels],
  ['herdr-agents/config.json', analyzeHerdrConfig],
]);

function unverified(reason: 'analysis-limit' | 'skill-namespace-conflict') {
  return { status: 'unverified', reason } as const;
}

export function diagnoseBundleResources(opts: PlanOptions) {
  const prepared = preparePlan(opts);
  const skills = prepared.files.filter(file => file.root === 'agent' && file.class === 'skill-source');
  const metadata = analyzeSkillEntries(skills);
  if (metadata.status === 'limit') return unverified('analysis-limit');
  let skillDiscovery: ReturnType<typeof analyzeSkillDiscovery>;
  try {
    skillDiscovery = analyzeSkillDiscovery(skills, prepared.settings.skills);
  } catch (error) {
    // Preparation already validated the rows and settings, but not the merged skill namespace.
    if (error instanceof ToolError && error.code === 'skill-discovery-input-invalid') {
      return unverified('skill-namespace-conflict');
    }
    throw error;
  }
  if (skillDiscovery.status === 'limit') return unverified('analysis-limit');
  const entries = metadata.entries.filter(entry => entry.status !== 'missing' || entry.reason !== 'entry-missing');
  const skillMetadata = { status: metadata.status, entries, missingEntries: metadata.entries.length - entries.length };
  const toolConfigs = prepared.files.flatMap(file => {
    if (file.root !== 'agent' || file.class !== 'tool-config') return [];
    const analyze = analyzers.get(file.path);
    return analyze ? [{ path: file.path, ...analyze(file.bytes) }] : [];
  });
  toolConfigs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: 'complete', skillMetadata, skillDiscovery, toolConfigs } as const;
}
