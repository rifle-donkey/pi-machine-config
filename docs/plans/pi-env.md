# Plan: Lightweight Pi environment scan and deploy

Status: Accepted
Updated: 2026-11-23

## Problem and scope

The first design (`portable-config.md`) restores configuration as a transaction against untrusted input. It is too heavy for the actual need: one person moves their own Pi environment to a new macOS or Linux machine.

New goal: two commands.

- `scan` runs on the current host. It reads the Pi ecosystem read-only and writes one archive: a manifest plus copies of user-level files.
- `deploy` runs on a new host where Pi is already installed with the official installer. It shows a preview by default and applies it only with `--yes`. It installs tools, global npm packages and Pi packages from the manifest, then writes the files.

User decisions (2026-11-23): restart in this repository and archive the current code with a tag; one `.tar.gz` archive, transferred by the user; preview first, execute only after confirmation; Pi and its Node must already be installed on the new host; this project's `deploy` installs the Pi packages listed in the manifest.

Not included: credentials, sessions, Pi installation, Node installation, Git delivery of the archive, Windows, merging two configurations.

## Observed source host (2026-11-23, names and metadata only)

| Location | Entries | Treatment |
|---|---|---|
| `~/.pi/agent` user files | `AGENTS.md`, `settings.json`, `extensions/` (3 directories, 2 files), `skills/` (29), `keybindings.json` if present, `models.json`, `sandbox.json`, `dev-kit/models.json`, `herdr-agents/config.json` | Copy |
| `~/.pi/agent` secrets | `auth.json`, `INGKA_PAT` (token file whose name matches no generic pattern), `models-store.json` (mode 0600), `pi-herdr.json` (mode 0600), `trust.json` | Never copy |
| `~/.pi/agent` runtime and installed code | `install/`, `bin/` (managed `pi`, `rg`, `fd`), `npm/`, `sessions/`, `sessions.bak-*`, `web-search-cache/`, `mcp-*.json`, `pi-web-access/`, `dev-kit/cost-log.md`, `herdr-agents/outcomes.jsonl`, `*.bak-*`, empty `agents/` and `optional/` | Never copy |
| `~/.pi/agent/memory` | Git repository, remote `git@github-personal:rifle-donkey/pi-agent-memory.git` | Record remote; clone at deploy |
| Pi packages | 14 entries in `settings.json` `packages`, two with resource filters; installed versions in `npm/package.json` and its lock file | Record; install at deploy |
| `~/.pi-lens` | `config.json` user file; `tools/` (basedpyright, htmlhint, markdownlint-cli2, typescript, vscode-langservers-extracted); logs, caches, locks, sessions, backups | Copy `config.json`; record `tools/` packages; skip the rest |
| PATH tools | node, npm, gh, git, uv, python3, brew, typescript-language-server | Record |
| Global npm | codex, qmd, bash-language-server, firecrawl-cli, typescript, typescript-language-server, yaml-language-server | Record; install at deploy |

`~/.agents` is still denied by the sandbox and was not inspected.

## Archive format

```
pi-env-<host>-<date>.tar.gz
  manifest.json
  files/agent/<path>
  files/pi-lens/<path>
```

`manifest.json` (schema version 1):

| Field | Content |
|---|---|
| `source` | Platform, architecture, scan time, Pi version, install method |
| `runtimes` | Node and npm versions (informational) |
| `piPackages` | The `packages` array from `settings.json`, exactly as written, plus each package's installed version |
| `files` | Each copied file: root, relative path, size, SHA-256, mode, `templated` flag |
| `gitDirs` | Agent subdirectories that are Git repositories: path, remote URL, branch. Contents are not copied |
| `npmGlobals` | Name and version from `npm ls -g --depth=0 --json`, excluding `npm` itself |
| `lensTools` | Packages in `~/.pi-lens/tools/package.json` with versions |
| `tools` | Tools found from a fixed catalog: id, version, location |
| `skipped` | Unknown entries not copied, with the reason, so the user can review them |
| `manual` | Fixed reminders: Pi `/login`, `gh auth login`, MCP credentials, secrets such as `INGKA_PAT` to recreate by hand |

