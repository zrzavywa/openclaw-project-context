# Changelog

## [0.16.0] - 2026-11-24

### Fixed

- A capture request that never reaches the tool is no longer reported as "nothing requested".
  `/project capture` now records an `awaiting-summary` marker; if the summary text is never passed
  to `awf_project` with `action=capture-preview`, `/project capture confirm` names the request time,
  the project and the cause instead of claiming no summary was waiting. Nothing is written in that case.
- New tests C1-C5 cover the unfilled request, the unchanged project files, and the fact that a marker
  neither blocks a later preview nor survives a successful confirmation.

Notable changes to the OpenClaw Project Context plugin are documented here.
The repository did not use release tags for the early pilot work, so the initial
features are grouped as an unversioned pilot instead of assigning them invented
version numbers. Dates below are the dates recorded in the repository history.

## [0.15.4] - 2026-11-24

### Security

- Automatic loading no longer runs for conversations the owner does not control. The prompt hook
  read project files after checking only agent and session identifiers, which prove who a turn
  belongs to but not who may read a project. A message naming a project in a conversation with
  non-owner participants could therefore pull the reference and working snapshot into that
  conversation (CWE-862, reported as MCP07 against 0.15.2). Mention loading and Codex-workspace
  auto-linking now require a host owner signal: `senderIsOwner` when the host supplies it to the
  hook, or the host-minted `owner-private` audience. Anything else fails closed with
  `deny:auto-load-unauthenticated` and reads nothing, so an ambiguous mention reveals no project
  inventory to a non-owner either. The audience is re-asked before context is published
  (`deny:audience-changed`).
- Explicit selections and `/project` commands are unchanged: they require command authority, and a
  selection is bound to the session that created it.
- New tests Z1-Z5.

## [0.15.3] - 2026-11-24

### Fixed

- `npm run status` now works for installed copies. `project-status.mjs` was documented in the
  README and referenced by the `status` script since 0.15.0, but it was missing from `files` in
  `package.json` and from the release manifest, so the published package shipped a script that
  pointed at a file which did not exist. The file is now packaged and covered by the manifest.
- New tests Y1 and Y2: every entry in `files` must exist, and the `status` script must resolve to
  a packaged file.

## [0.15.2] - 2026-11-24

### Security

- Bounded capture diff (CWE-400, found by the ClawHub audit for 0.15.1, finding MCP05).
  `diffLines` allocated a longest-common-subsequence matrix of `(left+1) x (right+1)`
  `Uint32` cells. The byte limits on the working snapshot (64 KiB) and the summary
  (6 000 bytes) do not bound the product of their line counts: a context of 65 535
  newlines against a summary of 2 999 short lines produced roughly 197 million cells,
  about 750 MiB of typed-array storage, synchronously inside the gateway process.
  The matrix is now budgeted before allocation (`MAX_DIFF_LINES`, `MAX_DIFF_CELLS`);
  above the budget no matrix is built and the preview says so instead.
- `import` now refuses a working state above the snapshot limit and a reference above
  the per-file limit before writing anything.
- Regression tests X1-X6: line-heavy pair returns the bounded message quickly, the
  bounded flag is set, a small change still produces a diff, a below-budget diff is
  still computed, and oversized context/reference imports are refused.

## [0.15.1] - 2026-11-24

### Fixed

- Gateway smoke harness: the model stub recognised only the English success text
  `Created and selected A004`. Since the UI is German and the code is dynamic, a successful
  run looked like a miss, the stub re-issued `create`, the plugin correctly refused the
  duplicate name, and the host aborted the turn after three identical errors. The stub now
  accepts `Erstellt und ausgewählt` as well, and the two closing assertions accept it too. The smoke test never passed for that reason —
  it was a harness defect, not a plugin defect: the run did create the project.

## [0.15.0] - 2026-11-24

### Added

- `npm run status` (script `project-status.mjs`) reports repo commit and version, installed version,
  and optional `--online` mirror tag and catalog latest. Read-only, `UNKNOWN` instead of guessed
  values, no network without the flag.
- README section "Status at a glance" pointing at the script.
- Acceptance tests T1-T4 and T8: repo values, missing installation, offline `UNKNOWN`, no writes,
  and a simulated version change visible without editing any document.

### Changed

