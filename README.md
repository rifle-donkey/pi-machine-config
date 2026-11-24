# pi-machine-config

Move your Pi user configuration from one macOS or Linux machine to another. `scan` creates a private archive. `deploy` previews changes unless you add `--yes`.

## Move an environment

1. Put a reviewed copy of this checkout on both machines. Use Node 24 or later. The destination must already have an executable Pi launcher under its agent root at `bin/pi`. This tool does not install Pi or Node.
2. On the source, run `node src/cli.ts scan --out pi-env.tar.gz`. Review what was captured and transfer the archive using a private channel. It can contain sensitive settings that the secret check missed.
3. Close Pi on the destination. Run `node src/cli.ts deploy pi-env.tar.gz` to see the planned changes. Review the archive's origin and preview. Do not deploy an archive you did not create or review.
4. Run `node src/cli.ts deploy pi-env.tar.gz --yes` only if you accept the changes. Install anything marked `manual` yourself. Configure SSH and recreate credentials on the destination; the archive does not carry them.

Use `HOME` for the home directory and an absolute `PI_CODING_AGENT_DIR` to override the default `~/.pi/agent`. The Pi Lens root remains `~/.pi-lens`.

## What moves

- Scan starts with Pi settings, agent instructions, keybindings, models, sandbox settings, local extensions, skills, prompts and themes, and the known dev-kit, Herdr and Pi Lens configuration files. `--include` adds an agent-relative path. `--exclude` removes an agent-relative path and its descendants.
- Scan skips known credential and runtime files, linked files, special files and Git repository contents. It does not run Pi. A secret pattern in a captured file stops the scan. Inspect that file before addressing the finding; `--allow-secret <agent-relative-file>` overrides only its content check, not the path exclusions. Pattern checks cannot prove a file is free of secrets.
- Scan records local versions, package declarations and supported Git remotes. It strips `deviceId`, `lastChangelogVersion` and `extensionChangelogVersions` from settings. It replaces matching home prefixes in text with `{{HOME}}`. It leaves binary data unchanged and refuses ambiguous literal placeholders.
- Deploy compares rendered bytes and safe modes. It keeps destination machine keys, replaces the package declarations with the archive's ordered list, and previews target-only packages that will be dropped. It keeps resource filters. `--pin-versions` pins supported Pi npm sources to recorded versions and fails if a version is missing. By default, deploy keeps explicit source pins and installs unpinned sources without a version. It leaves the archived source declarations intact.
- Deploy installs missing registry packages with local evidence checks. Non-registry Pi packages and global npm packages without registry-origin evidence appear as `manual`. macOS can install `gh`, `git`, `uv` and `python3` using an existing writable Homebrew prefix. Other missing tools are manual. Preview does not look up latest versions.
- Deploy clones supported Git repositories only when absent. Ignored files and unpushed commits do not move. It installs Pi Lens tools only if the Pi Lens package is installed.

## Safety rules

The archive is data with executable configuration inside. SHA-256 detects mismatches; it does not prove who made the archive. `--yes` may run package lifecycle scripts and install executable Pi resources. Preview and apply are separate invocations; apply prints its current plan before it starts. Do not edit the target or start Pi during deploy.

## Recovery

Before replacing a file, deploy saves its original bytes in a private run directory under `~/.pi-env-backup/`. Deploy does not roll back an interrupted run. It stops at the first error, reports completed actions, and leaves backups and prior successful changes intact. Inspect the reported backup and compare its files with the target. With Pi closed, copy back only the files you want to restore. Package installations, repo clones and newly created files are not undone by restoring a backup. To continue instead, rerun deploy after resolving the error; it skips files and package installs already satisfied.

## Reference

The archive is gzip-compressed USTAR. It starts with `manifest.json` (`schemaVersion: 1`). The remaining entries are regular files under `files/agent/` or `files/pi-lens/`. Its manifest lists each file's path, stored byte size, digest, mode and template flag. Deploy validates the complete archive before writing. Limits are 100 MiB each for compressed and expanded bytes, 1 MiB per file and manifest, and 10,000 payload files.

Deploy reports actions as one JSON object per line; scan reports a summary. Status `0` means success, `1` means an operational failure, and `2` means invalid input. Errors use fixed codes; a scan content warning also names the checked relative file. Installer streams are not shown.

Tests and development rules: [AGENTS.md](AGENTS.md). Live Pi, a host scan and Linux container deployment have not been verified as part of the rewrite.