`settings.json` is stored without machine-specific keys: `deviceId`, `lastChangelogVersion`, `extensionChangelogVersions`. Home-directory paths in text files become `{{HOME}}` at scan and the new home at deploy. File modes are kept, so skill scripts stay executable.

## scan

`node src/cli.ts scan --out <file.tar.gz> [--include <agent-relative-path>]...`

1. Copy only an allowlist:
   - Agent: `AGENTS.md`, `settings.json`, `keybindings.json`, `models.json`, `sandbox.json`, `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `dev-kit/models.json`, `herdr-agents/config.json`.
   - pi-lens: `config.json`.
   - Inside allowed directories, skip `node_modules/`, `.git/`, `*.log`, `*.jsonl`, `*.lock`, `*.bak*`.
   - `--include` adds an agent-relative file or directory the user chooses.
2. Report every other top-level entry as `skipped`. Entries on a known-ignore list (runtime, secrets above) are reported by count only.
3. Secret check on every copied file: patterns such as `ghp_`, `github_pat_`, `sk-`, `xox`, `AKIA`, `-----BEGIN`, and JSON keys named `apiKey`, `token`, `password` or `secret` with a non-empty literal value. Any hit stops the scan before the archive is written, naming the file and the rule but never the value. The user edits the file, removes it with `--exclude`, or confirms it with `--allow-secret <path>`.
4. Record Pi packages, Git directories, npm globals, pi-lens tools and catalog tools. Never run `pi`.
5. Write the archive with mode 0600 and print a summary.

Limits: 1 MiB per file and 100 MiB per archive; larger files stop the scan unless excluded.

## deploy

`node src/cli.ts deploy <file.tar.gz> [--yes] [--pin-versions]`

1. Preflight: platform, official Pi launcher, Node version. Stop if a Pi process is running, because Pi rewrites `settings.json`.
2. Build and print the action list:
   - Tools: `installed`, `install` (exact catalog recipe), or `manual` (no recipe on this platform, or it needs `sudo`; the command is printed).
   - npm globals: `npm install -g <name>@<version>` for missing ones; `manual` if the global prefix is not writable.
   - Pi packages: `pi install <source>` for each declaration not yet installed, in manifest order.
   - Files: `create`, `same` (skip), or `replace` (backed up first to `~/.pi-env-backup/<timestamp>/`).
   - Git directories: `clone` when absent, `skip` when present.
3. Without `--yes`, stop after printing. With `--yes`, run in order:
   1. Tools and npm globals.
   2. Files except `settings.json`.
   3. Write `settings.json` with an empty `packages` array, then run `pi install` per package. Each call has a 5-minute limit and its output is shown. Stop at the first failure.
   4. Replace `packages` with the manifest array exactly, so resource filters and order match the source.
   5. Clone Git directories.
   6. Run `npm install` in `~/.pi-lens/tools` with the recorded versions, only if pi-lens is among the packages.
4. Print the manual steps and a result table. Running deploy again skips completed items.

Versions: by default deploy retains explicit Pi npm pins and leaves unpinned sources unversioned. Preview reports recorded versions without querying for latest versions. `--pin-versions` uses the recorded version for supported npm sources and preserves resource filters.

Deploy runs only built-in recipes and `pi install`/`npm install` with validated package names and versions, without a shell. Install scripts of packages run, as with a manual `pi install`.

## Risks

- Overwriting files in `~/.pi/agent` (mitigated by preview, backup and `same` detection).
- A secret in an allowlisted file (mitigated by the blocking secret check; patterns can still miss unusual formats).
- Package and tool installs run third-party install scripts and need network access.
- `pi install` behavior depends on the Pi version on the new host.

## Repository change

Tag the current `main` as `v0-transactional-archive`, then replace `src/`, `tests/`, README and AGENTS.md on `main` with the lightweight implementation. Retire `portable-config.md` (reachable through the tag). Runtime dependencies: Node built-ins and the system `tar`; remove `@babel/parser`.

## Verification

- Offline tests with a fixture home and fake `pi`/`npm` executables on `PATH`: allowlist, secret check, settings key removal, templating round trip, archive format, preview classification, backup, install order, filter restoration, idempotent re-run, argument validation.
- A Linux end-to-end run in a disposable container with network access, and a scan of this host reviewed by the user. Both need separate authorization.

Process: deploy writes outside the workspace and runs installers (reinforced triggers T5, T6). Proposed lean path: one design review, one QA author, one implementation review (3 child runs).

## Decisions for the user

| ID | Decision | Recommended default |
|---|---|---|
| L1 | Copy rule | Allowlist plus `--include`; blocking secret check. Changed from the earlier "copy all except" default because `INGKA_PAT` would have been copied |
| L2 | Pi packages | `deploy` runs `pi install` per package, then restores the exact `packages` array |
| L2b | Package versions | Unversioned by default (latest, like the source host); `--pin-versions` optional |
| L3 | Installs needing `sudo` | Print the command; the user runs it |
| L4 | Git subdirectories | Record remote; clone at deploy |
| L5 | Process | Reinforced lean path, 3 child runs |

The user approved L1–L5 with the recommended defaults on 2026-11-23 ("批准，审查后开始开发"), including the repository change. The local tag `v0-transactional-archive` points at `52eeb1a`; it is not pushed.

## Round 1 review: accepted decisions

The first design review used the verified frozen copy at `/tmp/pi-env/plan-r1.md`; that temporary copy was unavailable during implementation review. The user approved R1–R5 at the review checkpoint and confirmed GPT authored the frozen design. These rules and the acceptance contract below take precedence over earlier wording.

| ID | Decision | Recommended default |
|---|---|---|
| R1 | Scan paths and credential exclusions (B1, B2) | Walk only explicit, normalized paths under the canonical scan roots. Never follow links or read special files, multiply linked files, or known credential paths. Skip such entries before reading and report counts without exposing credential paths. Apply the same exclusions to `--include`; neither `--include` nor `--allow-secret` can override them. Use existing prohibited credential names and add `.env*`, `.npmrc`, and `.netrc`. Reject URL credentials in manifest metadata. Publish the exact checked bytes to a new mode-0600 archive; never overwrite an existing output. |
| R2 | Archive and destination validation (B3) | Accept a bounded regular-file-only gzip tar subset; do not extract with system `tar` into a target root. Validate the entire archive before a preview or target write: strict JSON, safe normalized paths, exact manifest membership, sizes and SHA-256. Reject links, extra metadata, duplicates, missing files and unlisted files. Limit compressed bytes and total expanded bytes to 100 MiB each, files to 1 MiB each, manifest to 1 MiB, and payload entries to 10,000. Validate target and backup paths; back up before atomic replacement, with private backups and no group/other write or special mode bits on restored files. |
| R3 | Settings, preview and failures | Preview without network installs or file writes. Show target-only packages that the final settings will drop; preserve destination machine-specific keys. Back up settings before their first mutation. Preserve filters and order; pinning changes only supported npm source fields. Do not run an installer for an already satisfied package; require local installation evidence, not just a settings declaration. Stop on the first apply failure and report completed steps and backup locations, without printing raw subprocess output. Use exit 0 for success, 2 for invalid input, and 1 for operational failure. |
| R4 | Install input boundaries | Auto-install only supported, validated npm registry sources and approved built-in tool recipes. Treat local, linked, unproven registry, and unsupported package sources as manual; never guess their registry equivalent. Use validated credential-free Git remotes for clones, with no prompts and a timeout. Preview reports recorded versions and does not look up latest versions. Print manual reminders for SSH configuration; do not transfer SSH keys or ignored Git content. |
| R5 | Destination bootstrap | The user transfers the reviewed tool source separately and provides Node 24+ on `PATH`. Pi remains a prerequisite. Use the current home and `PI_CODING_AGENT_DIR` when set; otherwise use `~/.pi/agent`. No new delivery or environment grants. |

### CLI and fixture acceptance contract

- **A1 — Scan.** `node src/cli.ts scan --out <new-file.tar.gz> [--include <agent-relative-path>]... [--exclude <agent-relative-path>]... [--allow-secret <agent-relative-file>]...`. Exclude beats include and applies to descendants. `--allow-secret` applies only to a matching content check on that file, not to path or metadata exclusions. A content hit makes scan exit 2 and leaves no output. Path arguments reject absolute paths (except the archive path), empty components, `.` and `..`, backslashes and control characters. Scan never invokes Pi. Use an absolute fixture `HOME` and optional absolute `PI_CODING_AGENT_DIR`; the latter does not change the lens root. Reject symlinked roots. Do not read old archive contents or overwrite them.
- **A2 — Archive.** `manifest.json` is the first entry and has `schemaVersion: 1`. Archive members are regular files named `manifest.json` or `files/{agent,pi-lens}/<path>`. No directory entries or extended headers are needed. Each `files` element is `{root, path, size, sha256, mode, templated}`, with `root` equal to `agent` or `pi-lens`. Digests and byte sizes cover stored bytes. Deploy enforces the same never-copy exclusions; a valid manifest's agent file list may contain explicitly included paths outside the default allowlist. The lens root only allows `config.json`. `settings.json` is required and strictly parsed. An invalid archive exits 2 without target changes. No target-facing extraction precedes validation.
- **A3 — Rendering.** Strip `deviceId`, `lastChangelogVersion`, and `extensionChangelogVersions` from captured settings. For valid UTF-8 text, substitute full home prefixes only at path boundaries; leave binary files unchanged. Refuse an ambiguous pre-existing `{{HOME}}` in text. For JSON, substitute inside parsed string values and serialize with JSON escaping. Restore a templated file by expanding `{{HOME}}` to the target home. Compare rendered bytes and safe mode; for settings preserve machine keys only from the destination. Backups are private under `~/.pi-env-backup/`, preserve original bytes, and precede each replacement. Refuse symlinked or special target entries and parents.
- **A4 — Deploy and preview.** `node src/cli.ts deploy <file.tar.gz> [--yes] [--pin-versions]`. Preflight checks Node 24+, macOS or Linux, the official Pi launcher, and no active Pi process. Check the launcher at `<agent-root>/bin/pi` using local metadata, not by running it in preview. An executable fixture script at that path stands in for Pi; never run real Pi in tests. Use `ps` for process preflight; a fixture `ps` may report no active Pi process. Preview exits 0 for a valid plan, shows file `create`, `same`, `replace`, install/manual actions and any destination-only settings packages to be dropped. It makes no destination changes and runs no external operation that installs, queries a registry, or clones. `--yes` recomputes and prints the plan before applying it. Test observable labels and effects, not exact layout.
- **A5 — Install boundaries and order.** Scan records detected tools from the fixed catalog `node`, `npm`, `gh`, `git`, `uv`, `python3`, `brew`, `typescript-language-server`. Deploy considers only recorded catalog IDs. Only a compiled-in recipe may run; tools without one are manual. By default, retain explicit version pins in Pi declarations, including for local installed-version checks. Registry package names are simple npm names, optionally scoped, and recorded versions are concrete versions. Pin only when an approved registry source has a recorded concrete version; fail validation rather than silently falling back. Leave the rest of an object's resource filters intact. Non-registry Pi packages are recorded and marked manual, not executed. Git repositories use credential-free HTTPS or SSH remotes; normal SSH usernames are not credentials for this rule. Clone only if absent; never replace a present directory. Treat symlinked destinations as invalid. Use argument arrays, fixed executables, and bounded non-interactive calls; never evaluate a command from an archive. Apply order: tools/globals, other files, settings and Pi registry installs in recorded order, clones, then lens tools. Install lens tools only with an installed pi-lens; create a private project manifest under the guarded lens tools root from validated recorded versions and use a local npm install. No output may include raw subprocess streams.
- **A6 — Retry and failure.** A failed apply exits 1 and stops before the next action. Keep earlier successful actions and backups. Do not write final packages settings until all scheduled Pi installs succeed; an interrupted run can leave intermediate settings. A rerun replans from actual files and local installed package metadata; it skips satisfied installs and matching files, preserves available backups, and never replaces existing Git directories. For fixture Pi npm packages, installation evidence comes from `<agent-root>/npm/node_modules/<name>/package.json`; for global packages use local `npm ls -g --depth=0 --json` evidence, not remote queries. No rollback command. Test install failure with a fake npm/Pi executable; assert no later fake action ran. Malformed arguments exit 2.

QA owns `tests/pi-env-acceptance.test.ts`. Author black-box tests for A1–A6 before implementation, with no private imports. Tests must isolate `HOME`, `PI_CODING_AGENT_DIR` and `PATH`, use fake commands for any probes or installs, run offline, and clean up temporary fixtures. Real Pi compatibility, the host scan, Linux container E2E, and actual installers remain unverified without separate grants. No new review run is reserved by the current budget.

## Task state

```yaml
task-state:
  goal: replace the transactional restore with lightweight scan and deploy commands per this plan
  level: reinforced (T5 writes outside workspace, T6 installers and network)
  profile: private
  models: /Users/bin.cui/.pi/agent/dev-kit/models.json (user)
  base: main@52eeb1a + dirty docs/plans/pi-env.md, docs/plans/portable-config.md, AGENTS.md
  approvals: [design L1-L5 and repository change (user 2026-11-23), R1-R5 approved and GPT plan authorship confirmed (round-1 checkpoint questionnaire), one extra fixture-only QA run approved (QA1 checkpoint questionnaire), one targeted implementation re-review approved (IR1 and IR2 checkpoint questionnaire)]
  grants: [offline fixtures only; read-only access to ~/.pi and ~/.pi-lens for inventory; no commit, push, live deploy, container run or network install]
  owners: {docs/plans/pi-env.md: coordinator, src/**: coordinator (after QA), tests/pi-env-acceptance.test.ts: qa}
  children: {pi-env-security: 'reviewer, anthropic/claude-opus-5-5, high, completed; cross-family findings returned', pi-env-test: 'qa, openai-codex/gpt-6.2-sol, high, completed; expected red baseline confirmed', pi-env-test-2: 'qa, openai-codex/gpt-6.2-sol, high, completed; fixture corrected', pi-env-review: 'reviewer, anthropic/claude-opus-5-5, high, completed; implementation findings returned', pi-env-review-2: 'reviewer, anthropic/claude-opus-5-5, high, completed; no blocking findings in IR1 or IR2'}
  runs: 5/5 (user-approved targeted re-review expansion)
  handoff: done
  findings: [B1 scan path and entry checks (blocking; contract corrected in R1; 1/3), B2 credential exclusions (blocking; contract corrected in R1; 1/3), B3 archive validation (blocking; contract corrected in R2; 1/3), non-blocking findings returned in pi-env-security report, QA1 global npm fixture lacked registry origin evidence required by R4 (closed; 1/3), IR1 default deploy ignored explicit Pi pins (closed; 1/3; independently re-reviewed), IR2 deploy considered tools absent from the manifest (closed; 1/3; independently re-reviewed), remaining implementation review findings and test gaps deferred in pi-env-review report]
  evidence: [inventory of source host names and metadata (2026-11-23), private model validation passed, base and peeled archive tag verified at 52eeb1a, round-1 snapshot matched the plan before launch, QA syntax passed and red baseline reproduced at 52eeb1a on Node 26.13.1 (one smoke pass and eight failures from legacy usage), fixture repair verified without changing oracles, final offline suite and strict docs checker passed and changed-path LSP found no errors (Node 26.13.1; no real Pi or network), independent first implementation review ran 22 passing tests, repaired tree passes 24 offline tests and strict docs with no changed-path LSP errors, targeted independent re-review passed 24 tests and three additional fake-tool probes on Node 26.13.1]
  next: offline verified; development acceptance awaits separately authorized host scan and Linux end-to-end verification; no further child runs or delivery authorized
```
