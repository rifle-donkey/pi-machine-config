# pi-machine-config

A private project for portable Pi configuration across macOS and Linux.

## Contents

- [Status](#status)
- [Safety rules](#safety-rules)
- [Capture a bundle and plan a new-target restore](#capture-a-bundle-and-plan-a-new-target-restore)
- [Apply a fixture restore](#apply-a-fixture-restore)
- [Inspect, roll back and recover](#inspect-roll-back-and-recover)
- [Reference](#reference)
  - [Commands](#commands)
  - [Output and exit status](#output-and-exit-status)
  - [Capture review and inclusion approval](#capture-review-and-inclusion-approval)
  - [Inclusion policy](#inclusion-policy)
  - [Bundle layout and layer manifests](#bundle-layout-and-layer-manifests)
  - [Machine overlay](#machine-overlay)
  - [Plan classifications and approval token](#plan-classifications-and-approval-token)
  - [Limits](#limits)

## Status

Six fixture-only commands are available: `capture-review`, `capture`, `plan`, `apply`, `rollback` and `recover`. Capture and activation each require their own matching review token. Apply creates a new target from a complete ready plan; rollback and recovery act only on proven owned configuration. Package installation, full resource discovery and real-machine operation remain unavailable. The [implementation plan](docs/plans/portable-config.md) defines the remaining behavior.

Every command protects `.pi` and `.pi-lens` under both the account-database home and any absolute `$HOME` selected by Pi, plus `$PI_CODING_AGENT_DIR`. Changing `$HOME` never removes account-home protection. This release therefore works only with fixture directories, not with a live Pi installation. To also catch symlinked aliases of those locations, each command resolves their real paths. That queries path metadata (whether they exist and where symlinks point); it never opens or reads anything inside them.

The commands run directly from a checkout with Node's built-in TypeScript support and have no dependencies. They are tested with Node 26; the intended Node 24 baseline is not yet verified.

## Safety rules

- Do not copy all of `~/.pi`; credentials, trust records, sessions, caches and installed dependencies are not portable configuration.
- Do not apply unreviewed configuration or resource source code to a working Pi installation.
- Keep machine-specific paths and permission settings local and untracked.
- Git commits, pushes, package installations and real-machine restoration require separate approval.
- Review the inclusion policy before every capture, and make sure you are permitted to read every source it lists; the tool cannot judge that for you. A policy lists what is read; it is not, by itself, user approval to capture or activate anything.
- Run `capture` only with the token that `capture-review` printed for the inputs you reviewed. The bundle records that token as your capture consent.
- Treat captured resources as executable, untrusted input. A file digest proves integrity only, not authenticity or secrecy.
- An approval token identifies what was reviewed. It is not a signature and does not prove who approved it; anyone who can rewrite a bundle can also rewrite its approval record.

Development instructions and document ownership: [AGENTS.md](AGENTS.md).

## Capture a bundle and plan a new-target restore

1. Write an inclusion policy that lists every setting key, package declaration and file to capture ([Inclusion policy](#inclusion-policy)). Keep it outside the source agent directory.
2. Run `capture-review` ([Commands](#commands)). It reads only the listed items, refuses the whole capture on the first unsupported or unexpected input, writes nothing, and prints per-layer counts and a `captureReviewToken`.
3. Check the counts against the policy you reviewed. If they match what you intend to capture, run `capture` with the same arguments, an absolute output path that does not exist yet and whose parent does, and `--approve-inclusion <captureReviewToken>`. If any listed input changed since the review, `capture` refuses with `inclusion-approval-mismatch` and creates nothing; review again.
4. Check that the bundle contains `manifests/complete.json`. A bundle without it is incomplete (for example after an interrupted capture) and every command refuses it; capture a new bundle to a new path.
5. Optionally write a machine overlay for local-only files and package removals ([Machine overlay](#machine-overlay)).
6. Run `plan` for the target platform and a target agent path that does not exist yet. Review the classifications. Only a `ready` plan prints an approval token; `incomplete` and `conflict` plans print none.

## Apply a fixture restore

1. Complete the capture and plan procedure above. Keep Pi and editors stopped; the tool cannot prove that no Pi process is running.
2. Review the exact ready plan and its `approvalToken`. Applying configuration is activation: package declarations can download code and run install scripts on the next Pi start or reload, even though apply itself invokes no Pi or network operation. Local instructions and resources can also load at startup. Do not start Pi until apply reports success.
3. Choose an absent absolute state-directory path whose parent exists, outside the checkout, bundle, overlay, agent and lens targets. Existing targets and state directories are refused, even empty or identical ones.
4. Run `apply` from the command reference with the same bundle, platform, overlay and targets, plus the state path and exact `--approve-activation` token. It recompiles under the state lock before the first journal or target write. A changed intent refuses without target writes. A late refusal may retain a private empty state directory; it is not automatically deleted or reused.
5. Save the returned transaction ID and state path. Never commit runtime state. Backups, journals and lock metadata can be private. No automatic package installation runs during this command.

Only a `ready` plan can activate. Incomplete schema, dependency or resource checks still block application. This does not make unimplemented adapters available or authorize a real restore.

## Inspect, roll back and recover

1. Use `recover --inspect` with the original state path, `--target-agent` and, when present, `--lens-config`. The target context must match the private journal before any target access. Inspection is read-only and never breaks locks.
2. To undo owned unchanged configuration, run `rollback` with the same context and exact `--tx`. The whole dependency group is preflighted; changed or replaced output refuses cleanup. Directories, package installations, runtime files and unknown files remain. Repetition never removes a later replacement.
3. After an interruption, inspect first. Use `recover --resolve` only with the reported transaction ID, exact current `--expect` class and an offered `--action`. A stale classification refuses rather than retrying automatically. A successful resolution reports `previousClass`; inspect again for the current state.
4. Locks require proven stale ownership; no force or automatic breaking exists. Missing boot identity, a live or unprovable owner, corrupt state or unknown identity requires stopping and separately reviewed manual recovery. Do not edit a journal or blindly delete locks/state. `PI_OFFLINE=1` stops missing-package auto-installation, not execution of already installed extensions.

| Inspection class | Offered action or next step |
|---|---|
| `gate-stale`, `lock-stale` | `release-gate`, `release-lock` respectively; exact stale proof is rechecked |
| `unfinished` | `abandon`; foreign destinations and unproven orphan stages remain |
| `published-unfinished` | `finalize`, then inspect and request rollback if desired |
| `unfinalized` | `finalize` |
| `applied`, `partial`, `rollback-pending` | `rollback` |
| `conflict` | `record-conflict` preserves unproven outputs; it does not repair them |
| `rolled-back`, `closed`, `preserved` | Terminal history; no automatic cleanup of replacements |
| `corrupt`, held or unprovable locks | No automated action; retain evidence and stop |

Moving target parents can make even terminal inspection refuse. Rollback retains the agent directory, so applying again to the same path requires a separately approved removal or a new target. A failed lock release can retain its intent and consume a bounded recovery slot. No power-loss or hostile same-user pathname-race guarantee is claimed.

## Reference

### Commands

Run from the repository root. All paths must be absolute.

```bash
node src/cli.ts capture-review --policy <file> --source-agent <dir> --platform <darwin|linux> [--source-lens-config <file>]
node src/cli.ts capture --policy <file> --source-agent <dir> --platform <darwin|linux> --out <new-dir> --approve-inclusion <token> [--source-lens-config <file>]
node src/cli.ts plan --bundle <dir> --platform <darwin|linux> --target-agent <new-dir> [--overlay <dir>] [--lens-config <new-file>]
node src/cli.ts apply --bundle <dir> --platform <darwin|linux> --target-agent <new-dir> --state-dir <new-dir> --approve-activation <token> [--overlay <dir>] [--lens-config <new-file>]
node src/cli.ts rollback --state-dir <dir> --target-agent <dir> --tx <id> [--lens-config <file>]
node src/cli.ts recover --state-dir <dir> --target-agent <dir> --inspect [--lens-config <file>]
node src/cli.ts recover --state-dir <dir> --target-agent <dir> --resolve --tx <id> --expect <class> --action <action> [--lens-config <file>]
```

`capture-review` and `capture` options:

| Option | Meaning |
|---|---|
| `--policy` | Inclusion policy file. Must not be inside the source agent directory. |
| `--source-agent` | Source agent directory. Only `settings.json` (when the policy lists settings or packages) and the listed files are read, and only after the whole policy has been validated. |
| `--platform` | Platform of the source. The policy's other platform layer must be empty. |
| `--source-lens-config` | Source lens configuration file. Required exactly when the policy lists the `lens-config` file. Must not be inside the source agent directory. |
| `--out` | `capture` only. New bundle directory. It must not exist, no case or Unicode-normalization alias of it may exist in its parent, and its parent must exist. |
| `--approve-inclusion` | `capture` only, required. The `captureReviewToken` that `capture-review` printed for these inputs ([Capture review and inclusion approval](#capture-review-and-inclusion-approval)). |

`plan` options:

| Option | Meaning |
|---|---|
| `--bundle` | A complete bundle directory. |
| `--platform` | Platform layer to merge. Either platform may be planned offline. |
| `--target-agent` | New agent directory. It must not exist; its parent must. |
| `--overlay` | Optional machine overlay directory. |
| `--lens-config` | New lens configuration file. Required exactly when the merged intent contains the `lens-config` file. |

`apply` uses the `plan` options plus required `--state-dir` and `--approve-activation`. Its platform must match the running host. `rollback` and both `recover` modes require the original `--state-dir` and `--target-agent`; a restored lens target also requires its matching `--lens-config`. `--inspect` and `--resolve` are mutually exclusive presence flags, not values. Only resolve accepts `--tx`, `--expect` and `--action`, and requires all three. Internal guard, dependency and fault options are never accepted.

Supplied paths may have symlinked ancestors; the supplied path itself must not be a symlink. The bundle, overlay, agent target and lens target must not contain one another; `capture` likewise keeps its output apart from its inputs.

### Output and exit status

| Exit | Meaning | Output |
|---|---|---|
| `0` | Success: review/capture, ready plan, completed mutation, or inspection of `applied`, `rolled-back` or `closed` history | JSON on stdout |
| `1` | Conflict or operational failure, incomplete plan, or inspection requiring recovery/manual attention | Plan/inspection JSON on stdout, or an error on stderr |
| `2` | Invalid input or invocation | Error on stderr |

Errors are `{"ok":false,"error":"<code>"}`, sometimes with a `layer` field. Output contains approved relative item paths and transaction IDs, never configuration values, rejected input, absolute paths, file contents or subprocess output. `capture-review` and a successful `capture` report per-layer counts and how many unlisted settings keys and supported packages were skipped; `capture-review` also prints `captureReviewToken`.

Codes you may need to act on:

| Code | Exit | Meaning |
|---|---|---|
| `live-location-unavailable` | `1` | A protected root cannot be safely resolved, a defined `HOME` is not a nonempty absolute path, or a nonempty `PI_CODING_AGENT_DIR` is not a valid absolute path. Check the configured directory and metadata access before retrying; the tool does not change permissions. Missing roots remain protected through both their supplied path and resolved existing ancestors; dangling or unresolvable aliases are refused. |
| `inclusion-approval-required` | `2` | `capture` was run without `--approve-inclusion`. |
| `approval-token-invalid` | `2` | The supplied token is not `sha256:<64 lowercase hex>`. |
| `activation-approval-required` | `2` | Apply requires the explicit reviewed plan token. |
| `activation-approval-mismatch`, `plan-not-ready` | `1` | The current complete ready intent no longer matches the activation token, or the plan cannot activate. No target configuration is created. |
| `target-context-mismatch` | `1` | The target flags do not match the transaction; target access is refused. |
| `tx-mismatch`, `expect-mismatch`, `rollback-conflict` | `1` | Transaction, observed class or owned output changed; inspect before another explicit action. |
| `inclusion-approval-mismatch` | `1` | The inputs no longer match the reviewed token; nothing was created. |
| `inclusion-approval-missing`, `inclusion-approval-digest-mismatch`, `inclusion-approval-invalid`, `inclusion-approval-bundle-mismatch` | `2` | The bundle's approval record is absent, altered, inconsistent, or does not describe this bundle. |
| `output-exists`, `output-alias-exists`, `output-parent-missing` | `1` | The capture output exists, has a case or normalization alias in its parent, or has no parent. |
| `write-failed` | `1` | Writing or syncing the bundle failed. A partly written bundle has no completion marker and is refused; capture again to a new path. |
| `path-prohibited` | `2` | A file entry names a prohibited path ([Inclusion policy](#inclusion-policy), Files). |
| `resource-builtin-unsupported` | `2` | A `builtin:` value other than the reviewed built-in extensions, or outside `extensions`. |
| `template-unresolved` | `2` | Template syntax other than exactly `{{HOME}}` or `{{AGENT_DIR}}`. |

### Capture review and inclusion approval

The capture-review token is `sha256:<64 hex>` over a versioned, domain-separated canonical JSON description of what `capture` would write: the tool version and Pi discovery model, the source platform, the SHA-256 of the exact policy bytes, and all three layer manifests (the projected settings values, the ordered package declarations with filters and `autoload`, and each selected file's root, path, class, template flag, expectation, size and SHA-256). Any change to those inputs yields a different token; changes to unlisted settings or packages do not.

`capture` recomputes the description before creating the output and refuses a different token. The bundle stores the supplied token and the description in `manifests/inclusion-approval.json`, and the completion marker records that file's digest. Every `plan` requires the record, recomputes its token, and checks that the description matches the bundle's policy bytes and layer manifests. The record documents your explicit capture consent; it is not a signature and does not authenticate anyone.

### Inclusion policy

`manifests/inclusion.json` in the bundle is the policy file captured byte for byte. Unknown fields, duplicate keys, a byte order mark and unsafe numbers are rejected everywhere.

```json
{
  "schemaVersion": 1,
  "kind": "pi-machine-config/inclusion",
  "layers": {
    "common": {
      "settings": ["defaultProvider", "editorPaddingX"],
      "packages": ["npm:pi-lens", { "source": "npm:@scope/tools", "autoload": false, "extensions": ["dist/a.ts"] }],
      "files": [
        { "root": "agent", "path": "AGENTS.md", "class": "agent-context", "template": true },
        { "root": "agent", "path": "skills/firecrawl/SKILL.md", "class": "skill-source", "template": false,
          "expect": { "frontmatter": { "disable-model-invocation": true } } }
      ]
    },
    "platform:darwin": { "settings": ["theme"] },
    "platform:linux": {}
  },
  "overlay": {
    "files": [{ "root": "agent", "path": "sandbox.json", "class": "tool-config", "template": false }],
    "packagesRemove": ["npm:pi-lens"]
  }
}
```

**Layers.** `common`, `platform:darwin` and `platform:linux`, each with optional `settings`, `packages` and `files`. Missing layers are empty.

**Settings.** Exact keys from this allowlist; every listed key must exist in the source `settings.json`:

| Key | Type |
|---|---|
| `defaultProvider`, `defaultModel` | Non-empty single-line string |
| `theme` | A theme name, or `<light>/<dark>` for automatic mode |
| `tuiMode` | `regular` or `fullscreen` |
| `defaultThinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `enabledModels`, `defaultTools` | Array of strings |
| `modelThinkingLevels` | Object mapping model names to a thinking level |
| `editorPaddingX` | Integer 0–3 |
| `fullscreenCopyOnSelect`, `showCacheMissNotices` | Boolean |
| `extensions`, `skills`, `prompts`, `themes` | Array of resource selections |

A resource selection keeps an optional `+`, `-` or `!` prefix and is a relative path or, in `extensions` only, one of Pi's built-in extensions `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode` or `builtin:tool-search` (without the `!` prefix). Any other `builtin:` value is refused. Capture converts absolute paths inside the source agent directory to agent-relative paths and refuses absolute paths elsewhere, `~` paths and `..`. Settings never contain `{{` template tokens.

**Packages.** Registry npm declarations only: `npm:<name>` or `npm:@<scope>/<name>`, unversioned, as a string or an object with `source`, optional boolean `autoload`, and optional ordered string arrays `extensions`, `skills`, `prompts`, `themes`. Each source declaration must equal its policy entry exactly after a simple version or tag suffix (letters, digits, `.`, `_`, `+`, `-`) is removed: same form, same `autoload`, same filters in the same order. Capture keeps the source order. Any unsupported package in the source settings (git, local, URL, alias or range) stops the capture.

**Files.** `root`, `path`, `class`, `template`, optional `expect` and optional `sha256` (64 lowercase hex digits that the captured bytes must match). Allowed destinations:

| `class` | `root` and `path` | Layers |
|---|---|---|
| `agent-context` | `agent`, `AGENTS.md` | common, platform |
| `extension-source` | `agent`, `extensions/...` | common, platform |
| `skill-source` | `agent`, `skills/<name>/...` | common, platform |
| `prompt` | `agent`, `prompts/<name>.md` | common, platform |
| `theme` | `agent`, `themes/<name>.json` | common, platform |
| `tool-config` | `agent`, `keybindings.json`, `dev-kit/models.json` or `herdr-agents/config.json` | common, platform |
| `tool-config` | `agent`, `sandbox.json` | overlay only |
| `external-config` | `lens-config`, `config.json` | any |

Paths are NFC, use `/`, and have no empty, `.`, `..` or dot-prefixed components, backslashes, colons, control characters, `node_modules` components or `.log` files. Two destinations that differ only by case or Unicode normalization are refused. `extension-source` and `skill-source` paths use simple names (letters, digits, `.`, `_`, `-`) and end in `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`, `.md`, `.txt`, `.yaml`, `.yml`, `.py` or `.sh`. Payloads are UTF-8 text without NUL bytes; `theme`, `tool-config` and `external-config` payloads must be strict JSON.

Whatever the class, these paths are refused with `path-prohibited` while the policy is validated, before any source file is opened (names compare case-insensitively):

- Settings, credentials and trust: `settings.json`; `auth.json` and `trust.json` and variants such as `auth-backup.json`; `credential`, `credentials`, `secret` or `secrets`, alone or followed by `.`, `_` or `-`; private keys and certificates (`id_rsa*`, `id_ed25519*` and similar, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`).
- MCP and root model definitions: `mcp.json` and its variants, `models.json`.
- Context files and system prompts anywhere: a `.md` file whose name is `AGENTS`, `CLAUDE`, `SYSTEM` or `APPEND_SYSTEM`, or starts with one of them followed by a dot (for example the `AGENTS.override` and `CLAUDE.local` variants).
- Locks, logs, sessions and runtime data: `*.lock`, `*.lockb`, `*.lck`, `*.pid`, `*.sock`, `*.log`, `*.log.<n>`, `*.jsonl`, `*.sqlite`, `*.sqlite3`, `*.db`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`.
- Binaries: `*.node`, `*.so`, `*.dylib`, `*.dll`, `*.exe`, `*.wasm`, `*.bin`.
- Any path component `node_modules`, `bower_components`, `jspm_packages`, `vendor`, `__pycache__`, `venv`, `site-packages`, `bin`, `sessions`, `session`, `cache`, `caches`, `logs`, `log`, `tmp`, `temp`, `locks`, `run` or `trash`.

The only exceptions are the exact destinations in the table above: `AGENTS.md` as `agent-context`, `keybindings.json`, `dev-kit/models.json` and the overlay `sandbox.json` as `tool-config`.

`template: true` is allowed only for `agent-context`, `tool-config` and `external-config`. A template may contain only the exact tokens `{{HOME}}` and `{{AGENT_DIR}}`: any other `{{`, `}}` (unknown, unclosed, nested or brace-adjacent tokens) is refused. In JSON payloads the rule applies inside every string, and a token may appear only there. After rendering, no `{{` or `}}` may remain. `plan` substitutes the target account-database home directory and the canonical target agent path in memory, escaping them in JSON. Nothing is shell-expanded.

`expect.frontmatter` maps keys to required `true`, `false` or string values. The frontmatter reader is deliberately narrow: top-level `key: value` lines, with block or nested values allowed only for keys that are not checked. Any other syntax makes the file unsupported.

**Overlay section.** `overlay.files` lists the overlay files a machine overlay may contain; `overlay.packagesRemove` lists the package identities it may remove.

### Bundle layout and layer manifests

```
manifests/inclusion.json            policy (exact bytes)
manifests/inclusion-approval.json   recorded capture approval
manifests/complete.json             completion marker, written last
config/common/manifest.json
config/common/files/<root>/<path>
config/platforms/darwin/manifest.json and files/...
config/platforms/linux/manifest.json and files/...
```

Capture creates directories with mode `0700` and files with mode `0600`, syncs the output's parent directory after creating the bundle root, writes payloads first, re-reads and verifies them, then writes the policy, the manifests and the approval record, and finally the completion marker. The marker records the SHA-256 digests of the policy, the approval record and all three layer manifests; `plan` rechecks them, revalidates the approval record ([Capture review and inclusion approval](#capture-review-and-inclusion-approval)) and rechecks every selected payload's size and digest.

A layer manifest:

```json
{
  "schemaVersion": 1,
  "layer": "common",
  "piDiscoveryModel": "pi@1.5.2",
  "settings": { "editorPaddingX": 2 },
  "packages": ["npm:pi-lens"],
  "files": [{ "root": "agent", "path": "AGENTS.md", "class": "agent-context", "bytes": 42,
              "sha256": "<64 hex>", "template": true }]
}
```

A bundle layer manifest must hold exactly the policy's settings keys, package declarations and file rules for that layer.

### Machine overlay

An overlay is a directory outside the bundle with `manifest.json` (as above, with `"layer": "overlay"` and an optional `packagesRemove` array) and payloads under `files/<root>/<path>`. Its `settings` must be `{}` and its `packages` must be `[]`. Its files must match entries in the policy's `overlay.files`, and each removal must be listed in `overlay.packagesRemove` and present in the merged packages. Removing a declaration does not uninstall anything.

`plan` merges `common`, then the selected platform, then the overlay:

- Settings replace whole top-level values; an omitted key inherits and an empty array replaces.
- A later package declaration replaces an earlier one with the same identity in its first-seen position; new identities are appended.
- A later file replaces an earlier one with the same destination.
- Arrays are never sorted or deduplicated.

### Plan classifications and approval token

Each plan item is a `setting`, `package`, `file` or `target` with one operation:

| Operation | Meaning |
|---|---|
| `create` | Written as configuration with no code or instruction activation |
| `activation-required` | Loads code, instructions, tools or packages at the next Pi start: package declarations, `defaultTools`, resource selections, `agent-context`, `prompt`, `extension-source`, `skill-source` |
| `incomplete` | A check this release cannot perform yet; the `reason` names it |
| `conflict` | The target cannot be created as a new target; the `reason` names it |

Current `incomplete` reasons:

- `dependency-analysis-unavailable`: `extension-source` and `skill-source` files (imports, local dependencies and executable bits are not checked yet).
- `schema-adapter-unavailable`: `theme`, `tool-config` and `external-config` files. Strict JSON alone does not make a valid Pi theme or tool configuration.
- `resource-reference-unverified`: a resource selection that activates a local path. Built-in extension values and `-`/`!` exclusions are accepted.
- `theme-reference-unverified`: a `theme` setting that names a custom theme rather than `system`, `dark` or `light`.

`conflict` reasons are `target-exists` (anything, including an empty directory or a dangling symlink), `target-alias-exists` (a case or Unicode-normalization alias of the target exists) and `target-parent-missing`. An existing target is never adopted or overwritten.

Plan status is `conflict` if any item conflicts, otherwise `incomplete` if any item is incomplete, otherwise `ready`. Only a `ready` plan has `approvalToken` `sha256:<64 hex>`. The token covers the policy, completion marker (and through it the approval record) and layer manifest digests, the selected platform, the overlay manifest digest, the merged settings, the ordered package declarations with filters and `autoload`, every file's class, template flag, canonical target path and rendered digest, the canonical targets, the Pi discovery model and the tool version. Any change to these yields a different token.

### Limits

| Item | Limit |
|---|---|
| JSON or text file | 1 MiB |
| Payload per layer | 16 MiB |
| Selected bundle payload (common plus one platform) | 48 MiB |
| Path depth | 32 components |
| Array items; string length | 4096 |
| JSON nesting | 64 levels |

The JSON file limit also applies to the inclusion-approval record `manifests/inclusion-approval.json`, which embeds all three layer manifests. It can exceed 1 MiB while every input and manifest fits, for example when a large setting is selected in both the common and the platform layer. `capture-review` and `capture` check the exact record before printing a token or creating output, and refuse with `inclusion-approval-too-large` (exit `2`); select fewer or smaller settings or file entries.

Every file the commands read, and every directory below a supplied root, must be a regular file or a real directory: no symlinks, special files or hard-linked files.
