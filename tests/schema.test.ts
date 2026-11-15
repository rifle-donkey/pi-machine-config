import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { parseJsonBytes } from '../src/json.ts';
import {
  checkContent,
  checkFrontmatter,
  checkPlacement,
  isBuiltinThemeSetting,
  npmIdentity,
  packageDecl,
  parseManifest,
  parsePolicy,
  relPath,
  renderTemplate,
  resourceEntry,
  settingValue,
  TOOL_VERSION,
} from '../src/schema.ts';

it('TOOL_VERSION matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(TOOL_VERSION, pkg.version);
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ToolError, `expected ToolError, got ${String(e)}`);
    return e.code;
  }
  assert.fail('expected an error');
}

const policy = (layers: unknown, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: 'pi-machine-config/inclusion',
  layers,
  ...extra,
});

describe('npm package identities', () => {
  it('accepts registry names and removes capture-time suffixes only when allowed', () => {
    assert.equal(npmIdentity('npm:pi-lens', false), 'npm:pi-lens');
    assert.equal(npmIdentity('npm:@scope/pkg.name_x-1', false), 'npm:@scope/pkg.name_x-1');
    assert.equal(npmIdentity('npm:pi-lens@1.2.3', true), 'npm:pi-lens');
    assert.equal(npmIdentity('npm:@scope/pkg@latest', true), 'npm:@scope/pkg');
    assert.equal(npmIdentity('npm:pkg@1.0.0-beta.1+build', true), 'npm:pkg');
    assert.equal(code(() => npmIdentity('npm:pi-lens@1.2.3', false)), 'package-versioned');
  });

  it('rejects ranges, git, local, alias, URL and malformed sources', () => {
    for (const s of [
      'npm:pkg@^1.2.0',
      'npm:pkg@>=1',
      'npm:pkg@',
      'npm:Pkg',
      'npm:_pkg',
      'npm:@scope',
      'npm:@Scope/pkg',
      'npm:alias@npm:other',
      'git:github.com/a/b',
      'https://example.invalid/x.tgz',
      './local',
      '/abs/path',
      'npm:',
      `npm:${'a'.repeat(215)}`,
    ]) {
      assert.equal(code(() => npmIdentity(s, true)), 'package-unsupported', s);
    }
  });

  it('preserves object form, autoload and filter order', () => {
    const d = packageDecl({ source: 'npm:x@2', autoload: false, extensions: ['b.ts', '!a.ts'], skills: [] }, true);
    assert.deepEqual({ ...(d as object) }, { source: 'npm:x', autoload: false, extensions: ['b.ts', '!a.ts'], skills: [] });
    assert.equal(code(() => packageDecl({ source: 'npm:x', version: '1' }, true)), 'package-unsupported');
    assert.equal(code(() => packageDecl({ source: 'npm:x', autoload: 'no' }, true)), 'package-unsupported');
    assert.equal(code(() => packageDecl({ source: 'npm:x', extensions: ['/abs.ts'] }, true)), 'resource-path-absolute');
    assert.equal(code(() => packageDecl({ source: 'npm:x', extensions: ['../up.ts'] }, true)), 'resource-path-traversal');
  });
});

