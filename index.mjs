import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProjectWorkspace, reserveProjectDisplayId, abandonProjectDisplayId } from './project-creation.mjs';
import { PROJECT_AGENT_CONFIG_SCHEMA, defaultProjectAgentConfig, validateProjectAgentConfig,
  normalizeProjectLocation, resolveProjectLocations, parseProjectCodeModel, projectCodeModels } from './project-config.mjs';
import { PROJECT_STATE_SCHEMA, PROJECT_STATUSES, readProjectState, transitionProjectState,
  diagnoseProjectWorkspace, buildProjectRepairPlan, applyProjectRepairPlan,
  inspectProjectAssets, copyProjectAssets, quarantineProjectDirectory } from './project-lifecycle.mjs';
import { readProjectCodexLink, writeProjectCodexLink, removeProjectCodexLink, validateCodexRoot } from './project-codex-link.mjs';
import { PROJECT_SNAPSHOT_MAX_BYTES, readProjectMemoryRecords, saveApprovedProjectMemory } from './project-memory.mjs';
import { inspectReleaseDirectory } from './project-release.mjs';
import { LOAD_MARKER_PREFIX, describeLoadState, readInstalledVersion } from './project-runtime.mjs';
import { PLUGIN_ROOT, LOADED_VERSION, CONTEXT_FILES, MAX_PROJECT_FILE_BYTES, MAX_REVIEW_BYTES, PROMPT_CONTEXT_MAX_BYTES, PROMPT_REFERENCE_MAX_BYTES, REVIEW_TTL_MS, SELECTION_TTL_MS, assertCommandAuthority, budgetedSection, canonicalWorkspace, contextDiagnostic, contextErrorCode, findCodexWorkspaceProject, formatProjectCard, isAutoLinkClearCurrent, isSelectionCurrent, listProjects, makeAutoLinkClear, makeSelection, readOptionalProjectFile, readProjectFile, resolveSelectedProject, safeSummary, selectionIdentity, sha256, truncateUtf8 } from './project-helpers.mjs';
import { prepareWorkspaceProjectCommands, resultOk } from './project-commands.mjs';
export { prepareWorkspaceProjectCommands };



