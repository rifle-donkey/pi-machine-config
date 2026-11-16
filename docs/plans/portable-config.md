# Plan: First-restore Pi configuration

Status: Accepted
Updated: 2026-11-16

## Problem and scope

Restore a new macOS/Linux machine's Pi preferences, rules, package selections and local resources without manual package-by-package installation. Never copy the whole agent directory or migrate credentials/runtime state.

The user confirms `Model profile: private`, `GitHub account: rifle-donkey`, and current remote `rifle-donkey/pi-machine-config` without a leading hyphen. The user requests design before code and explicitly approves simplifying the first release to new-target restoration. The user subsequently approved this detailed design and offline implementation/testing in this run. This replaces the earlier general managed-update design. Design approval alone does not authorize live writes or delivery. The user later authorizes and receives checkpoint `2335d12` before continued development; that delivery permission does not cover later uncommitted changes. Live configuration writes and package network operations remain separately gated.

**First release:** complete capture/new-target restore with deterministic layers, exact inclusion policy, explicit activation, batch package restoration, static doctor and one transaction's configuration cleanup. **Not included:** updating existing targets, adoption/force, per-key replacement of existing settings, multi-generation history/rollback, pruning, package uninstall/downgrade, dependency installation for local resources or private registry support.

## Requirements

| ID | Observable contract |
|---|---|
| R1 | Explicit capture → inspect → plan → apply → optional packages restore → doctor; no background sync. |
| R2 | Existing agent target directory is always refused, even empty or apparently identical. External configuration targets must also be absent. Nothing is overwritten or adopted. |
| R3 | Only exact approved source files/settings/package identities are read/copied; credentials, trust, sessions, caches, dependencies, logs and binaries are excluded. |
| R4 | Preserve absent/empty/signed resource filters, optional boolean `autoload`, array order, provider-boundary rules and Firecrawl manual-only metadata. npm declarations are unversioned. |
| R5 | Writing resources or package declarations is activation: consent covers code/instructions loading and missing-package automatic installation at later startup/reload. No command hides this behind ordinary file copying. |
| R6 | No Pi/package-manager subprocess or network during capture/plan/apply/doctor. A bounded read-only OS identity probe is permitted for apply/recover locks. Packages restore is separately authorized and never upgrades already-installed packages intentionally. |
| R7 | Every published configuration file has prior durable intent; interrupted operations are inspectable. Cleanup touches only proven files created by this transaction, never unrelated files or package artifacts. |
| R8 | Offline fixtures plus independent implementation review/QA are mandatory. Real Pi startup, package compatibility, Node baseline and real macOS/Linux evidence remain explicit separate checks. |

## Inventory and live-capture gate

Metadata inventory found agent settings/global rules/dev-kit model routing/herdr routing/sandbox and external lens configuration. npm object filters are present. Native resource listing identifies local extensions `copilot-credits`, `editor-selection`, `usage-status`, `herdr-agent-state.ts`, `pi-lens.ts`, plus `grill-me` and manual Firecrawl skills. Shell listing was permission-denied; native listing succeeded but content, imports and symlink checks remain incomplete. Optional prompt/theme presence is not established.

This is not permission to copy source contents. Before live capture, the user approves exact inclusion entries and any data-boundary exceptions; internal/work content does not become safe merely because this repository is private. Never expand sandbox permissions or read credentials to complete inventory.

## Portable data contract

One strict bundle schema (`schemaVersion: 1`) contains a policy plus selected layer manifests and exact UTF-8 payloads. No automatic migration from the earlier proposed prototype schema; no prototype implementation exists. Tracked layout: `manifests/inclusion.json`, `config/common/`, `config/platforms/darwin/`, `config/platforms/linux/`. An optional machine overlay and all runtime state stay outside the repository/bundle.