describe('resource entries', () => {
  it('keeps prefixes, signed exclusions and the reviewed built-in extensions', () => {
    for (const s of ['extensions/a.ts', '+skills/x', '-prompts/p.md', '!themes/*.json', 'builtin:mcp', '+builtin:tool-search', '-builtin:llama.cpp', '-builtin:codemode']) {
      assert.equal(resourceEntry(s, 'extensions'), s);
    }
    for (const s of ['skills/x', '-skills/y', '!skills/*.md']) assert.equal(resourceEntry(s, 'skills'), s);
  });

  it('refuses unknown built-ins, built-ins outside extensions and glob-excluded built-ins', () => {
    for (const [s, ctx] of [
      ['builtin:read', 'extensions'],
      ['-builtin:bash', 'extensions'],
      ['builtin:x', 'extensions'],
      ['builtin:MCP', 'extensions'],
      ['builtin:', 'extensions'],
      ['!builtin:mcp', 'extensions'],
      ['builtin:mcp', 'skills'],
      ['-builtin:mcp', 'prompts'],
      ['builtin:mcp', 'themes'],
      ['builtin:mcp', 'package-filter'],
    ]) {
      assert.equal(code(() => resourceEntry(s, ctx)), 'resource-builtin-unsupported', `${ctx} ${s}`);
    }
    assert.equal(code(() => settingValue('skills', ['builtin:mcp'])), 'resource-builtin-unsupported');
    assert.equal(code(() => packageDecl({ source: 'npm:x', extensions: ['builtin:mcp'] }, true)), 'resource-builtin-unsupported');
  });

  it('rejects absolute, home, traversal, backslash, template and empty entries', () => {
    const e = (s: string) => resourceEntry(s, 'extensions');
    assert.equal(code(() => e('/x')), 'resource-path-absolute');
    assert.equal(code(() => e('-/x')), 'resource-path-absolute');
    assert.equal(code(() => e('~/x')), 'resource-path-unsupported');
    assert.equal(code(() => e('a/../b')), 'resource-path-traversal');
    assert.equal(code(() => e('a\\b')), 'resource-entry-invalid');
    assert.equal(code(() => e('{{HOME}}/x')), 'resource-entry-invalid');
    assert.equal(code(() => e('-')), 'resource-entry-invalid');
  });
});

describe('typed settings allowlist', () => {
  it('accepts typed values', () => {
    assert.equal(settingValue('editorPaddingX', 3), 3);
    assert.equal(settingValue('defaultThinkingLevel', 'high'), 'high');
    assert.equal(settingValue('defaultThinkingLevel', 'max'), 'max');
    assert.deepEqual({ ...(settingValue('modelThinkingLevels', { 'p/m': 'max' }) as object) }, { 'p/m': 'max' });
    assert.equal(settingValue('tuiMode', 'regular'), 'regular');
    assert.equal(settingValue('tuiMode', 'fullscreen'), 'fullscreen');
    assert.equal(settingValue('theme', 'light/dark'), 'light/dark');
    assert.equal(settingValue('theme', 'my-theme'), 'my-theme');
    assert.deepEqual(settingValue('enabledModels', ['b', 'a', 'b']), ['b', 'a', 'b']);
    assert.deepEqual(settingValue('extensions', []), []);
    assert.deepEqual({ ...(settingValue('modelThinkingLevels', { m: 'low' }) as object) }, { m: 'low' });
  });

  it('rejects wrong types, ranges, unknown keys and excluded settings', () => {
    assert.equal(code(() => settingValue('editorPaddingX', 4)), 'setting-invalid');
    assert.equal(code(() => settingValue('editorPaddingX', 1.5)), 'setting-invalid');
    assert.equal(code(() => settingValue('fullscreenCopyOnSelect', 'true')), 'setting-invalid');
    assert.equal(code(() => settingValue('defaultThinkingLevel', 'maximum')), 'setting-invalid');
    assert.equal(code(() => settingValue('modelThinkingLevels', { m: 'huge' })), 'setting-invalid');
    for (const v of ['compact', 'Regular', '', 1]) assert.equal(code(() => settingValue('tuiMode', v)), 'setting-invalid', String(v));
    for (const v of ['a/b/c', '/dark', 'light/', ' dark']) assert.equal(code(() => settingValue('theme', v)), 'setting-invalid', v);
    assert.equal(code(() => settingValue('defaultModel', 'a\nb')), 'setting-invalid');
    assert.equal(code(() => settingValue('defaultModel', '')), 'setting-invalid');
    for (const k of ['packages', 'npmCommand', 'httpProxy', 'shellPath', 'sessionDir', 'lastChangelogVersion']) {
      assert.equal(code(() => settingValue(k, 'x')), 'setting-not-allowed', k);
    }
  });
});