- Project documentation no longer carries volatile state. The reference table points at
  `npm run status` instead of naming commits, tags, catalog versions and install state that go
  stale within hours. Historical merge hashes and past change-log entries stay unchanged.

## [0.14.0] - 2026-11-23

### Added

- `/project history prune` previews capture and decision records older than `retentionDays`
  (default 180, 0 disables) with the affected count and bytes; `/project history prune confirm`
  moves them to `history/pruned/<date>/`. The newest five captures and three decisions always
  stay, nothing is deleted, and the run is recorded in the lifecycle log.
- Export files now carry a SHA-256 `digest`; `/project import` verifies it and refuses a file that
  changed after export. Older exports without a digest still import, with an explicit notice.
- Acceptance tests R1-R8 (retention) and D1-D5 (digest).

### Notes

- The digest also covers `exportedAt`, so it identifies one file, not one project state. The draft
  asked for two exports of the same state to share a digest; that expectation was wrong and the
  test now changes content between exports instead.

## [0.13.0] - 2026-11-23

### Added

- Optional context loading by name mention: with `autoLoadOnMention` enabled, a message that names
  exactly one project loads its context for the turn, even without a selection. Off by default.
  Matching uses whole words with a four-character minimum for the name, or the exact code; an
  explicit selection always wins, ambiguous mentions load nothing and list the candidates, and
  nothing is written.
- Acceptance tests M1-M10 cover the unique name, the unique code, case-insensitivity, partial
  words, ambiguity, the default-off switch, selection precedence, unchanged hashes and archived
  projects.

### Fixed

- Two acceptance tests archived a project with reversed arguments, so S10 passed without ever
  archiving. Both now use the documented argument order.

## [0.12.1] - 2026-11-23

### Added

- README: "Where your data lives" with the project folder layout and a limits table (snapshot,
  project file, record, export, carried history, doctor threshold).
- README: "What this plugin does not do" - no chat exports, no network, no index or embeddings,
  no automatic pruning, no encryption at rest.
- README: "Troubleshooting" for the failures seen in real use - drain timeout after install,
  `install-source-drift`, `plugin-version-drift`, the stale hint, permission refusals, and a
  ClawHub publish stuck at `pending`.

Docs-only change. No behaviour change.

## [0.12.0] - 2026-11-23

### Added

- `/project export <code>` writes one JSON file (`awf.project-export.v1`) to
  `<agent workspace>/project-exports/`: reference, working snapshot, captures and decisions.
  It never writes into the project and never includes selection state, the ledger or Codex links.
- `/project import <path>` creates a **new** project with a fresh code from such a file and records
  the source in a `## Herkunft` section. Existing projects are never overwritten.
- Guards: owner-only, absolute path, regular file, size cap, UTF-8 validation, schema check,
  required reference, valid record ids, record size limit; a failed import removes the created folder.
- Acceptance tests E1-E12 cover the export shape, the missing selection/Codex data, the new code on
  import, every rejection path, the listing of the imported project, the untouched source and the
  round-trip counts.

## [0.11.0] - 2026-11-23

### Added

- `/project search <term>` and the `search` tool action: searches `REFERENZ.md`, `KONTEXT.md`,
  capture history and the decision archive of this agent's active projects. Terms are
  AND-combined, case-insensitive and never treated as patterns; at most 20 hits are shown with
  the number of further matches.
- Read-only by design: no index file, no writes, no network access. Archived and trashed
  projects are not searched.
- Acceptance tests S1-S10 cover hits per source, case-insensitivity, AND semantics, empty and
  too-short queries, the hit limit, unchanged file hashes, and archived projects.

## [0.10.0] - 2026-11-23

### Added

- Capture preview shows what would change: a unified diff against the current
  `KONTEXT.md`, capped at 40 lines with the number of omitted lines named. The diff is
  display only; nothing is written before `/project capture confirm`.
- Stale-context hint: one line when a loaded snapshot is older than `staleContextDays`
  (default 14, `0` disables), at most once per project and day. A missing or unreadable
  snapshot produces no hint and no error.
- Doctor reports `install-source-drift` when the plugin is loaded through
  `plugins.load.paths` instead of a registered installation. Unknown local metadata is
  treated as unknown, never as an error, and the check uses no network access.

### Changed

- A project without `KONTEXT.md` now yields an empty diff base instead of failing the
  digest step of a capture preview.