| Input | Contract |
|---|---|
| Inclusion policy | Exact setting keys, npm identities/full filter objects, files, structural expectations and separately permitted metadata inspection locations. Unknown fields rejected. Recorded user approval binds the reviewed policy and selected payload digests. A manifest alone is not user authorization. |
| Layer manifest | `schemaVersion`, `layer`, `piDiscoveryModel`, `settings`, `packages`, `files`; overlay additionally supports `packagesRemove`. `settings` excludes packages. Layer is common/platform:darwin/platform:linux/overlay. |
| File record | Exact `root`, `path`, `class`, `bytes`, `sha256`, `template`, optional structural `expect`; digest proves integrity only, not authenticity or secrecy. Payload is under that layer's `files/<root>/<path>`. |
| Bounds | 1 MiB per JSON/text file, 16 MiB per layer, 48 MiB total selected payload; at most 32 path levels and 4096 metadata entries per approved directory. UTF-8, no NUL or special files. |

Closed file destinations, each still requiring an exact inclusion entry:

| Class | Allowed target |
|---|---|
| `agent-context` | agent `AGENTS.md` only |
| `extension-source` | individually listed text source files under agent `extensions/` |
| `skill-source` | individually listed text source files under agent `skills/<name>/` |
| `prompt` | agent `prompts/<name>.md` |
| `theme` | agent `themes/<name>.json` |
| `tool-config` | agent `keybindings.json`, `dev-kit/models.json`, `herdr-agents/config.json`; overlay-only `sandbox.json`, each with a reviewed schema adapter |
| `external-config` | symbolic `lens-config`, fixed payload path `config.json`, mapped only to explicit `--lens-config <absolute-file>`; no managed home root |

Never use file records for settings, auth/trust/MCP/root model definitions, system/append-system prompts, context overrides/variants, locks, logs, runtime/dependency directories, `bin/` or reserved `.pi-machine-config*` paths. Deny dot directories and case/NFC/NFD aliases; the external lens path is an exact file mapping, not a dot-directory wildcard exception. No path traversal, empty components, control characters, backslashes, drive/UNC prefixes or payload references outside a layer.