describe('file paths and destination classes', () => {
  it('rejects unsafe relative paths', () => {
    for (const p of ['', '/abs', 'a//b', './a', 'a/../b', '.hidden/x', 'a/.git/config', 'a\\b', 'C:x', 'a\u0000b', 'a\nb', 'node_modules/x.js', 'x/debug.log', 'cafe\u0301.md', `${'a/'.repeat(32)}x`]) {
      assert.equal(code(() => relPath(p)), 'path-invalid', JSON.stringify(p));
    }
    assert.equal(relPath('skills/fc/SKILL.md'), 'skills/fc/SKILL.md');
  });

  it('maps classes only to their closed destinations', () => {
    checkPlacement('agent', 'AGENTS.md', 'agent-context', 'common');
    checkPlacement('agent', 'extensions/a/index.ts', 'extension-source', 'common');
    checkPlacement('agent', 'skills/fc/SKILL.md', 'skill-source', 'platform:darwin');
    checkPlacement('agent', 'prompts/review.md', 'prompt', 'common');
    checkPlacement('agent', 'themes/dark.json', 'theme', 'common');
    checkPlacement('agent', 'dev-kit/models.json', 'tool-config', 'common');
    checkPlacement('agent', 'sandbox.json', 'tool-config', 'overlay');
    checkPlacement('lens-config', 'config.json', 'external-config', 'overlay');
    const denied: [string, string, string, string][] = [
      ['agent', 'settings.json', 'tool-config', 'common'],
      ['agent', 'auth.json', 'tool-config', 'common'],
      ['agent', 'models.json', 'tool-config', 'common'],
      ['agent', 'SYSTEM.md', 'agent-context', 'common'],
      ['agent', 'agents.md', 'agent-context', 'common'],
      ['agent', 'sandbox.json', 'tool-config', 'common'],
      ['agent', 'keybindings.json', 'tool-config', 'overlay'],
      ['agent', 'AGENTS.md', 'agent-context', 'overlay'],
      ['agent', 'extensions', 'extension-source', 'common'],
      ['agent', 'skills/SKILL.md', 'skill-source', 'common'],
      ['agent', 'prompts/x/y.md', 'prompt', 'common'],
      ['agent', 'themes/x.txt', 'theme', 'common'],
      ['agent', 'bin/tool', 'extension-source', 'common'],
      ['agent', 'config.json', 'external-config', 'common'],
      ['lens-config', 'other.json', 'external-config', 'common'],
    ];
    for (const [root, p, cls, layer] of denied) {
      // @ts-expect-error deliberate invalid combinations
      assert.equal(code(() => checkPlacement(root, p, cls, layer)), 'destination-not-allowed', p);
    }
  });
});