## [0.9.4] - 2026-11-23

### Added

- Install quickstart in the README: the ClawHub install command, the plugin entry with the
  conversation-access and prompt-injection permissions the context injection needs, and the
  first three commands.
- `CONTRIBUTING.md`: where changes are made, what a useful problem report contains, how to run
  the checks, and the boundaries a change must not break.

Docs-only change. No behaviour change.

## [0.9.3] - 2026-11-23

### Added

- Command reference in the README: every `/project` command grouped by task (start and select,
  context and history, lifecycle and recovery, diagnosis, configuration, transfer) with a one-line
  description, plus the matching `awf_project` tool actions and the preview/confirm boundary.
- Explicit goal sections. "Why this exists" states the problem the plugin solves; "What you get"
  lists the guarantees: isolation, deliberate loading, consent before writes, non-destructive
  deletion, and owner-controlled naming.

### Changed

- The tagline no longer describes the package as a private plugin project; it describes the
  published plugin.

Docs-only change. No behaviour change.

## [0.9.2] - 2026-11-22

### Changed

- Generalised for a public release: the agent-facing tool description and prompt
  guidance address "the user" instead of a specific person, the built-in default
  domains are neutral (`agent`, `private`, `work`) and a newly created project no
  longer records a personal owner name by default.
- `repository` points at the public source repository.

### Note

- No behaviour change for existing projects; stored domains and project profiles are
  not rewritten.

## [0.9.1] - 2026-11-22

### Documentation

- README examples are synthetic now. The Codex-links section no longer lists a real
  project inventory (names, profiles and absolute paths); it shows one illustrative
  mapping and documents the link command with placeholder paths.
- Removed remaining vendor-specific wording from the README (external checkpoint
  helper, external secret store).
- Preparation for publication: the package no longer discloses a user's project
  directory layout. Release history in this file keeps its original wording.

## [0.9.0] - 2026-11-22

### Changed

- `private` is now `false`: the package is publishable metadata-wise. Nothing is
  published by this change — the ClawHub publication itself stays an explicit owner
  action.
- README documents the publish command including topics, so the next step is
  reproducible instead of remembered.

### Note

- No runtime change. Version 0.9.0 marks the publication-ready metadata set.

## [0.8.4] - 2026-11-22

### Changed

- Manifest display name is neutral: `Project Context` instead of `AWF Project Context`.
  The plugin id `awf-project-context` stays unchanged, so existing
  `plugins.entries.awf-project-context` configuration and the running installation keep
  working. Only the catalog/listing label and `plugins list` output change.

## [0.8.3] - 2026-11-22

### Changed

- The published package no longer ships the test harness: `test.mjs`,
  `gateway-smoke.sh`, `gateway-fixture.mjs` and `gateway-model-stub.mjs` stay in the
  repository but are dropped from `files` (~50 KB less for every installer).
- `SECURITY.md` added with a private reporting channel and the data-touching scope.

## [0.8.2] - 2026-11-22

### Added

- `openclaw.build.openclawVersion` and `openclaw.build.pluginSdkVersion` (2026.11.6),
  plus `openclaw.compat.minGatewayVersion`. ClawHub refuses external code plugins
  without the build declaration, so `clawhub package publish --dry-run` failed
  before this change.
- The ClawHub Plugin Inspector reports PASS for the packed 0.8.1 package
  (0 breakages, 0 warnings, 0 findings).

## [0.8.1] - 2026-11-22

### Added

- Doctor reports a warning (`agent-baseline-derived`) when an agent runs on a derived
  baseline instead of a configured or built-in one, including the effective prefix,
  high-water mark and domain.

### Tests

- `research` (derived baseline) doctor shows the warning; `main` does not.
- Migration case: an allocation ledger without the agent's domain is extended on the
  next reservation, and the existing domains stay byte-identical.

## [0.8.0] - 2026-11-22

### Added

- Agents are no longer limited to the built-in A/P/B table. `deriveAgentBaseline()` gives
  every other agent a prefix from its initials (up to four letters, `highWater` 0, domain =
  agent id), and `resolveAgentBaseline()` is now the single resolver: configured baseline,
  then built-in default, then derivation.
- The allocation ledger creates a missing agent domain on first use instead of failing.
- Tool schema and `/project move` accept any agent id matching `^[a-z0-9][a-z0-9-]{0,63}$`.