Initial settings allowlist: typed `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `modelThinkingLevels`, `defaultTools`, `theme`, `tuiMode`, integer `editorPaddingX` (0–3), `fullscreenCopyOnSelect`, `showCacheMissNotices`, and signed `extensions`/`skills`/`prompts`/`themes` arrays. `defaultTools` and resource arrays are activation-sensitive. Exclude custom executable commands, proxies, project trust/session locations, arbitrary endpoints, runtime identities and changelog state, including from overlays. Use null-prototype maps/reject prototype-mutating keys; duplicate JSON keys and unsafe numbers fail. No raw parser excerpts in errors.

Registry-only packages: `npm:name` or `npm:@scope/name`, optional capture-time conservative version/tag suffix removed. Lowercase ASCII name/scope segments contain letters/digits/dot/underscore/hyphen, start with letter/digit, total name length at most 214. Split suffix at the last @ after the scoped-name separator; allow nonempty alphanumeric/dot/underscore/plus/hyphen suffixes only. Unsupported npm ranges/git/local/alias/URL sources are inclusion exceptions, not guessed conversions. Bundle declarations are unversioned. Preserve string/object form; object keys are `source`, optional boolean `autoload`, and optional ordered string arrays `extensions`, `skills`, `prompts`, `themes`. Reject duplicates, unknown metadata, absolute/traversing resource filters or any unsupported package; capture publishes no partial bundle. Project-scope filtering deltas remain outside scope.

## Layers and portability

Merge common → selected platform → optional overlay. Offline plan may select either platform; apply must match actual darwin/linux. Missing explicitly selected layers fail. Settings replace whole top-level values; omission inherits, empty arrays replace. Ordered arrays never sort/deduplicate. Approved common/platform declarations replace whole package objects by npm identity, preserving first-seen order; the overlay can only remove existing intent identities, never add packages or change filters. Such removal does not uninstall anything. Overlay files/settings are restricted to individually approved sandbox/lens machine fields, not source/context/provider routing.

Revalidate every merged setting, package/filter and file against the approved inclusion policy and expectations. Platform replacement cannot broaden class/target authorization. Unsupported or unapproved merged intent fails before deployment.

Preserve selection prefixes and `builtin:*` values. Convert approved absolute source-agent resource paths to agent-relative ones. Outside-source-agent paths require a named prerequisite or exact relocation rule. Literal `{{HOME}}`/`{{AGENT_DIR}}` tokens are allowed only in approved path-valued adapters or explicitly templated context/config text, never code/instruction source. JSON substitution escapes strings; unresolved tokens fail. No shell expansion/template evaluation. Old machine paths in extension/skill code require a separately reviewed source fix or exclusion; heuristic counts-only scans cannot prove portability or secrecy.

Sandbox remains local-only; lens is a reviewed exact-file adapter/template. Global rules, dev-kit/herdr routing and keybindings require individual review. Firecrawl entrypoints require structural `disable-model-invocation: true` validation at capture and doctor using a bounded fail-closed frontmatter parser. Missing imports/local-resource runtime dependencies block completeness; no implicit npm ci or fallback recursive copying.

## CLI and activation contract

All roots/targets are explicit absolute arguments, never live-home defaults. Public results contain approved relative paths/operation classifications, transaction IDs, fixed error codes and the explicit plan/package approval tokens defined below. Never emit raw values, credential-derived hashes, other content digests, subprocess output or rejected arbitrary strings. Exit 0 success, 1 conflict/operational failure, 2 invalid input/invocation.

- `capture-review`: read-only preparation of the explicitly permitted source inputs, returning a capture-review token that binds policy bytes, source platform, projected layer settings/packages and every selected raw payload's class/path/digest. It creates no output bundle. Permission to review source content remains an operator prerequisite, not inferred merely from the policy file.
- `capture --approve-inclusion <capture-review-token>`: recompute that intent before any output creation and refuse a mismatch. Record the caller-supplied matching token and bound intent in `manifests/inclusion-approval.json`; the final completion marker binds its digest, and consumers require/revalidate it. This records explicit capture consent, not authenticated identity or a signature. Then read only permitted source files/metadata, project settings, validate all layers, exclusively create a new bundle. Existing bundle refused. Publish/sync the final manifest and completion marker only after all payloads are complete and verified; every consumer requires both and rechecks digests. Interrupted capture remains visibly incomplete, never a usable partial bundle.
- `plan`: read-only, classify `create`, `activation-required`, `conflict`, or `incomplete`; existing agent directory or external target conflicts. A valid complete plan emits an approval token; incomplete/conflicting plans emit no usable token. Never creates directories/locks or invokes Pi.
- `apply --approve-activation <plan-token>`: recompute the approved plan after acquiring the state lock and refuse any token mismatch before creating target directories or publishing payloads; exclusively create a new agent directory and publish selected files/settings including approved package declarations. Consent explicitly includes next-start/reload installation and code/instruction activation. Apply performs no network or Pi/package-manager subprocess; only the bounded OS identity probe defined below is permitted. Without matching consent it writes no target payload; any transient owned state lock is released without committing a transaction. External lens target also requires absence and exact consent. This is a first restore, not an update command.
- `packages plan --tx <id> --pi <absolute-executable> --node <absolute-executable> --npm <absolute-executable>`: read-only, validate the restored target and selected executables, then emit a package approval token for the exact transaction, ordered declarations and package execution policy.
- `packages restore --tx <id> --approve-packages <package-token> --pi <absolute-executable> --node <absolute-executable> --npm <absolute-executable>`: recompute and match the package token under the transaction writer lock, validate current configuration against this transaction, install missing approved packages sequentially, and verify filters after every attempt. The operator must keep Pi stopped; the tool cannot reliably prove no other Pi process is running. Never use pi update --extensions.
- `doctor`: static versioned inspection only; report missing/incomplete/conflicting resources and dependencies, never import extension code.
- `rollback --tx <id>`: undo only configuration files created by this single restore and still provably unchanged. Keep package/runtime files and directories. If any dependency-group member conflicts, preserve that entire group. It is not package rollback or a return to an entirely clean machine.
- `recover --inspect`: read-only transaction/lock classifications. `recover --resolve --tx <id> --expect <class> --action <action>`: explicitly requested reconciliation only under the conditions below; no resume-install or automatic lock breaking.

Approval tokens are `sha256:<64 lowercase hex digits>` over a domain-separated, deterministic UTF-8 JSON description (sorted object keys, original array order). The plan token covers bundle/policy/layer manifests and completion-marker digest, selected platform, overlay content digest, merged effective settings including defaultTools/resource arrays, ordered package objects including filters/autoload, every file class/rendered target/content digest, canonical agent/lens targets, discovery model and tool version. Only reviewed nonsecret intent contributes; never hash excluded credential files. The package token additionally binds the completed restore transaction ID/plan token, current approved configuration identity, exact ordered package list, selected Pi/Node/npm executable identities and npm execution/environment policy. Tokens identify what the operator reviewed, not who approved it; they are not signatures or a substitute for user authorization. Any changed input invalidates the token.

Do not start Pi during apply; wait for explicit completion. Neither publishing resources first nor publishing declarations first is safe against a concurrently starting Pi, so the tool makes no such claim. First restore must happen before Pi creates the agent target directory (including login/setup). An already initialized target requires a separate operator decision/new target path, not a force/adopt switch. Configuration application is NOT safe preview: it activates resources/declarations at subsequent startup. `PI_OFFLINE=1` blocks missing-package auto-installation but does not stop already-installed extensions executing.

## Safe filesystem and one-transaction recovery

Allow root ancestor symlinks only after canonicalizing with realpath and checking ancestor identities; reject symlinks at supplied roots/managed descendants, special files and unexpected hardlinks. Compare overlap using canonical ancestor identities plus conservative case/NFC segment checks before creating anything. There is no home-wide root. Repository and read-only bundle may nest intentionally; otherwise bundle/repository, overlay, state, agent target and exact lens target are disjoint, with canonical path/ancestor checks. State/overlay are outside repository/bundle and each other. Agent root and lens target parents must already exist; apply does not create missing ancestors. Lens parent must not lie inside the agent target. Only managed descendant directories within the new agent root may be created and recorded, and they are never removed automatically. Fixture-mode writable bundle/state/target paths cannot overlap live real-user `~/.pi` or `$PI_CODING_AGENT_DIR` (including aliases); real-mode support requires separate authorization and tests. Home comes from os.userInfo(), not HOME.

Safe read: lstat → open O_NOFOLLOW|O_NONBLOCK → fstat regular-file/identity check → bounded limit+1 read; parent identities rechecked. New private directories 0700, files 0600; existing state owner/modes checked. JSON parser matches a leading BOM policy explicitly and refuses ambiguous duplicate keys/unsafe numeric round-trips. Never read credential files merely to inspect or hash them.

A state directory binds to exactly one restore transaction; never reuse it for another apply. Fixed order: acquire exclusive state lock, validate absent targets and all inputs, exclusively mkdir agent root, acquire its reserved tool lock, then publish. The exclusive root mkdir prevents two state directories acquiring the same target. External files use no-replace publication, not rename-over-existing. Existing context/system override files conflict by virtue of the absent-directory requirement; doctor still reports any introduced overrides before claiming rules parity.

Before each file: durably journal `staging` with a dot-prefixed random temporary basename that has no discoverable resource suffix; exclusively stage bytes in its destination directory and fsync; durably record `prepared` with stage identity and content digest. Publish using hardlink-no-replace to the destination, fsync directory, checkpoint `published`, then remove staging name, sync and record final `applied` identity. EEXIST is `not-created`, never ownership even if contents match. Safe recovery reads permit exactly two links only for the journaled stage/target pair. For a prepared crash immediately after linking, prove same dev/ino/nonzero birthtime, both recorded names, link count 2 and matching bytes; ctime may differ only in this specific accounted link transition. Without that complete pair proof, an unexplained timestamp change is conflict. Record dev/ino/ctimeNs/nonzero birthtimeNs as bigint decimal strings; ctime changes at link/unlink require checkpoints, never guessed updates. Unsupported birthtime/hardlink/directory-sync behavior or a crash identity gap yields conflict/manual reconciliation without deleting target, not invented ownership. Node fsync does not promise macOS F_FULLFSYNC power-loss durability.

Journal updates: exclusive temporary journal, fsync, rename over the owned journal, fsync state directory. No payload side effect after failed journaling/sync. An unresolved transaction blocks apply/installation. Root or payload creation after a crash is never adopted from bytes alone. No multi-generation ownership map, managed replacement, pre-image overwrite backup or ownership transfer exists in this release.

Locks record transaction ID, PID, UID, hostname and platform boot token in private state. Local filesystems only; Linux boot token uses /proc/sys/kernel/random/boot_id, macOS bounded fixed-argv /usr/sbin/sysctl -n kern.bootsessionuuid, requiring a validated per-boot UUID. Never use wall-clock-derived kern.boottime or clock changes as reboot proof. Verify availability on each supported target macOS version; unavailable/invalid identity blocks stale resolution. Confirm stale only on matching host/UID with changed boot token, or same boot and kill(pid,0)=ESRCH; EPERM/live reused PID/unknown host is unresolved. A hostname change also blocks automatic proof; network-driven hostname changes may therefore require manual reconciliation. Verify unchanged lock identity before explicit release. No mtime-only proof or automatic force. Recovery uses its own exclusive gate, never breaks a live/unproven gate.

| Recorded/current state | Explicit recovery action |
|---|---|
| Stale lock with complete owner proof | release-lock; archive intent/record, remove only that unchanged lock |
| staging/prepared + destination absent | abandon; clean only identity-proven staging, preserve unproven orphan and record it |
| prepared/published + journaled stage/target pair proven | finalize or rollback, after durable checkpoint; no inferred same-content ownership |
| not-created | abandon; clean proven staging only, leave destination alone |
| applied + exact final identity/bytes | rollback group: journal rollback intent, unlink only proven files, fsync, record rolled-back |
| rollback-pending + output absent | finalize rolled-back; unexpected replacement is conflict |
| missing/changed applied output or uncertain identity | record-conflict; archive acknowledgment without touching unknown file; preserve evidence |
| corrupt state or unknown classification | no automated resolution; separately designed operator recovery, not arbitrary JSON editing |

Rollback preflights complete dependent resource/settings groups, reverses proven independent groups, and records each intent/completion. Repetition is a no-op only for recorded absent results, never permission to delete replacements. Do not remove directories or runtime/package artifacts. Consequently rollback leaves the agent directory in place and a new apply to that same path is refused until the operator separately removes it or chooses a new path. Replaced/edited files can make automated cleanup impossible; report them honestly. A same-user malicious process can forge state/race pathnames; hostile-OS/same-user resistance is not claimed.

## Package restore boundary

Initial support is public npm, no authentication migration, scripts disabled. Refuse target npmCommand/httpProxy and unreviewed install-root intent/config overrides. Use exact approved Node/npm paths and validated minimal PATH; Pi still resolves default npm, so verify resolution. No shell, empty private cwd, --no-approve, explicit PI_CODING_AGENT_DIR. Environment allowlist: PATH, real HOME, private TMPDIR, fixed LANG/LC_ALL/TERM, PI_CODING_AGENT_DIR, and tool-set npm_config_registry/userconfig/globalconfig/ignore_scripts/cache. Registry is https://registry.npmjs.org/; user/global configs are private empty files, cache private. Do not inherit tokens, proxies, NODE_OPTIONS/preloads or arbitrary npm_config. Refuse discovered applicable .npmrc without opening credential contents. Trusting the approved npm installation includes its bundled built-in npmrc, which userconfig/globalconfig overrides do not replace; inspect its nonsecret policy as part of executable approval and refuse unapproved registry behavior. Private registries/custom managers/script-enabled installs require a future approved policy, not fallback.

Inspect approved managed npm manifests/lock metadata before reuse and refuse unknown direct identities/registry/source overrides. Installed name alone does not prove resources healthy. A shared npm install may affect other installed dependency versions; no byte-identical version promise. Public packages/transitive dependencies are third-party trust, not a network sandbox. Consent covers the declaration retry window; later startup retries do not inherit this invocation's script suppression.

Each pi install gets one unversioned source and a 120-second timeout; stop at first failure, no retries. Preserve predeclared object filters/autoload and verify semantic equality plus target configuration identity after every subprocess, even nonzero exit. Drift is failure, never automatic corrective overwrite. Terminate the verified child group on timeout; unconfirmed descendant cleanup blocks completion. Drain/discard raw stdout/stderr; store fixed codes/exit status/bounded byte counts only, no raw logs. Cap each stream at 1 MiB and terminate on excess. Installed versions are private diagnostic state only.

Failure leaves approved declarations and possibly installed artifacts. Keep Pi stopped; offer explicit configuration rollback or offline inspection, warning that offline mode still runs installed extensions. Never silently uninstall or claim package-version recovery.

## Doctor, evidence and verification

Versioned static adapter initially models Pi 1.5.2; differing installed version reports discovery-model-stale, not a version pin. Exact `inspection` policy authorizes bounded metadata listing, applicable ignore files, package manifests/resource metadata and approved skill frontmatter; read permission is not capture permission. Unsupported ignore/frontmatter syntax, denied metadata, outside-root skills or dependencies produce incomplete status. ~/.agents/skills and project scope are excluded unless separately approved for bounded inspection. Tool/command/shortcut collisions, module imports and actual startup require S4 authorization. All restored text is mode 0600: scripts needing an executable bit are unsupported initially, and doctor reports that prerequisite as incomplete rather than silently claiming skill parity.

Pi canonicalizes realpath/platform resource keys: two aliases of the same resource are redundant declarations, not automatic duplicate execution. Distinct canonical resources with colliding names are a separate check. Test both cases. Preserve builtin exclusions and manual-only skill metadata.

Coordinator's read-only kern.bootsessionuuid probe did not yield an available valid UUID in this session; target support versus sandbox restriction is unverified. Treat stale-lock release as unsupported here unless the required boot identity can be proven; no clock-based fallback. This is not a successful macOS stale-recovery test.

Original references: installed Pi docs/settings.md, packages.md, configuration.md, skills.md; dist/core/package-manager.js resolvePackageSources (automatic installation), addSourceToSettings (filter preservation), getNpmInstallArgs (no default script suppression), toResolvedPaths and dist/core/source-info.js (canonical deduplication). Earlier managed-update design was independently reviewed but not accepted. Its full closure review was cancelled without verdict; it is not evidence of safety.

| Verification | Required evidence |
|---|---|
| Before code | Cross-family independent review of this simplified contract, blocking findings disposition, then user detailed-design approval |
| Offline developer/QA | Capture projection/redaction, schema/limits, merge ordering, exact inclusion, activation consent, fresh-target refusal, safe paths/links/FIFO/permissions/case aliases, single-transaction crash/recovery, dependency-group cleanup, package stubs/env/timeout/filter drift, alias vs distinct collision |
| Final integration | Independent implementation and QA-test review, full fixture tests, strict docs check, changed-path LSP or disclosed unavailable diagnostics |
| Live/new laptop | Separately authorized capture/content review, actual package compatibility/startup discovery, real macOS/Linux filesystems, external prerequisites and Node baseline; macOS boot-session UUID availability/change across reboot or explicit unsupported stale-lock recovery. No live grant yet |

## Implementation slices and file ownership

Coordinator owns this plan, approval gates, integration and repository writes under the user's takeover decision. Independent QA authors acceptance cases and read-only test proposals; the coordinator integrates and runs them. Do not start another repository-writing child without renewed user authorization. Commit and push only the checkpoint and destination explicitly authorized by the user; later delivery needs separate authorization.

1. **Offline verified:** strict schema/capture-review/approved capture/layer/plan with temporary fixtures. Coordinator full suite: 98 passed, 0 failed; source I1-I8 and QA Q1-Q5 independently closed. Strict docs passed. A strict no-emit check passed using existing host-provided Node types; no project dependency was installed. Node 24/Linux and live operation remain unverified.
2. **Internal engine offline verified (slice 2a):** fresh-target filesystem transaction, inspect, rollback and explicit recovery APIs. The pushed checkpoint has 166 passing tests, strict one-off types and docs checks. Cross-family source review closes T1/T2 at repair 2/3; independent QA and review close G1/G2/QTx.
3. **Restore CLI offline verified (slice 2b):** C1/C2 admission hardening, C3 shared compiled intent and locked consent verification, and C4 public fixture-only `apply`, `rollback` and `recover`. Independent source/QA review closes C1-C4 and F1 lens-context coverage (repair 1/3). Final coordinator suite: 222 passed, 0 failed, cancelled or skipped; strict host-Node-types check and docs check passed. The historical CLI-help test assumed writes were unavailable; it now requires command registration and still rejects incomplete calls. Real Pi paths remain refused. Synthetic internal-engine lens journals test recovery binding only; public lens apply plans remain incomplete.
4. Resource/discovery adapters, static doctor and completeness checks.
5. Stubbed explicit package restore and subprocess safety.
6. Separate real-capture/new-laptop authorization and rollout; request Git delivery permission independently.

Slice 2b shares the validated/rendered intent compiler with preview and revalidates matching activation intent under the state lock before its initial journal or target write. It refuses incomplete/conflicting plans and preflights generated settings/journal limits. Reviewed C1/C2 hardening fails closed on inaccessible or ambiguous live roots and protects both account-home and environment-HOME Pi/lens roots without replacing account protection; a defined HOME must be a nonempty absolute path. A locked-verification failure may retain a private journal-missing state directory, but no target configuration is created. CLI recovery operations bind the operator's explicit agent/lens context to the journal before journal-selected target file/lock access, then repeat that check under writer/recovery locks. Canonicalizing explicit user paths performs only path-metadata lookups. Keep test dependencies inaccessible to CLI/environment flags; real Pi locations remain gated by separate authorization.

Internal recovery limitations: parent relocation can make even terminal inspection or repeated rollback refuse; no claim of unconditional replay success. A failed stale-lock release may retain its journaled intent and consume a bounded resolution slot. These are conservative availability limits, not permission to remove unknown paths.

README describes only available functionality. Close this plan after implementation by moving enduring contracts into README/AGENTS and retiring it through project-docs.

## Task state

```yaml
task-state:
  goal: implement the accepted first-restore design in independently verified slices
  level: reinforced
  profile: private
  models: /Users/bin.cui/.pi/agent/dev-kit/models.json (user)
  base: main@2335d125c44f51ed14da66fa2217d97d97d9da7a; prior checkpoint pushed to origin/main; slice2b offline verified and authorized for checkpoint delivery
  approvals: [private and rifle-donkey, current remote without hyphen, simplified first-release detailed design/offline tests approved, user selected coordinator takeover for T1/T2 with no new repository-writing child, user requests current checkpoint commit and push before continuing, user additionally authorizes completed slice2b integration and push to main]
  grants: [offline implementation/fixtures only, checkpoint2335d12 delivery completed, current slice2b checkpoint commit/integration/push authorized, no standing future delivery or live config writes or package network installs or authentication repair authorized]
  owners: {source-tests-integration-and-plan: coordinator}
  children: {prior-design-and-slice1-runs: completed-or-cancelled, machine-build: completed, restore-review: completed-with-T1-T2, restore-test: completed, restore-test-2: completed-11-pass4-failing-regressions, restore-build: failed-provider-ECONNRESET-no-repair, restore-review-2: completed-no-test-blocker-with-G1-G2-coverage-gaps, restore-test-3: completed-read-only-test-proposal, restore-test-4: completed-read-only-injection-correction, restore-review-3: completed-T1-T2-G1-G2-QTx-closed, admit-test: completed-read-only-QA-proposal, admit-review: completed-C1-source-and-QA-no-blocker, admit-test-2: completed-read-only-C2-proposal, admit-review-2: completed-C2-source-QA-no-blocker, gate-test: completed-read-only-C3-QA-proposal, gate-review: completed-C3-source-and-QA-no-blocker, cli-test: completed-read-only-C4-QA-proposal, cli-review: completed-C4-source-and-QA-with-F1-coverage-gap, cli-review-2: completed-F1-closed, active: none}
  findings: [slice1/slice2a and C1-C4 source/QA reviewed findings closed, F1 lens-context coverage closed at repair1/3 with missing-extra-wrong lenses and malformed-relative-live contexts plus alias positive control, optional under-lock journal-swap fault test not added, unknown old temporary roots untouched]
  evidence: [checkpoint2335d12 pushed local/remote match, C1-C4 independent source-and-QA reviews closed, coordinator final FULL222/222 exit0 95.90s including positive journal-open spy control, strict tsc0 with existing host Node types and docs0/0; active LSP on14changed files has136warnings from missing workspace Node types/inferred settings, not clean, no Node24/Linux/actual boot identity/reboot/live validation]
  next: resource/discovery adapters and static doctor completeness checks, then stub-tested explicit package restoration; coordinator sole writer with read-only independent QA/review, no automatic later delivery or live operations.
```