export default function register(api) {
  if (api?.pluginConfig?.enabled !== true) return;
  const log = api?.logger ?? console;
  // Loaded-version marker: the CLI verify script compares this line with the installed package.
  try {
    const tools = Object.keys(api?.contracts?.tools ?? {}).length;
    log.info?.(`${LOAD_MARKER_PREFIX} ${LOADED_VERSION ?? 'unknown'} tools=${tools} commands=1 hooks=1`);
  } catch { /* logging is best effort */ }
  const selectionOptions = { namespace: 'awf-project-conversation-selection-v1', maxEntries: 2000,
    overflowPolicy: 'reject-new', defaultTtlMs: SELECTION_TTL_MS };
  const selectionStore = api.runtime.state.openKeyedStoreV2(selectionOptions);
  const selectionStoreForCommand = (assertCurrent) => api.runtime.state.openKeyedStoreV2(selectionOptions, { assertCurrent });
  const allocationStoreForCommand = (assertCurrent) => api.runtime.state.openKeyedStoreV2(
    { namespace: 'awf-project-code-allocation-v1', retention: 'retained' }, { assertCurrent });
  const reviewOptions = { namespace: 'awf-project-summary-review-v1', maxEntries: 2000,
    overflowPolicy: 'reject-new', defaultTtlMs: REVIEW_TTL_MS };
  const reviewStore = api.runtime.state.openKeyedStoreV2(reviewOptions);
  const reviewStoreForCommand = (assertCurrent) => api.runtime.state.openKeyedStoreV2(reviewOptions, { assertCurrent });
  const repairOptions = { namespace: 'awf-project-repair-review-v1', maxEntries: 2000,
    overflowPolicy: 'reject-new', defaultTtlMs: REVIEW_TTL_MS };
  const repairStoreForCommand = (assertCurrent) => api.runtime.state.openKeyedStoreV2(repairOptions, { assertCurrent });
  const transferOptions = { namespace: 'awf-project-transfer-review-v1', maxEntries: 2000,
    overflowPolicy: 'reject-new', defaultTtlMs: REVIEW_TTL_MS };
  const transferStoreForCommand = (assertCurrent) => api.runtime.state.openKeyedStoreV2(transferOptions, { assertCurrent });
  const projectConfigOptions = { namespace: 'awf-project-agent-config-v1', retention: 'retained' };
  const projectConfigStore = api.runtime.state.openKeyedStoreV2(projectConfigOptions);
  const projectConfigStoreForCommand = (assertCurrent) => api.runtime.state.openKeyedStoreV2(projectConfigOptions, { assertCurrent });
  const commands = prepareWorkspaceProjectCommands({ selectionStore, selectionStoreForCommand, allocationStoreForCommand,
    reviewStore, reviewStoreForCommand, repairStoreForCommand, transferStoreForCommand,
    projectConfigStore, projectConfigStoreForCommand,
    pluginLoadPaths: () => api.runtime.config.current()?.plugins?.load?.paths ?? [],
    autoLoadOnMention: () => api.pluginConfig?.autoLoadOnMention === true,
    runtimeState: () => describeLoadState({ loadedVersion: LOADED_VERSION,
      installedVersion: readInstalledVersion(`${PLUGIN_ROOT}/package.json`) }),
    retentionDays: () => { const value = api.pluginConfig?.retentionDays; return Number.isInteger(value) ? value : 180; },
    staleContextDays: () => {
      const configured = Number(api.pluginConfig?.staleContextDays);
      return Number.isFinite(configured) ? configured : 14;
    },
    resolveWorkspaceDir: (config, agentId) => api.runtime.agent.resolveAgentWorkspaceDir(
      config ?? api.runtime.config.current(), agentId) });
  api.on('before_prompt_build', commands.hook);
  const projectToolContext = {
    contextVersion: 2,
    create(context) {
      const workspaceConfig = context.runtimeConfig ?? context.config;
      const identityReady = context.senderIsOwner === true && typeof context.agentId === 'string' &&
        typeof context.sessionKey === 'string' && context.sessionKey && typeof context.workspaceDir === 'string' &&
        context.sandboxed !== true && workspaceConfig;
      if (!identityReady) return null;
      if (typeof context.assertInvocationCurrent !== 'function') {
        log.warn?.('[awf_project] tool context has no assertInvocationCurrent; tool not registered');
        return null;
      }
      // The exact active workspace is host supplied. Avoid resolving a mutable config
      // outside the runtime's publication batch; hook checks rebind to ctx.workspaceDir.
      if (typeof context.workspaceDir !== 'string' || !path.isAbsolute(context.workspaceDir)) return null;
      return {
        name: 'awf_project',
        catalogMode: 'direct-only',
        description: 'Manage projects for the current OpenClaw agent. Use only after the user explicitly asks to create, list, select, inspect, or clear a project. The agent identity comes from the active runtime; never ask the user to choose an agent.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['help', 'create', 'list', 'archived', 'select', 'status', 'clear', 'archive', 'trash', 'restore', 'doctor', 'repair-preview', 'merge-preview', 'move-preview', 'config', 'capture-preview', 'close-preview', 'history', 'decisions', 'search', 'export', 'import'] },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            project: { type: 'string', minLength: 1, maxLength: 128 },
            target: { type: 'string', minLength: 1, maxLength: 128 },
            targetAgent: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
            setting: { type: 'string', enum: ['show', 'set-model', 'rename-prefix', 'delete-prefix', 'set-location', 'set-baseline', 'link-codex', 'unlink-codex'] },
            value: { type: 'string', minLength: 1, maxLength: 4096 },
            summary: { type: 'string', minLength: 1, maxLength: MAX_REVIEW_BYTES },
            recordId: { type: 'string', pattern: '^(latest|[a-f0-9]{24})$' },
            recordSection: { type: 'string', enum: ['captures', 'decisions', 'legacy'] },
            query: { type: 'string', minLength: 2, maxLength: 80 },
            format: { type: 'string', enum: ['text', 'json'] },
          },
          required: ['action'],
          additionalProperties: false,
        },
        async execute(_toolCallId, params) {
          try {
          const assertCurrent = () => {
            context.assertInvocationCurrent();
            context.assertMemoryAudienceCurrent?.();
          };
          const toolCtx = {
            agentId: context.agentId,
            sessionKey: context.sessionKey,
            sessionId: context.sessionId,
            workspaceDir: context.workspaceDir,
            config: workspaceConfig,
            senderIsOwner: context.senderIsOwner,
            assertOwnerCurrent: assertCurrent,
          };
          assertCurrent();
          if (params.action === 'create') {
            if (typeof params.name !== 'string') return { content: [{ type: 'text', text: 'Ein Projektname ist erforderlich.' }], details: { ok: false } };
            const result = await commands.createProject(toolCtx, params.name);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'help') {
            const result = await commands.helpProject();
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: true } };
          }
          if (params.action === 'config') {
            const result = params.setting === 'link-codex'
              ? await commands.configureProjectCodexLink(toolCtx, 'link', params.project, params.value)
              : params.setting === 'unlink-codex'
                ? await commands.configureProjectCodexLink(toolCtx, 'unlink', params.project)
                : await commands.configureProject(toolCtx, params.setting ?? 'show', params.value, params.target);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'list') {
            const result = await commands.listProjects(toolCtx);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: true } };
          }
          if (params.action === 'history' || params.action === 'decisions') {
            const result = await commands.projectMemory(toolCtx, params.action === 'history' ? (params.recordSection ?? 'captures') : 'decisions', params.recordId);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'archived') {
            const result = await commands.listArchivedProjects(toolCtx);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: true } };
          }
          if (params.action === 'doctor') {
            const result = await commands.doctor(toolCtx, params.format === 'json' ? 'json' : 'text');
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'repair-preview') {
            const result = await commands.repairProject(toolCtx, false);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'merge-preview' || params.action === 'move-preview') {
            if (typeof params.project !== 'string') return { content: [{ type: 'text', text: 'Ein Quell-Projektcode ist erforderlich.' }], details: { ok: false } };
            const result = params.action === 'merge-preview'
              ? await commands.previewTransfer(toolCtx, 'merge', params.project, params.target)
              : await commands.previewTransfer(toolCtx, 'move', params.project, undefined, params.targetAgent);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (['archive', 'trash', 'restore'].includes(params.action)) {
            if (typeof params.project !== 'string') return { content: [{ type: 'text', text: 'Ein Projektcode ist erforderlich.' }], details: { ok: false } };
            const status = params.action === 'archive' ? 'archived' : params.action === 'trash' ? 'trash' : 'active';
            const result = await commands.changeProjectStatus(toolCtx, params.project.toUpperCase(), status);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'select') {
            if (typeof params.project !== 'string') return { content: [{ type: 'text', text: 'Ein Projektcode ist erforderlich.' }], details: { ok: false } };
            const result = await commands.selectProject(toolCtx, params.project.toUpperCase());
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          if (params.action === 'status') {
            const result = await commands.projectStatus(toolCtx);
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: true } };
          }
          if (params.action === 'import') {
            return await commands.importProject(toolCtx, params.value, params.format ?? 'text');
          }
          if (params.action === 'export') {
            return await commands.exportProject(toolCtx, params.project, params.format ?? 'text');
          }
          if (params.action === 'search') {
            return await commands.searchProjects(toolCtx, params.query, params.format ?? 'text');
          }
          if (params.action === 'capture-preview' || params.action === 'close-preview') {
            if (typeof params.summary !== 'string') return { content: [{ type: 'text', text: 'Eine Zusammenfassung ist erforderlich; nichts gespeichert.' }], details: { ok: false } };
            const result = await commands.proposeSummary(toolCtx, params.summary, params.action === 'close-preview' ? 'close' : 'capture');
            assertCurrent();
            return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          }
          const result = await commands.clearProject(toolCtx);
          assertCurrent();
          return { content: [{ type: 'text', text: result.text }], details: { ok: resultOk(result.text) } };
          } catch (error) {
            const detail = error?.stack ?? String(error);
            const sink = log.error ?? log.warn ?? log.info ?? console.error;
            sink.call(log, '[awf_project] tool error: ' + detail);
            return { content: [{ type: 'text', text: 'awf_project error: ' + (error?.message ?? String(error)) }],
              details: { ok: false } };
          }
        },
      };
    },
  };
  api.registerTool(projectToolContext, {
    name: 'awf_project',
    workspaceAccess: true,
    promptGuidance: 'When the user explicitly asks to create, list, select, inspect, configure, archive, restore, delete to trash, doctor, repair, inspect project history, or clear an OpenClaw project, use awf_project. The active agent determines the project domain and its own configured code model and location; never infer the agent from a code or ask the user to select an agent. `/project help` lists commands and `/project list` shows projects for the current agent. Prefix models use letters followed by X/Y digit placeholders; only the current agent configuration controls allocation. Renaming or deleting a model never rewrites existing codes, and changing location only affects new projects while old locations remain searchable. Codex workspace links are configured per project with `/project config link <code> <absolutePath>`. When Codex selects that exact registered root, only the matching active project of the current agent loads. Adding a new root to the Codex Desktop picker still requires the Codex UI. The active project list excludes archived and trashed projects; use the archived action only when the user asks to see them. Archiving hides a project and prevents context loading; restoring requires selecting it again. Delete means recoverable trash, never permanent erasure. Doctor is read-only; repair only previews safe permission fixes or a minimal missing KONTEXT.md and requires /project repair confirm. Creating or selecting a project returns a visible project card; /project status shows the current project. Its REFERENZ.md and compact KONTEXT.md snapshot load on subsequent turns. Capture replaces the current snapshot after preview and explicit /project capture confirm; it also stores an immutable capture record and archives detected new decisions separately. Previous large context is preserved during first migration. Capture and decision archives are never loaded automatically: use /project history [ID], /project history legacy [ID], or /project decisions [ID] to inspect a record. Keep the snapshot compact; never append a capture to it. If the user explicitly asks to capture the current conversation or close the project, prepare a concise proposed replacement snapshot from only the visible conversation and loaded current context, include still-valid goals and decisions and open work, and call capture-preview or close-preview. These actions only show a draft: never confirm or persist it automatically. Wait for the user to issue /project capture confirm or /project capture cancel. Do not import chat history or other files silently. Cross-agent moves require a preview, a new target-domain code, and explicit confirmation.',
  });
  api.registerCommand({ name: 'project', description: 'Create, list, select, inspect, or clear this agent’s project context',
    acceptsArgs: true, requireAuth: true, handler: async (ctx) => {
      const requested = ctx.args?.trim() ?? '';
      if (requested === 'help') return commands.helpProject();
      const create = /^create\s+([\s\S]+)$/u.exec(requested);
      if (create) return commands.createProject(ctx, create[1]);
      if (requested === 'config' || requested === 'config show') return commands.configureProject(ctx, 'show');
      const configModel = /^config\s+set\s+(?:project\s+)?(?:initial\s+)?prefix(?:-model|\s+model)?\s+([A-Z]{1,4}[XY]{2,6})$/iu.exec(requested);
      if (configModel) return commands.configureProject(ctx, 'set-model', configModel[1]);
      const configRename = /^config\s+rename\s+(?:project\s+)?prefix\s+([A-Z]{1,4}[XY]{2,6})\s+([A-Z]{1,4}[XY]{2,6})$/iu.exec(requested);
      if (configRename) return commands.configureProject(ctx, 'rename-prefix', configRename[1], configRename[2]);
      const configDelete = /^config\s+delete\s+(?:project\s+)?prefix\s+([A-Z]{1,4}[XY]{2,6})$/iu.exec(requested);
      if (configDelete) return commands.configureProject(ctx, 'delete-prefix', configDelete[1]);
      const configCodexProjectLink = /^config\s+link\s+([A-Z]{1,4}[0-9]{2,6})\s+(.+)$/iu.exec(requested);
      if (configCodexProjectLink) return commands.configureProjectCodexLink(ctx, 'link', configCodexProjectLink[1].toUpperCase(), configCodexProjectLink[2]);
      const configCodexUnlink = /^config\s+unlink\s+([A-Z]{1,4}[0-9]{2,6})$/iu.exec(requested);
      if (configCodexUnlink) return commands.configureProjectCodexLink(ctx, 'unlink', configCodexUnlink[1].toUpperCase());
      const configLocation = /^config\s+set\s+(?:project\s+)?location\s+(.+)$/iu.exec(requested);
      const configBaseline = /^config\s+set\s+baseline\s+(.+)$/iu.exec(requested);
      if (configBaseline) return commands.configureProject(ctx, 'set-baseline', configBaseline[1]);
      if (configLocation) return commands.configureProject(ctx, 'set-location', configLocation[1]);
      if (!requested || requested === 'list') return commands.listProjects(ctx);
      if (requested === 'archived') return commands.listArchivedProjects(ctx);
      if (requested === 'doctor') return commands.doctor(ctx);
      if (requested === 'doctor json') return commands.doctor(ctx, 'json');
      const exportCmd = /^export\s+([A-Z]{1,4}[0-9]{2,6})$/iu.exec(requested);
      if (exportCmd) return commands.exportProject(ctx, exportCmd[1]);
      const importCmd = /^import\s+([\s\S]+)$/u.exec(requested);
      if (importCmd) return commands.importProject(ctx, importCmd[1]);
      const search = /^search\s+([\s\S]+)$/u.exec(requested);
      if (search) return commands.searchProjects(ctx, search[1]);
      if (requested === 'repair') return commands.repairProject(ctx, false);
      if (requested === 'repair confirm') return commands.repairProject(ctx, true);
      if (requested === 'transfer confirm') return commands.confirmTransfer(ctx, false);
      if (requested === 'transfer cancel') return commands.confirmTransfer(ctx, true);
      if (requested === 'history prune') return commands.pruneHistory(ctx, false);
      if (requested === 'history prune confirm') return commands.pruneHistory(ctx, true);
      const merge = /^merge\s+([A-Z]{1,4}[0-9]{2,6})\s+into\s+([A-Z]{1,4}[0-9]{2,6})$/iu.exec(requested);
      if (merge) return commands.previewTransfer(ctx, 'merge', merge[1], merge[2]);
      const move = /^move\s+([A-Z]{1,4}[0-9]{2,6})\s+to\s+([a-z0-9][a-z0-9-]{0,63})$/iu.exec(requested);
      if (move) return commands.previewTransfer(ctx, 'move', move[1], undefined, move[2].toLowerCase());
      if (requested === 'status') return commands.projectStatus(ctx);
      const archive = /^archive\s+([A-Z]{1,4}[0-9]{2,6})$/iu.exec(requested);
      if (archive) return commands.changeProjectStatus(ctx, archive[1].toUpperCase(), 'archived');
      const trash = /^delete\s+([A-Z]{1,4}[0-9]{2,6})$/iu.exec(requested);
      if (trash) return commands.changeProjectStatus(ctx, trash[1].toUpperCase(), 'trash');
      const restore = /^restore\s+([A-Z]{1,4}[0-9]{2,6})$/iu.exec(requested);
      if (restore) return commands.changeProjectStatus(ctx, restore[1].toUpperCase(), 'active');
      if (requested === 'capture') return commands.prepareSummary(ctx, 'capture');
      if (requested === 'close') return commands.prepareSummary(ctx, 'close');
      if (requested === 'capture confirm') return commands.confirmSummary(ctx);
      if (requested === 'capture cancel') return commands.cancelSummary(ctx);
      const history = /^history(?:\s+([a-f0-9]{24}|latest))?$/iu.exec(requested);
      if (history) return commands.projectMemory(ctx, 'captures', history[1]?.toLowerCase());
      const legacy = /^history\s+legacy(?:\s+([a-f0-9]{24}|latest))?$/iu.exec(requested);
      if (legacy) return commands.projectMemory(ctx, 'legacy', legacy[1]?.toLowerCase());
      const decisions = /^decisions(?:\s+([a-f0-9]{24}|latest))?$/iu.exec(requested);
      if (decisions) return commands.projectMemory(ctx, 'decisions', decisions[1]?.toLowerCase());
      if (requested === 'clear') return commands.clearProject(ctx);
      return commands.selectProject(ctx, requested.toUpperCase());
    } });
}