### Changed

- Gates that treated the A/P/B table as an allow-list (agent config bootstrap, project
  resolution, listing, selection validity, move target) now validate the id shape instead.
- Regression tests cover a fourth, unconfigured agent (`research` → `R001`, list, config,
  select) next to the existing A/P/B behaviour.

### Known limits

- A derived prefix that is already held by another agent fails with a message instead of
  being adjusted automatically; assign it with `/project config set baseline`.
- No Doctor warning yet for agents running on a derived baseline (follow-up).
- User-facing texts stay German; portability is not localisation.

## [0.7.7] - 2026-11-22

### Added

- MIT license (`LICENSE`, `package.json` field, package file list). The repository
  stays private for now; the license only removes the legal blocker for a later
  publication decision.

### Unchanged

- `private: true` remains set, so no publish is possible or implied by this change.

## [0.7.6] - 2026-11-22

### Documentation

- The README status section no longer repeats a concrete version. It pointed at
  0.7.3 while 0.7.5 was installed, the same drift the changelog gate was meant to
  stop. It now names the authoritative sources (CHANGELOG, `/project doctor`) and
  keeps the deployment target only.

## [0.7.5] - 2026-11-22

### Fixed

- `details.ok` is derived from the actual message text again. `index.mjs` compared
  English prefixes (`Created and selected `, `Doctor could not`, `Project status change
  blocked`, …) while the messages have been German since 0.5.0, so successful calls
  reported `ok:false`; the host then logged `[tools] awf_project failed:` without a
  message and stopped a turn after three identical repetitions.
- One authoritative failure-prefix list in `project-commands.mjs` (`resultOk()`), used
  by every tool branch, with regression tests for success, blocked create, doctor
  failure and preview results.

### Documentation

- README limitation corrected: the gateway smoke run does not lose the tool result;
  the stub repeats the create call and the repeated duplicate was misreported as a failure.

## [0.7.4] - 2026-11-22

### Documentation

- README status section now states the current deployment (0.7.3 loaded) and keeps
  the earlier 0.2.0–0.4.0 reports as historical traceability instead of presenting
  them as current state.
- README release procedure includes the changelog gate; package file list covers the
  modules added by the 0.6.0 split, `CHANGELOG.md` and `check-changelog.mjs`.

## [0.7.3] - 2026-11-22

### Changed

- Package metadata only: `repository` and `keywords` added so tooling and a later
  catalog listing can identify the source. `private` stays `true`; the license
  choice is still an owner decision, so no publishable package is claimed.

## [0.7.2] - 2026-11-22

### Added

- `check-changelog.mjs` gate: `npm run check:changelog` fails when `package.json`
  names a version that has no topmost CHANGELOG section, so a release cannot ship
  without its own entry again.
- GitHub Actions CI (`.github/workflows/ci.yml`) on Node 22 and 24: changelog gate,
  test suite, release verification and a reproducibility check that regenerating
  `release.json` produces no diff.

### Changed

- Manifest metadata for catalog discovery: `description`, one category
  (`productivity`), explicit `uiCapabilities: []` and `toolMetadata` marking
  `awf_project` as side-effecting. No runtime behaviour changed.

## [0.7.1] - 2026-11-22

### Documentation

- `CHANGELOG.md` is now part of the published file set and the release manifest,
  so the changelog cannot drift from the packaged files unnoticed any more.
