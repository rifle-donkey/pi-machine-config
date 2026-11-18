# AGENTS.md

Model profile: private
GitHub account: rifle-donkey

## What this project is

`pi-machine-config` develops explicit, portable Pi configuration capture and restoration for macOS and Linux. User-facing status: [README](README.md).

## Documentation map

| Document | Authoritative for | Update when |
|---|---|---|
| `README.md` | Available behavior, operator safety rules, CLI reference, policy/bundle/overlay formats, plan classifications | Available commands, options, formats, codes or limits change |
| `AGENTS.md` | Agent boundaries, development commands, documentation routing | Development contracts change |
| `docs/plans/portable-config.md` | Accepted first-restore contract, implementation slices, verification and task state | Design, approval or evidence changes; retire after implementation |

## Layout

- `docs/`: designs awaiting implementation and verification.
- `src/`: CLI and core modules, run directly by Node type stripping (no build step). Each module's docstring states its purpose.
- `tests/`: `node:test` suites against temporary fixtures. The acceptance suite file `acceptance.test.ts` in `tests/` is reserved for independent QA; developers do not create or edit it.
- Add implementation directories only with their assigned slice.

## What the code doesn't make obvious

- Write erasable TypeScript only (no enums, namespaces or parameter properties) and import local modules with the `.ts` extension; Node runs the sources directly.
- `TOOL_VERSION` in `src/schema.ts` must equal `version` in `package.json` (a test checks it); the version is part of every plan token.
- Parse every JSON input with `parseJsonBytes` from `src/json.ts`, never `JSON.parse`; it carries the duplicate-key, prototype-key, BOM and unsafe-number rules.
- Read every input file through `readUnder`/`readFileRoot` in `src/fsafe.ts` after canonicalizing its root with `existingDir`/`existingFile`/`absentTarget`; apply `guardLiveLexical` to the raw argument before any filesystem access and again to the canonical path.
- Errors are `ToolError` codes from `src/errors.ts`: `invalid` exits 2, `failure` exits 1. Never put input text, paths or exception text in a code; README "Output and exit status" documents the codes users see.
- `tokenDocument` in `src/plan.ts` defines the plan-token coverage listed in README "Plan classifications and approval token"; change both together and keep the token domain string versioned.
- `preparePlan` returns private rendered bytes and values; serialize only `plan(...)` or `preparePlan(...).result`, never the prepared object. `plan` itself returns only `PreparedPlan.result`. Its private `intentToken` compares a proven existing restore; it must never authorize activation.
- `readAppliedRestore` and `auditAppliedPlan` return private transaction tokens, output digests and prepared values. Never serialize them as public output. They are point-in-time read-only proofs, not writer exclusion; package mutation must revalidate under the writer lock. Keep `renderSettings` shared between the engine and applied-plan comparison.
- `restoreFromPlan` in `src/restore.ts` requires a ready plan and matching consent, and installs the trusted `verifyLockedIntent` verifier to recompile under the state lock before the first journal or target write. The apply command uses this service; never wire the raw engine directly to CLI input.
- `reviewDescriptor` and `CAPTURE_TOKEN_DOMAIN` in `src/approval.ts` define recorded capture consent; change them together with README "Capture review and inclusion approval" and keep the token domain versioned.
- Destination classes, settings types and package rules live only in `src/schema.ts`; README "Inclusion policy" mirrors them.
- Classes or settings that need an adapter not built yet must be classified `incomplete` in `src/plan.ts` (`INCOMPLETE_CLASSES`), never silently accepted or dropped.
- `promptReferencesReady` in `src/prompts.ts` checks only the new positive exact-reference subset on winning approved payloads, including auto-discovered siblings. Keep the gate separate from existing file-only/negative-only classifications and synchronized with README "Local prompt reference checks". Never use it to infer YAML, globs or package contents.
- `themeReady` in `src/theme.ts` is a pure Pi 1.5.2 adapter, run on winning merged payloads before plan approval and again through locked recompilation. Keep its schema/color/variable bounds synchronized with README "Local theme readiness"; package/selection discovery gates remain separate. Never import Pi or evaluate resource code to validate it.
- `src/package-attempt.ts` validates private attempt/audit data only: 1024 total attempts across 32 runs, 4096 bytes per attempt record and 1 MiB per ledger. Exit labels never prove process stop, ownership or stream-cap enforcement; the service must prove those separately.
- Every caller of `replacePrivate` in `src/transaction-fs.ts` must hold package-writer exclusion and retain it after ambiguous publication. The helper supports only ledger/attempt destinations and never cleans residue or authorizes process work; keep existing `replaceFile` journal behavior unchanged.
- `runPackageAttempts` in `src/transaction.ts` is a trusted fixture-only service, not a CLI route. Its production executor must stay null before filesystem access until executable approval, complete package tokens and missing-only discovery are implemented/reviewed. Its private file-identity capabilities never authorize ordinary recovery, and package locks never become stale-releasable from PID or boot observations. Independently enforce stream byte caps, not just diagnostic flags.
- `src/transaction.ts` reserves state entry `package-attempt.json`: ordinary operations use metadata-only exclusion before journal/target reads and stale-lock probes. Only the trusted fixture service may advance/remove its exact record through the reviewed D1 transitions. The module is the filesystem engine behind the restore service. CLI state operations must supply `expectedTargets` for inspect, rollback and resolve; it is compared with the journal before target access and again under writer/recovery locks. Its module docstring states the caller contract (packet only from a `ready` plan with a matched activation token). Its `deps` option (OS probes, `fault` hook) is a test seam like `GuardContext`: never expose it through a command-line option or environment variable. Its reserved stage and lock names depend on `relPath` in `src/schema.ts` refusing dot-prefixed components.