describe('prohibited destinations', () => {
  const rule = (p: string, cls: string, root = 'agent') => ({ root, path: p, class: cls, template: false });
  const parse = (r: object, overlay = false) =>
    parsePolicy(overlay ? policy({}, { overlay: { files: [r] } }) : policy({ common: { files: [r] } }));

  it('refuses prohibited components and basenames whatever the declared class', () => {
    const cases: [string, string][] = [
      ['extensions/auth.json', 'extension-source'],
      ['extensions/x/auth-backup.json', 'extension-source'],
      ['extensions/settings.json', 'extension-source'],
      ['extensions/models.json', 'extension-source'],
      ['extensions/x/mcp.json', 'extension-source'],
      ['extensions/trust.json', 'extension-source'],
      ['extensions/x/credentials.json', 'extension-source'],
      ['extensions/x/secrets.yaml', 'extension-source'],
      ['extensions/key.pem', 'extension-source'],
      ['extensions/x/native.node', 'extension-source'],
      ['extensions/x/package-lock.json', 'extension-source'],
      ['extensions/x/yarn.lock', 'extension-source'],
      ['extensions/x/state.sqlite', 'extension-source'],
      ['extensions/x/cache/a.ts', 'extension-source'],
      ['extensions/x/bin/tool.sh', 'extension-source'],
      ['extensions/x/vendor/lib.js', 'extension-source'],
      ['extensions/SYSTEM.md', 'extension-source'],
      ['extensions/APPEND_SYSTEM.md', 'extension-source'],
      ['skills/example/sessions/run.jsonl', 'skill-source'],
      ['skills/example/logs/a.md', 'skill-source'],
      ['skills/example/tmp/a.md', 'skill-source'],
      ['skills/example/AGENTS.md', 'skill-source'],
      ['skills/example/CLAUDE.md', 'skill-source'],
      ['skills/example/AGENTS.override.md', 'skill-source'],
      ['AGENTS.override.md', 'agent-context'],
      ['AGENTS.MD', 'agent-context'],
      ['CLAUDE.md', 'agent-context'],
      ['CLAUDE.local.md', 'agent-context'],
      ['SYSTEM.md', 'agent-context'],
      ['APPEND_SYSTEM.md', 'agent-context'],
      ['models.json', 'tool-config'],
      ['mcp.json', 'tool-config'],
      ['auth.json', 'tool-config'],
      ['trust.json', 'tool-config'],
      ['settings.json', 'tool-config'],
      ['dev-kit/models.json', 'extension-source'],
      ['keybindings.json', 'agent-context'],
      ['prompts/AGENTS.md', 'prompt'],
      ['themes/settings.json', 'theme'],
    ];
    for (const [p, cls] of cases) assert.equal(code(() => parse(rule(p, cls))), 'path-prohibited', p);
    assert.equal(code(() => parse(rule('auth.json', 'tool-config'), true)), 'path-prohibited');
    // The same rules apply to bundle and overlay manifests before any payload is read.
    const rec = { root: 'agent', path: 'extensions/auth.json', class: 'extension-source', bytes: 1, sha256: '0'.repeat(64), template: false };
    const m = { schemaVersion: 1, layer: 'common', piDiscoveryModel: 'pi@1.5.2', settings: {}, packages: [], files: [rec] };
    assert.equal(code(() => parseManifest(m, 'common')), 'path-prohibited');
  });

  it('keeps the exact AGENTS, dev-kit, keybindings and sandbox exceptions only at their destination', () => {
    parse(rule('AGENTS.md', 'agent-context'));
    parse(rule('dev-kit/models.json', 'tool-config'));
    parse(rule('keybindings.json', 'tool-config'));
    parse(rule('herdr-agents/config.json', 'tool-config'));
    parse(rule('sandbox.json', 'tool-config'), true);
    parse(rule('config.json', 'external-config', 'lens-config'));
    assert.equal(code(() => parse(rule('sandbox.json', 'tool-config'))), 'destination-not-allowed');
  });

  it('closes extension and skill sources to simple names with text source suffixes', () => {
    parse(rule('extensions/hello.ts', 'extension-source'));
    parse(rule('extensions/pkg/index.mjs', 'extension-source'));
    parse(rule('skills/firecrawl/SKILL.md', 'skill-source'));
    parse(rule('skills/firecrawl/scripts/run.py', 'skill-source'));
    for (const [p, cls] of [
      ['extensions/image.png', 'extension-source'],
      ['extensions/noext', 'extension-source'],
      ['extensions/a b.ts', 'extension-source'],
      ['skills/x/archive.zip', 'skill-source'],
      ['skills/SKILL.md', 'skill-source'],
    ]) {
      assert.equal(code(() => parse(rule(p, cls))), 'destination-not-allowed', p);
    }
  });
});

describe('built-in theme names', () => {
  it('recognizes only Pi built-in themes and pairs of them', () => {
    for (const v of ['system', 'dark', 'light', 'light/dark']) assert.equal(isBuiltinThemeSetting(v), true, v);
    for (const v of ['custom', 'dark/custom', 'Dark']) assert.equal(isBuiltinThemeSetting(v), false, v);
  });
});

