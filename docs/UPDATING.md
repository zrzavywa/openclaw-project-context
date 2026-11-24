# Updating the plugin

Updates are an operator task, not an agent task. An install or reload started from inside
a running agent turn waits for the very turn that issued it: the host drain waits for the
turn, the turn waits for the install command, and the install aborts after the 60-second
drain budget. The files are replaced anyway, so the running gateway keeps the previous
generation while `plugins list` already reports the new version.

That was measured four times on 2026-11-24, including once with `reload.turnHandover`
declared in the running generation. Handover happens between model steps; a turn blocked
in a tool call never reaches one.

## Before you install

```bash
npm run status -- --online        # repo, mirror, catalog, installation
npx -y clawhub@latest package moderation-status @zrzavywa/openclaw-project-context
npm run verify:loaded             # loaded generation before the change
```

Expect `latest` to be the target version, `package scan: clean`, `release scan: clean`,
`blocked: no`. Record the `verify:loaded` output; it is the baseline for the rollback.

## Install and activate

Run this in a maintenance window, outside an agent turn:

```bash
openclaw plugins install @zrzavywa/openclaw-project-context@<version> --force
openclaw plugins reload awf-project-context --wait   # only when no turn is running
openclaw gateway restart                             # otherwise this is the reliable path
```

A drain abort (`admitted work did not settle within 60s`) still replaces the files. Restart
and continue; do not retry the install.

## Verify, then document

```bash
npm run verify:loaded        # must print PASS with the target version
npm run status -- --online   # all four levels equal, or a named MISMATCH
```

`FAIL` means: files are new, the running generation is old. Restart again. Do not treat a
manifest version as proof of what is running.

## Rollback

```bash
openclaw plugins install @zrzavywa/openclaw-project-context@<previous-version> --force
openclaw gateway restart
npm run verify:loaded        # PASS with the previous version
```

Published versions stay available in the catalog; the mirror also keeps a tag per release.