## Development rules

- Follow the accepted scope in `docs/plans/portable-config.md`; stop for user approval on material deviations or unresolved inclusion exceptions.
- Use the reinforced dev-flow workflow: independent design/security review before behavioral implementation, separate implementation review, independently authored QA.
- Use TypeScript and Node built-ins, plus the explicitly approved pinned `@babel/parser` dependency for static syntax analysis. Add no other runtime dependency without approval. Install the locked project closure with scripts disabled; never borrow a parser from a parent/global `node_modules`. Node 24 or newer is the intended baseline; verify capabilities before claiming support.
- Keep tests isolated in temporary fixture homes. Never load live extensions or run Pi during tests.
- In-process tests pass a fixture-home `GuardContext` (`src/fsafe.ts`) and an explicit fixture environment (normally `{}`) to `main`, `capture`, `captureReview` or `plan`, so the live-path guard does not inherit actual `HOME` or `PI_CODING_AGENT_DIR` locations. Never add a command-line option or environment variable that replaces or disables the guard; spawned CLI tests use the production guard, which queries only path metadata of the real locations.
- Commit and push only the snapshot and destination explicitly authorized by the user; do not generalize that permission to later delivery.
- Network package restoration, real target writes, sandbox expansion and authentication repair require separate authorization.
- Check documentation impact through this map after every code change; use project-docs for affected documents.
- Report unrelated issues without changing their scope.

## Security invariants

- Treat captured resources as executable, untrusted input, not configuration that is safe to activate automatically.
- Never read credential files or recursively copy an agent directory. Metadata inventory does not authorize copying contents.
- Never log raw configuration, arbitrary paths from rejected input, subprocess output, or exception payloads that might contain secrets.
- Reject symlinks, special files, traversal, overlapping roots and unmanaged replacement by default. Do not auto-delete unmanaged files.
- Keep runtime journals, backups and machine overlays untracked and outside portable configuration. Backups may contain sensitive destination settings.

## Commands

Tests (offline, temporary fixtures only):

```bash
node --test 'tests/*.test.ts'
```

No project-local `@types/node` is installed, so default LSP checks cannot verify Node API types. A strict one-off check can use an existing reviewed Node type installation without installing anything:

```bash
: "${NODE_TYPES_DIR:?Set NODE_TYPES_DIR to an existing @types root}"
tsc --noEmit --strict --target esnext --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck --types node --typeRoots "$NODE_TYPES_DIR" src/*.ts tests/*.test.ts
```

Record the external type source when reporting this check; it does not verify the Node 24 runtime baseline or provide project-local LSP configuration.

Documentation validation:

```bash
python3 "${PI_PROJECT_DOCS_CHECKER:-$HOME/.pi/agent/npm/node_modules/pi-project-docs/skills/project-docs/scripts/check_docs.py}" . --strict
```

## Branch and environment boundaries

- Keep the current `main` branch unless the user authorizes a branch change. Check `HEAD` and the dirty working tree before each change; never rewrite shared history.
- Only the coordinator accesses GitHub. The user confirms the existing origin `rifle-donkey/pi-machine-config` (no leading hyphen); remote access and delivery still require applicable authorization.
- Offline fixture verification is permitted. Live application and package installation require separate, explicit authorization.