describe('inclusion policy', () => {
  it('accepts a minimal policy and defaults missing layers to empty', () => {
    const p = parsePolicy(policy({ common: { settings: ['theme'] } }));
    assert.deepEqual(p.layers.common.settings, ['theme']);
    assert.deepEqual(p.layers['platform:linux'].files, []);
    assert.deepEqual(p.overlay.packagesRemove, []);
  });

  it('rejects unknown fields, versions and kinds', () => {
    assert.equal(code(() => parsePolicy({ ...policy({}), extra: 1 })), 'policy-invalid');
    assert.equal(code(() => parsePolicy(policy({ overlay: {} }))), 'policy-invalid');
    assert.equal(code(() => parsePolicy(policy({ common: { secrets: [] } }))), 'policy-invalid');
    assert.equal(code(() => parsePolicy({ ...policy({}), schemaVersion: 2 })), 'schema-version-unsupported');
    assert.equal(code(() => parsePolicy({ ...policy({}), kind: 'other' })), 'policy-invalid');
    assert.equal(code(() => parsePolicy(policy({ common: { settings: ['npmCommand'] } }))), 'setting-not-allowed');
    assert.equal(code(() => parsePolicy(policy({ common: { packages: ['npm:a@1'] } }))), 'package-versioned');
    assert.equal(code(() => parsePolicy(policy({ common: { packages: ['npm:a', { source: 'npm:a' }] } }))), 'package-duplicate');
  });

  it('rejects template flags on code or instruction source and alias spellings', () => {
    const f = (root: string, p: string, cls: string, template = false) => ({ root, path: p, class: cls, template });
    assert.equal(code(() => parsePolicy(policy({ common: { files: [f('agent', 'extensions/a.ts', 'extension-source', true)] } }))), 'template-not-allowed');
    assert.equal(code(() => parsePolicy(policy({ common: { files: [f('agent', 'prompts/a.md', 'prompt', true)] } }))), 'template-not-allowed');
    assert.equal(
      code(() => parsePolicy(policy({ common: { files: [f('agent', 'prompts/a.md', 'prompt'), f('agent', 'prompts/A.md', 'prompt')] } }))),
      'path-alias',
    );
    assert.equal(
      code(() =>
        parsePolicy(policy({ common: { files: [f('agent', 'prompts/a.md', 'prompt')] }, 'platform:linux': { files: [f('agent', 'prompts/A.md', 'prompt')] } })),
      ),
      'path-alias',
    );
    assert.equal(code(() => parsePolicy(policy({ common: { files: [f('agent', 'prompts/a.md', 'prompt'), f('agent', 'prompts/a.md', 'prompt')] } }))), 'file-duplicate');
  });

  it('accepts overlay files and removals only for overlay destinations', () => {
    const p = parsePolicy(
      policy({}, { overlay: { files: [{ root: 'agent', path: 'sandbox.json', class: 'tool-config', template: true }], packagesRemove: ['npm:a'] } }),
    );
    assert.equal(p.overlay.files.length, 1);
    assert.equal(
      code(() => parsePolicy(policy({}, { overlay: { files: [{ root: 'agent', path: 'AGENTS.md', class: 'agent-context', template: false }] } }))),
      'destination-not-allowed',
    );
  });
});

describe('layer manifests', () => {
  const m = (layer: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    layer,
    piDiscoveryModel: 'pi@1.5.2',
    settings: {},
    packages: [],
    files: [],
    ...extra,
  });

  it('checks layer, discovery model and overlay restrictions', () => {
    parseManifest(m('common'), 'common');
    assert.equal(code(() => parseManifest(m('common'), 'platform:darwin')), 'manifest-layer-mismatch');
    assert.equal(code(() => parseManifest(m('common', { piDiscoveryModel: 'pi@9' }), 'common')), 'discovery-model-unsupported');
    assert.equal(code(() => parseManifest(m('common', { packagesRemove: [] }), 'common')), 'manifest-invalid');
    assert.equal(code(() => parseManifest(m('overlay', { settings: { theme: 'x' } }), 'overlay')), 'overlay-setting-not-allowed');
    assert.equal(code(() => parseManifest(m('overlay', { packages: ['npm:a'] }), 'overlay')), 'overlay-package-not-allowed');
    assert.equal(code(() => parseManifest(m('common', { settings: { npmCommand: ['x'] } }), 'common')), 'setting-not-allowed');
  });

  it('enforces per-file and per-layer size bounds', () => {
    const rec = (i: number, bytes: number) => ({ root: 'agent', path: `prompts/p${i}.md`, class: 'prompt', bytes, sha256: '0'.repeat(64), template: false });
    assert.equal(code(() => parseManifest(m('common', { files: [rec(0, 1024 * 1024 + 1)] }), 'common')), 'manifest-invalid');
    const files = Array.from({ length: 17 }, (_, i) => rec(i, 1024 * 1024));
    assert.equal(code(() => parseManifest(m('common', { files }), 'common')), 'layer-too-large');
  });
});

