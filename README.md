# OpenClaw Project Context

Private plugin project for a secure, agent-scoped project context workflow inspired by ChatGPT Projects.

## Goal

Let a user create and work inside a project through the OpenClaw agent already in use. The active agent determines the project domain:

| Agent | Domain | Example code |
|---|---|---|
| `main` | A | `A004` |
| `privat` | P | `P008` |
| `beruflich-work` | B | `B005` |

Projects live inside that agent's own workspace. Context is isolated to the selected project and the current conversation.

## Included workflow

- Create a project from natural language or `/project create <name>`; creation selects it for the current conversation.
- Show a visible project status card with `/project status`.
- Capture a proposed summary from the visible conversation. The agent displays a preview; nothing is written until the owner runs `/project capture confirm`. Use `/project capture cancel` to discard it.
- Each confirmed capture is archived under `history/captures/`; `KONTEXT.md` is replaced with a compact working snapshot rather than appended. The first capture also preserves the prior context under `history/legacy/`.
- Newly confirmed decisions are stored separately under `history/decisions/`. Capture history, legacy context, and decisions are excluded from automatic prompt loading; use `/project history`, `/project history legacy`, or `/project decisions` to inspect them on demand.
- Close out a project with a preview and explicit confirmation. The approved closeout is saved, then the current conversation's project selection is cleared.
- Archive and restore projects; move a project to a recoverable trash and restore it later. Context loading is stopped as soon as a project leaves the active state.
- Merge two active projects in the same agent. The source context and reference are appended as quoted data to the target, then the source is archived.
- Move a project between configured agents. The destination receives a newly allocated A/P/B code and copied safe project assets; after the copy is verified, the source is archived with a destination reference.
- Doctor skips a directory only when it carries a private, owner-controlled `.awf-project-fixture.json` marker with schema `awf.project-fixture.v1`, kind `test-fixture`, matching agent and project IDs, and a non-empty reason. Skipped fixture IDs are listed in the result; an invalid marker does not hide the project.
- Run `/project doctor` for read-only checks of project state, references, codes, permissions, context files, and lifecycle logs. Each finding names its project; `/project doctor json` (or the tool's `format: 'json'`) returns the same data machine-readable. Doctor also reports the plugin's own release integrity separately from project findings.
- `/project status` names why no context is active: `no-selection`, `selection-expired`, or `state-generation-changed`.
- Doctor reports archive counts and total history size and flags projects above 2 MiB. Archives are reported, never pruned automatically; `/project history legacy` lists at most 50 records but states the total.
- Doctor shows the loaded plugin version next to the installed manifest and flags `plugin-version-drift` until the Gateway is restarted after an update.
- Every status transition is appended to `history/lifecycle.jsonl` (from/to, generation, timestamp, merge/move detail). Doctor warns when the log is unreadable or behind the project state. A log write failure is reported in the command result; the state change remains authoritative.
- Run `/project repair` for a preview of limited safe repairs. `/project repair confirm` applies only owner-only permission fixes and creation of a minimal missing `KONTEXT.md`; ownership, symlink, reference, and content problems require manual review.
- Run `/project help` for the command list and `/project list` for active projects in the current agent.
- Configure agent-specific code models with `/project config set prefix model AXXX`, `/project config rename prefix AXXX BXXYY`, and `/project config delete prefix AXXX`. X/Y positions are sequential decimal digits. Renamed/deactivated models remain as valid legacy codes for existing projects.
- Configure the future-project location with `/project config set location projects-alt`. Locations must be relative, owner-controlled directories inside that agent's workspace. Existing projects stay where they are and remain listed/selectable.
- Link a project to an exact Codex root with `/project config link P001 /srv/work/example-project`; `/project config unlink P001` removes the link. Selecting that root in Codex loads only the matching active OpenClaw project context for the current agent. The Codex Desktop picker still needs the root registered through its UI.
- On later turns, load only `REFERENZ.md` and optional `KONTEXT.md` from the selected project.
- A failed project creation rolls back the created directory and marks the reserved code `abandoned`; the number is never recycled.
- New working snapshots are limited to 16 KiB. Existing larger context remains readable under the 64 KiB safety ceiling until a confirmed capture compacts it; Doctor flags snapshots above 16 KiB.
- Context files are capped at 64 KiB each; this is the per-file read and write ceiling. For the prompt, reference and context are capped at 24 KiB each and truncated with an explicit marker.
- A failed cross-agent move keeps its partial destination in the workspace `.project-trash/` instead of deleting it.
- Keep allocation append-only and refuse unsafe paths, cross-agent access, invalid files, or stale authority.
- Command and tool results are German. Technical labels (`Release:`, `History:`, `integrity:`, `active`/`archived`/`trash`) and low-level validation errors remain in English.

Capture uses only the conversation visible to the agent and its loaded working snapshot. It does not import chat exports, other conversations, or unrelated workspace files. Captured summaries are quoted as data and cannot change agent instructions. Archives are retained and are not silently pruned.

## Checkpoint compatibility

`/project capture` owns `projects/<id>/KONTEXT.md`. A confirmed capture replaces that file atomically with the compact snapshot headed `# Current project context`; the plugin archives capture history separately and never reads or loads `CHECKPOINTS.md`.

A separate checkpoint helper treats `KONTEXT.md` as read-only. It appends dated events to `projects/<id>/CHECKPOINTS.md` and writes one minimized pointer into the daily memory. Legacy checkpoint blocks inside `KONTEXT.md` remain readable through `--inspect`; the plugin's own archive interface stays `/project history`, `/project history legacy`, and `/project decisions`.

A checkpoint does not refresh the capture snapshot. To include newer work in `KONTEXT.md`, prepare a capture preview and save it only after the owner confirms with `/project capture confirm`.

## Data and security boundaries

- The runtime-supplied active agent and workspace are authoritative.
- A/P/B domains do not cross-read each other's workspaces.
- Project selection is scoped to the active conversation and expires.
- Summary drafts are bound to the agent, conversation, and selected project; they expire after 15 minutes.
- Merge, move, and repair previews are bound to the agent and conversation and expire after 15 minutes. They require `/project transfer confirm` or `/project repair confirm`; transfer previews can be cancelled.
- Code models and project locations are stored per agent in the OpenClaw retained project-config store and are bound to that agent's workspace. Code allocation remains append-only per model; deleted models are disabled rather than erasing historical codes.
- Codex links are stored per OpenClaw project in an owner-only metadata file. The plugin compares only exact canonical paths, and scans links only in the active agent's workspace. It does not read another agent's project files or write to Codex's internal saved-root state.
- Merge is limited to contexts that fit the existing per-file size guard. Move refuses unsafe assets and applies file-count and total-size limits.
- Delete is recoverable trash; this plugin does not permanently erase project data. A failed cross-agent move removes only its own freshly created destination directory.
- Snapshot replacement re-hashes the existing `KONTEXT.md` immediately before the rename, not only when the preview was created.
- `release.json` lists size and SHA-256 for every declared package file. Doctor and `npm run release:verify` report content, version, and manifest/package drift; the manifest is excluded from its own file list.
- Only an authenticated owner command can confirm or cancel a draft.
- Project text is treated as untrusted data.
- No external secret store integration is required.

## Agent portability

The plugin is not limited to the built-in agents (`main`, `privat`, `beruflich-work`).
Any agent id matching `^[a-z0-9][a-z0-9-]{0,63}$` can own projects:

- a configured baseline (`/project config set baseline <prefix> <high-water> <domain>`) always wins;
- otherwise the built-in A/P/B defaults apply;
- for every other agent the prefix is derived from the id (initials, up to four letters,
  `highWater` 0, domain = agent id), so the first project becomes e.g. `R001` for `research`;
- the prefix registry still enforces uniqueness. A derived prefix that another agent already
  holds fails with a clear message instead of silently renumbering; assign it explicitly;
- `/project doctor` reports an `agent-baseline-derived` warning for such an agent, so an
  implicit prefix is visible instead of silent.

## Publishing

The package is publishable metadata-wise (`private: false`, MIT, build metadata,
catalog category). Publishing itself is an explicit owner action and is not part of
any automated flow:

```bash
clawhub login                       # device flow, once per machine
clawhub package validate .          # bundled Plugin Inspector
clawhub package publish . --dry-run --family code-plugin
clawhub package publish . --family code-plugin \
  --topics openclaw,project-context,agent-workspace,productivity
```

Name `@zrzavywa/openclaw-project-context`, display name `Project Context`, plugin id
`awf-project-context`. The id is also the config key under `plugins.entries`, so a
rename would need a migration.

## Status

**Current state:** this file deliberately does not pin a version — it would drift with every release. Authoritative sources are [CHANGELOG.md](CHANGELOG.md) for the release history and `/project doctor` for the installed and loaded version plus release integrity. Deployment target: OpenClaw `>=2026.11.6`. Since 0.7.2 `npm run check:changelog` and the CI workflow fail a release whose version has no changelog section. The repository is still private, `private: true`, and no license is declared, so nothing here is offered for publication.

Earlier deployments (kept for traceability):

This repository contains the private pilot source; it is not published on ClawHub. On 20 November 2026, compact project snapshots and on-demand history were deployed as plugin version 0.2.0 to the OpenClaw 2026.11.6 Gateway. The plugin reload succeeded (runtime generation 13), and runtime inspection reported the plugin loaded with no diagnostics. The previous 0.1.0 installation is backed up under `~/.openclaw/extensions/.openclaw-install-backups/`. A live model-assisted user conversation remains an acceptance check.

Version `0.3.0` added release-integrity verification, a pre-rename snapshot hash gate, project-creation rollback with abandoned reservations, project-scoped Doctor output with JSON, and an append-only lifecycle audit log; it was merged and installed on 2026-11-22. Version `0.4.0` adds quarantine instead of deletion for failed moves, the history size report, loaded-version drift detection, explicit `/project status` reasons, a prompt budget with truncation markers, and a 50-record cap for legacy listings.

Release procedure: run `npm run check:changelog`, then `npm test`, then `npm run release:manifest`, then `npm run release:verify`; the packed tarball must contain the resulting `release.json`. Doctor reports `integrity: MISSING` when an installation has no manifest, which is expected only for development checkouts.

### Codex workspace links

Each project can be linked to exactly one Codex workspace root by its owner:

```bash
/project config link P001 /srv/work/example-project
/project config unlink P001
```

Example mapping — values are illustrative, not shipped data:

| Agent | Code | Codex workspace root |
|---|---|---|
| `main` | `A001` | `/srv/work/example-a` |
| `research` | `R001` | `/srv/work/example-b` |

A link is stored per project and per agent, is validated against canonical and
owner-only paths, and only loads the matching project context when Codex opens
exactly that root. Linking requires a private, owner-controlled project
directory (mode `0700`); the plugin never changes project content while linking.

## Package files

- `index.mjs`: OpenClaw plugin entry; wires the prompt hook, the `awf_project` tool and the `/project` command.
- `project-commands.mjs`: command and tool dispatch, prompt-context assembly and status output.
- `project-helpers.mjs`: shared constants, project listing, selection, context budget and diagnostics.
- `project-creation.mjs`: secure workspace creation and append-only project code allocation.
- `project-lifecycle.mjs`: project state, safe transfer helpers, Doctor findings, and constrained Repair plans.
- `project-config.mjs`: per-agent prefix models and safe, workspace-local project locations.
- `project-codex-link.mjs`: owner-only per-project Codex root links and path validation.
- `project-memory.mjs`: safe capture and decision archives, compact snapshot replacement with a pre-rename hash gate, and on-demand reads.
- `project-release.mjs`: package manifest with per-file SHA-256, drift verification, and the `release.json` CLI.
- `openclaw.plugin.json`: OpenClaw plugin manifest (id, tool contract, activation, config schema, catalog category).
- `CHANGELOG.md`: versioned change history; enforced by `check-changelog.mjs`.
- `check-changelog.mjs`: release gate, not part of the published package files.

## Verification

Run `npm test` for the isolated command and security checks. Run `npm run test:gateway` for a temporary Gateway with a synthetic model; it uses loopback ports 19346 and 19349 and removes its temporary workspace when finished.

Known limitation (revised 2026-11-22 in 0.7.5): `npm run test:gateway` starts its synthetic Gateway and runs the agent turn. The stub model repeats the same `create` call: the first call succeeds and its result reaches the model, the repeat is rejected as a duplicate name. Up to 0.7.4 the host still logged `[tools] awf_project failed:` with an empty message, because `index.mjs` derived `details.ok` from English text prefixes while the messages have been German since 0.5.0; after three repetitions the turn was stopped. 0.7.5 centralises that decision in `resultOk()` and covers it with tests. The run needs roughly 1.1 GB RSS for the Gateway alone, so give it a host or worker without a 2 GiB cap.

Run `npm run release:manifest` after the final change and before packaging, then `npm run release:verify`. The suite covers release drift, the snapshot hash gate, creation rollback with an abandoned reservation, Doctor project IDs and JSON output, and lifecycle log writes.

