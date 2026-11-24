# OpenClaw Project Context – Production Deployment Record

**Date:** 20 November 2026  
**Repository:** [zrzavywa/openclaw-project-context](https://github.com/zrzavywa/openclaw-project-context) (private)  
**Target:** OpenClaw Gateway 2026.11.6 on `vm-openclaw-01`  
**Result:** Project lifecycle operations deployed and hot-reloaded successfully; isolated command, security, and Gateway checks passed.

## Original goal

Provide secure, agent-scoped project context in OpenClaw, similar to ChatGPT Projects: the active A/P/B agent owns the project domain, selected project files load on later turns, and conversation capture requires an explicit human review before writing.

## Included changes

1. `/project status` displays the active project name, code, agent, conversation scope, and automatic context-loading state.
2. `/project capture` asks the agent to draft a summary from the visible conversation. It previews the text without changing project files. Only `/project capture confirm` appends the quoted summary; `/project capture cancel` discards it.
3. `/project close` uses the same preview and confirmation flow, saves the approved closeout, then clears the active conversation's project selection.
4. Archive and restore projects; delete moves to a recoverable trash and never permanently erases files.
5. Merge active projects within one agent with an explicit preview and confirmation; the source is archived after the merge.
6. Move a project between A/P/B agents with a newly allocated destination code; safe assets and context are copied and the source is archived with a destination reference.
7. `/project doctor` reports read-only consistency findings. `/project repair` previews limited safe permission corrections and creation of a missing minimal `KONTEXT.md`; only an explicit confirmation applies them.

Review drafts are bound to the agent, conversation, and selected project and expire after 15 minutes. No Strongbox integration is involved.

## Checks completed

- Node 24.22.3 syntax checks passed for `index.mjs`, `project-creation.mjs`, and `test.mjs`.
- Focused checks passed for project status, preview without writes, authenticated confirmation, cancel, expiry, closeout, and clearing selection. Existing checks also passed for A/P/B code assignment, project creation, session continuity, agent and conversation isolation, safe file loading, and authorization.
- OpenClaw 2026.11.6 plugin lint completed with zero warnings.
- Isolated OpenClaw runtime inspection loaded the plugin with `awf_project`, `/project`, one active prompt hook, and no diagnostics.
- Synthetic Gateway smoke passed on OpenClaw 2026.11.6: natural-language project creation, visible `/project status` card, and automatic context injection on the following turn.
- New lifecycle checks passed on Node 24.22.3 using synthetic A/P/B workspaces: archive, restore, recoverable trash, merge, cross-agent move, read-only Doctor, confirmed Repair, and existing capture/closeout isolation.
- Synthetic Gateway smoke was repeated with the complete plugin package; natural-language creation, status card, and next-turn project context passed.
- Plugin lint on the complete candidate package returned zero warnings. Runtime inspection after production reload showed `awf_project`, `/project`, one active `before_prompt_build` hook, and no plugin diagnostics. Gateway health returned `OK`.
- No real project files were created or changed during verification.

## Production change

`index.mjs` was atomically replaced and the new `project-lifecycle.mjs` helper was installed in the existing plugin directory. The Gateway configuration, project workspaces, and other plugins were left unchanged.

- Installed file: `/home/openclaw/.openclaw/extensions/awf-project-context/index.mjs`
- Previous file SHA-256: `bac3e19ac730dffc30a96a56d0b067d1f811cb0e636b2e2b56c9ff7df504e1dc`
- Deployed `index.mjs` SHA-256: `d5fa174cbda9c47a9f09e1a4bc78004abc29f43d796e2a3a5cba3fb7471b434e`
- Deployed `project-lifecycle.mjs` SHA-256: `86eb8cbf1395cf015b6ded5b6c679ae14ec4ed4cc061b4f56e7097e49961acde`
- Rollback copy: `/home/openclaw/.openclaw/backups/awf-project-context/index.mjs.20261120T0726Z.bak`
- Reload result: success, runtime generation `5`; restart not required.

## Remaining acceptance gate

All lifecycle operations passed in isolated workspaces, and the creation/status/context path passed in a synthetic OpenClaw Gateway. No merge, move, archive, trash, or repair was run against a real project. A live user conversation with model-generated capture remains an acceptance check. ClawHub publication remains out of scope; this repository is private.


## Codex project-root integration – 20 November 2026

The per-project Codex-root link feature was merged and installed on `vm-openclaw-01`.

- GitHub PR: [#5](https://github.com/zrzavywa/openclaw-project-context/pull/5)
- Merge commit: `d040057af57c5ce53e2973638ee09c1a8c4c6551`
- Plugin reload: successful, runtime generation `9`; restart was not required.
- Plugin lint: complete, 8 files scanned, zero warnings.
- Project tests: passed on Node 24.22.3.
- Gateway health: `ok`; `awf-project-context` loaded; no plugin errors.
- Synthetic hook verification: all 13 registered A/P/B project links returned their expected context.
- No project context content was rewritten. Project directory modes were tightened from `0775` to `0700` for the three agent `projects` roots and 13 registered project directories so owner-only link metadata cannot be replaced through group/world write access.
- P007's profile heading was normalized to include its existing `P007` code. A pre-change copy is held on the VM at `/home/openclaw/.openclaw/backups/awf-project-context/p007-REFERENZ.before-codex-link.md`.
- P007 uses its existing OpenClaw profile directory as its Codex root because it has no separate checkout.

All project-code-to-root mappings are recorded in the README's “Production Codex links” table. Codex Desktop's own saved-root picker is separate from this OpenClaw configuration. Roots that are not already visible in that picker still need to be added through the Codex UI. A live model-assisted Codex-to-OpenClaw conversation remains the final acceptance check.
