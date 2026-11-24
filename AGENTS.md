# AGENTS.md

Model profile: private
GitHub account: rifle-donkey

`pi-machine-config` moves a single user's Pi configuration between macOS and Linux. [README](README.md) describes current behavior.

## Documentation map

| Document | Authoritative for | Update when |
|---|---|---|
| `README.md` | Commands, operator safety, archive format, limits and recovery | Public behavior or safety guidance changes |
| `AGENTS.md` | Development commands, safety invariants and authorization boundaries | Development contracts change |
| `docs/plans/pi-env.md` | Approved rewrite, verification evidence and task-state | Design, approval or evidence changes; retire at completion |
| `docs/plans/portable-config.md` | Superseded transactional design and draft | Retire separately; committed baseline at `v0-transactional-archive` |

## Layout and development

- `src/`: direct Node TypeScript CLI and implementation. Use erasable TypeScript and `.ts` import extensions. Runtime dependencies are Node built-ins only.
- `tests/`: offline Node tests. `tests/pi-env-acceptance.test.ts` is owned by independent QA; implementation authors do not edit it.
- `docs/`: plans and verification state. Check affected docs using project-docs after behavioral changes.
- Use the reinforced dev-flow workflow for scan/deploy behavior changes. Review the design before implementation, use independent QA, and review the resulting changes.

## Safety invariants

- Captured resources are executable, untrusted input. Preview is read-only. Only `deploy --yes` writes files or invokes installers.
- No recursive copy of a whole agent root. Exclude known credential paths before reading, including when explicitly requested. Never print excluded paths or secret values.
- Validate portable paths, archive membership, digests and limits before target writes. Reject links and special files, and refuse overlapping roots and path conflicts. Do not extract archive entries into the destination.
- Use `parseJsonBytes` for JSON input and fixed `ToolError` codes for failures. Never print raw exceptions or subprocess streams. Public plans use validated relative paths and package metadata only.
- Preserve private backups before replacement; do not delete unmanaged target files. Keep backups, archives and fixture data outside version control.
- Use argument arrays and bounded process execution. Derive installer commands from the built-in catalog and validated metadata only.

## Commands

```bash
node --test 'tests/*.test.ts'
```

Run tests only in temporary fixture homes with fake external commands. Do not invoke real Pi or package installers. Node 24+ is the baseline; report the actual Node version. There is no project-local `@types/node`; a strict check with external types must record the source.

```bash
python3 "${PI_PROJECT_DOCS_CHECKER:-$HOME/.pi/agent/npm/node_modules/pi-project-docs/skills/project-docs/scripts/check_docs.py}" . --strict
```

## Branch and environment boundaries

Stay on `main` unless the user authorizes a branch change. Check the base and the dirty tree before edits; never rewrite shared history. Only the coordinator accesses GitHub. Commit and push only the snapshot and destination the user explicitly authorizes. A live deploy, network install, container run, or sandbox expansion needs separate authorization.