describe('payload content', () => {
  const rule = { class: 'agent-context' as const, template: false };

  it('rejects invalid UTF-8 and NUL bytes', () => {
    assert.equal(code(() => checkContent(rule, Buffer.from([0xc3, 0x28]))), 'content-invalid');
    assert.equal(code(() => checkContent(rule, Buffer.from('a\0b'))), 'content-invalid');
  });

  it('parses JSON classes strictly', () => {
    assert.equal(code(() => checkContent({ class: 'theme', template: false }, Buffer.from('{"a":1,"a":2}'))), 'json-duplicate-key');
  });

  it('allows only exact known template tokens', () => {
    const t = { ...rule, template: true };
    checkContent(t, Buffer.from('home {{HOME}} agent {{AGENT_DIR}} {single} braces'));
    for (const bad of [
      '{{USER}}',
      '{{HOME',
      'HOME}}',
      '{{USER',
      'x {{ HOME }}',
      '{{{{HOME}}}}',
      '{{{HOME}}',
      '{{HOME}}}',
      '{{HO{{HOME}}ME}}',
      '{{}}',
      'a }} b',
    ]) {
      assert.equal(code(() => checkContent(t, Buffer.from(bad))), 'template-unresolved', bad);
    }
    // Non-template files keep token-like text verbatim.
    checkContent(rule, Buffer.from('{{USER}} {{HOME'));
  });

  it('checks JSON templates inside strings and after rendering', () => {
    const j = { class: 'tool-config' as const, template: true };
    // Structural `}}` of nested objects is ordinary JSON.
    checkContent(j, Buffer.from('{"a":{"b":"{{HOME}}/x","c":{}}}'));
    for (const bad of ['{"a":"{{HOME"}', '{"a":"HOME}}"}', '{"{{USER}}":1}', '{"a":"{{HO\\u004dE}}"}', '{"a":"\\u007b\\u007bHOME}}"}']) {
      assert.equal(code(() => checkContent(j, Buffer.from(bad))), 'template-unresolved', bad);
    }
    // A rendered value that would leave template syntax behind is refused.
    assert.equal(code(() => renderTemplate('external-config', '{"p":"{{HOME}}"}', { HOME: '/h/{{x}}', AGENT_DIR: '/a' })), 'template-unresolved');
    assert.equal(code(() => renderTemplate('agent-context', 'p {{HOME}}', { HOME: '/h/}}', AGENT_DIR: '/a' })), 'template-unresolved');
  });

  it('renders text literally and JSON with escaping', () => {
    const vals = { HOME: '/h/a"b\\c', AGENT_DIR: '/h/agent' };
    assert.equal(Buffer.from(renderTemplate('agent-context', 'x {{HOME}} {{AGENT_DIR}}', vals)).toString(), 'x /h/a"b\\c /h/agent');
    const out = Buffer.from(renderTemplate('external-config', '{"p":"{{HOME}}/x"}', vals));
    assert.deepEqual({ ...(parseJsonBytes(out) as object) }, { p: '/h/a"b\\c/x' });
  });
});

describe('frontmatter expectations', () => {
  const expect = { frontmatter: { 'disable-model-invocation': true as boolean | string } };

  it('accepts a simple manual-only skill', () => {
    checkFrontmatter('---\nname: firecrawl\ndescription: >\n  long text\n  more\ndisable-model-invocation: true\n---\nbody\n', expect);
    checkFrontmatter('---\nname: "x"\n---\n', { frontmatter: { name: 'x' } });
  });

  it('fails when the expectation is absent or different', () => {
    assert.equal(code(() => checkFrontmatter('---\nname: x\n---\n', expect)), 'expectation-failed');
    assert.equal(code(() => checkFrontmatter('---\ndisable-model-invocation: false\n---\n', expect)), 'expectation-failed');
    assert.equal(code(() => checkFrontmatter('---\ndisable-model-invocation: True\n---\n', expect)), 'expectation-failed');
  });

  it('fails closed on unsupported or ambiguous syntax', () => {
    const bad = [
      'no frontmatter',
      '---\ndisable-model-invocation: true\n',
      '---\r\ndisable-model-invocation: true\r\n---\r\n',
      '---\ndisable-model-invocation: true\ndisable-model-invocation: false\n---\n',
      '---\ndisable-model-invocation: true\n  continued\n---\n',
      '---\n"disable-model-invocation": true\n---\n',
      '---\ndisable-model-invocation: !!bool true\n---\n',
      '---\ndisable-model-invocation: true # comment\n---\n',
      '---\n\tdisable-model-invocation: true\n---\n',
      '---\n  disable-model-invocation: true\n---\n',
    ];
    for (const t of bad) assert.equal(code(() => checkFrontmatter(t, expect)), 'frontmatter-unsupported', JSON.stringify(t));
  });
});