- Backfilled the missing 0.6.0–0.7.0 entries below from the merged pull requests
  (#24–#30) and the commit history. They were not written at release time; the
  wording is a retrospective summary, not a release-time record.

## [0.7.0] - 2026-11-22

### Added

- Prefixes are unique across agents through a dedicated registry
  (`awf.project-prefix-registry.v1`, record `prefix-registry` in the same store),
  pre-filled with the standard prefixes A/P/B. The allocation ledgers stay
  untouched. Limit: uniqueness is enforced on the baseline path only.

## [0.6.5] - 2026-11-22

### Added

- `/project help` names the loaded plugin version in its header, so the build that
  answers is visible without running Doctor.

## [0.6.4] - 2026-11-22

### Documentation

- The help text lists `/project config set baseline <prefix> <high-water> <domain>`
  including its rejection rule. The command worked since 0.6.3 but was not
  discoverable.

## [0.6.3] - 2026-11-22

### Added

- `/project config set baseline <prefix> <high-water> <domain>` changes the code
  baseline through the command surface and refuses a high-water mark below the
  highest code already assigned.

## [0.6.2] - 2026-11-22

### Added

- Optional per-agent code baseline (`{ prefix, highWater, domain }` in the agent
  project configuration) overriding the built-in A/P/B assignment with 3/7/4.
- Usage warning once a code range reaches 90 percent; no automatic renumbering.

## [0.6.1] - 2026-11-22

### Changed

- Codex workspace auto-selection caches its lookups per resolved root instead of
  scanning every project folder on each turn.

## [0.6.0] - 2026-11-22

### Changed

- Structure only, no behaviour change: `index.mjs` dropped from 1,170 to 259 lines
  and its helpers and commands moved into `project-helpers.mjs`,
  `project-commands.mjs`, `project-creation.mjs`, `project-lifecycle.mjs`,
  `project-config.mjs`, `project-codex-link.mjs`, `project-memory.mjs` and
  `project-release.mjs`.

## [0.5.5] - 2026-11-22

### Documentation

- README states the known limitation of `npm run test:gateway`: the synthetic
  Gateway starts and the agent runs, but the host rejects the `awf_project`
  call after the handler returns and logs it without text. The gateway run is a
  harness smoke test; functional behaviour is verified in an interactive owner
  session.

## [0.5.4] - 2026-11-22

### Fixed

- Tool error diagnostics actually reach the gateway log now: `api.logger`
  exposes `info`, not necessarily `error`, so the previous
  `log.error?.(...)` call was a silent no-op. The handler falls back through
  `error → warn → info → console.error` and passes one message string.

## [0.5.3] - 2026-11-22

### Changed

- Tool diagnostics go through `api.logger` (falling back to `console`) instead
  of `console` alone; the gateway log is the documented sink.
- `create()` refuses to publish the tool when the host context has no
  `assertInvocationCurrent`, and warns once. Previously the tool was offered and
  every call failed inside the runtime without text.

## [0.5.2] - 2026-11-22

### Added

- The `awf_project` tool logs the full error (stack when available) to the
  gateway log before rethrowing. OpenClaw's own line only says
  `[tools] awf_project failed:` without text, which made a failing smoke run
  undiagnosable.

## [0.5.1] - 2026-11-22

### Fixed

- `npm run test:gateway` could never start its synthetic gateway: the harness
  launched `openclaw gateway run` without a port, so it fell back to the
  configured default (18789), hit the running systemd gateway and exited with
  code 78. The harness now passes `--port 19349 --allow-unconfigured`
  explicitly and waits up to 40 seconds for readiness, which matches the
  measured 13–16 second startup.

## [0.5.0] - 2026-11-22

### Changed

- Module-level validation errors are now German as well, so a blocked action
  reads consistently end to end instead of switching language inside the
  message. Covered: project configuration, Codex links, project creation,
  lifecycle and asset transfer, state and memory handling, selection and
  authorization, and release integrity.
- Tests assert the new wording.

## [0.4.2] - 2026-11-22

### Documentation

- Clarify that `/project capture` owns the compact `KONTEXT.md` snapshot and
  that the AWF `checkpoint.py` helper keeps that file read-only, writing its
  dated events to `CHECKPOINTS.md` instead.

## [0.4.1] - 2026-11-22

### Changed

- All user-facing command and tool results now use German consistently:
  creation, selection, status, capture/close, configuration, Codex links,
  repair, merge/move, archive/trash/restore, and the Doctor header.
  Technical labels (`Release:`, `History:`, `integrity:`, status values) and
  module-level validation errors stay as-is.

## [0.4.0] - 2026-11-22

### Added

- History size report: Doctor shows archive counts and total size per agent and
  flags projects above 2 MiB. No automatic pruning; archives stay retained.
- Doctor reports the loaded plugin version next to the installed manifest and
  flags `plugin-version-drift` when an installation has not been reloaded yet.
- `/project status` names the reason when no context loads
  (`no-selection`, `selection-expired`, `state-generation-changed`).

### Changed

- Failed cross-agent move now moves its partial destination directory into the
  workspace `.project-trash/` instead of deleting it.
- Loaded project files are capped at 24 KiB each for the prompt; longer files are
  truncated with an explicit marker and the full file stays in the project.
- Legacy context listings are capped at 50 records while still reporting the
  total.

## [0.3.0] - 2026-11-22

### Added

- Doctor skips a project only with a valid private `.awf-project-fixture.json`
  test-fixture marker and lists the skipped IDs. This reconstructs behavior
  that was already present in the 2026-11-21 production installation but had no
  repository history.

- `project-release.mjs` plus `npm run release:manifest` and
  `npm run release:verify`: manifest every declared package file with size and
  SHA-256, detect content drift, version drift, and manifest/package mismatches.
- Doctor reports the plugin's own release integrity separately from project
  findings, names the affected project in each finding, and supports
  `format: 'json'` / `/project doctor json`.
- Append-only audit log `history/lifecycle.jsonl` for status transitions with
  from/to, generation, timestamp, and merge/move detail. Doctor flags unreadable
  or stale lifecycle logs.

### Changed

- Snapshot replacement re-hashes the existing `KONTEXT.md` immediately before
  the rename, so an in-place rewrite cannot be replaced silently.
- A failed project creation now rolls back its directory and marks the reserved
  code `abandoned` instead of leaving a half-created active project.

### Notes

- Lifecycle logging is secondary to project state: a log write failure is
  reported in the command result, and the state change itself stays
  authoritative.
- No production deployment was performed for this version.

## [0.2.0] - 2026-11-20

### Added

- Archive each confirmed capture under `history/captures/` and newly confirmed
  decisions under `history/decisions/`.
- Read capture history, legacy context, and decisions on demand with
  `/project history`, `/project history legacy`, and `/project decisions`.
- Preserve the initial `KONTEXT.md` as legacy history on the first successful
  capture.

### Changed

- Replace `KONTEXT.md` with a compact working snapshot on confirmed capture,
  rather than appending each capture indefinitely.
- Limit new snapshots to 16 KiB while retaining the existing 64 KiB safety
  ceiling for reading and writing project context files.
- Keep archived history outside automatic context loading; later turns still
  load the selected project's `REFERENZ.md` and optional `KONTEXT.md`.

### Fixed

- Escape the example `/project … <ID>` command in the project-history response
  so the plugin loads successfully.

### Production

- Installed on the OpenClaw 2026.11.6 Gateway on 2026-11-20. The plugin was
  reloaded as runtime generation 13 and reported loaded with no diagnostics.
  The previous 0.1.0 installation was retained as a recoverable backup.

## Initial pilot (unversioned) - 2026-11-20

These features predate the first numbered release. Their commits are in the
repository history, but no earlier release tags were found; this section is
therefore a reconstructed feature history, not a claim that each item shipped
as a separate version.

### Added

- Create and select projects in the current agent's workspace, with agent-scoped
  A/P/B project codes and append-only allocation.
- Load the selected project's context for the active conversation, scoped to
  that conversation and agent.
- Preview and explicitly confirm project captures, closeouts, transfers, and
  safe repair operations before applying changes.
- Manage project lifecycle: merge projects, archive and restore them, move them
  between agents with a destination code, and move deleted projects to a
  recoverable trash.
- Inspect project state with `/project doctor`; safely repair a narrow set of
  missing files and permission issues after confirmation.
- Use `/project help` and `/project list`; configure per-agent code-prefix
  models and locations for newly created projects.
- Link an OpenClaw project to an exact Codex workspace root, supporting context
  lookup from either the OpenClaw project selection or the configured Codex
  workspace link.

### Changed

- Raise the per-file project-context safety limit from 32 KiB to 64 KiB.
- Add owner-only Codex link metadata and enforce exact canonical-path matching
  within the active agent's workspace.

### Production

- Deployed project configuration, lifecycle management, and Codex links to the
  OpenClaw 2026.11.6 Gateway during the 2026-11-20 pilot rollout. The repository
  README records the production project links and their verification scope.

## Source history

- Initial pilot: [repository commits](https://github.com/zrzavywa/openclaw-project-context/commits/main/)
- 0.2.0 snapshots and history: [PR #9](https://github.com/zrzavywa/openclaw-project-context/pull/9)
- 0.2.0 production status: [PR #10](https://github.com/zrzavywa/openclaw-project-context/pull/10)
- History command syntax fix: [PR #11](https://github.com/zrzavywa/openclaw-project-context/pull/11)
