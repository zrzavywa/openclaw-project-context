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
import { fileURLToPath } from 'node:url';
import { createProjectWorkspace, reserveProjectDisplayId, abandonProjectDisplayId } from './project-creation.mjs';
import { PROJECT_AGENT_CONFIG_SCHEMA, defaultProjectAgentConfig, validateProjectAgentConfig,
  normalizeProjectLocation, resolveProjectLocations, parseProjectCodeModel, projectCodeModels } from './project-config.mjs';
import { PROJECT_STATE_SCHEMA, PROJECT_STATUSES, readProjectState, transitionProjectState,
  diagnoseProjectWorkspace, buildProjectRepairPlan, applyProjectRepairPlan,
  inspectProjectAssets, copyProjectAssets, quarantineProjectDirectory } from './project-lifecycle.mjs';
import { readProjectCodexLink, writeProjectCodexLink, removeProjectCodexLink, validateCodexRoot } from './project-codex-link.mjs';
import { PROJECT_SNAPSHOT_MAX_BYTES, readProjectMemoryRecords, saveApprovedProjectMemory } from './project-memory.mjs';
import { inspectReleaseDirectory } from './project-release.mjs';

export const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const LOADED_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version; }
  catch { return undefined; }
})();

export const SELECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PROJECT_FILE_BYTES = 64 * 1024;
export const CONTEXT_FILES = ['REFERENZ.md', 'KONTEXT.md'];
export const MAX_REVIEW_BYTES = 6000;
export const REVIEW_TTL_MS = 15 * 60 * 1000;
export const PROMPT_REFERENCE_MAX_BYTES = 24 * 1024;
export const PROMPT_CONTEXT_MAX_BYTES = 24 * 1024;

export function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return { text: value, omitted: 0 };
  let cut = buffer.subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return { text: cut, omitted: buffer.length - Buffer.byteLength(cut, 'utf8') };
}

export function budgetedSection(label, value, maxBytes) {
  const { text, omitted } = truncateUtf8(value, maxBytes);
  if (!omitted) return text;
  return `${text}\n\n[${label}: ${omitted} UTF-8-Bytes gekürzt; vollständige Datei im Projektordner]`;
}

export function contextDiagnostic(decision, error) {
  if (process.env.AWF_PROJECT_CONTEXT_DEBUG === '1') {
    const code = error ? contextErrorCode(error) : '';
    console.error(`[awf-project-context] ${decision}${code ? ` (${code})` : ''}`);
  }
}

export function contextErrorCode(error) {
  if (error?.code === 'ENOENT') return 'ENOENT';
  if (error?.code === 'EACCES') return 'EACCES';
  if (error?.code === 'EPERM') return 'EPERM';
  if (error?.message === 'Agent workspace must be a canonical private directory') return 'workspace-not-private';
  if (error?.message === 'Agent workspace does not have owner-only permissions') return 'workspace-permissions';
  if (error?.message === 'Projects directory failed canonical ownership or privacy checks') return 'projects-root-invalid';
  if (error?.message === 'Selected project failed canonical ownership checks') return 'project-root-invalid';
  if (error?.message === 'Project context file failed ownership, mode, link, or size checks') return 'context-file-invalid';
  if (error?.message === 'Project context file changed while opening') return 'context-file-raced';
  if (error?.code === 'ERR_INVALID_ARG_TYPE') return 'invalid-runtime-path-type';
  return error?.code ?? 'validation-error';
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function selectionIdentity(ctx) {
  if (!ctx || typeof ctx.agentId !== 'string' || !ctx.agentId ||
      typeof ctx.sessionKey !== 'string' || !ctx.sessionKey) return undefined;
  const sessionKeyDigest = sha256(Buffer.from(ctx.sessionKey, 'utf8'));
  return {
    key: sha256(Buffer.from(`${ctx.agentId}\0${sessionKeyDigest}`, 'utf8')),
    agentId: ctx.agentId,
    sessionKeyDigest,
  };
}

export function assertCommandAuthority(ctx) {
  if (ctx?.senderIsOwner === true && typeof ctx.assertOwnerCurrent === 'function') {
    return ctx.assertOwnerCurrent;
  }
  if (ctx?.isAuthorizedSender === true && Array.isArray(ctx.gatewayClientScopes) &&
      ctx.gatewayClientScopes.includes('operator.admin')) {
    return () => {
      if (ctx.isAuthorizedSender !== true || !Array.isArray(ctx.gatewayClientScopes) ||
          !ctx.gatewayClientScopes.includes('operator.admin')) throw new Error('Die Operator-Berechtigung hat sich geändert');
    };
  }
  return undefined;
}

export function canonicalWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('Ungültiger Agenten-Workspace');
  const stat = lstatSync(workspace);
  const canonical = realpathSync(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== workspace) {
    throw new Error('Der Agenten-Workspace muss ein kanonisches privates Verzeichnis sein');
  }
  if ((stat.mode & 0o077) !== 0) throw new Error('Der Agenten-Workspace hat keine Rechte nur für den Eigentümer');
  return { path: canonical, uid: stat.uid, dev: stat.dev, ino: stat.ino };
}

export function readProjectFile(projectRoot, name, expectedUid) {
  if (!CONTEXT_FILES.includes(name)) throw new Error('Die Datei liegt außerhalb der Projektkontext-Allowlist');
  const target = path.join(projectRoot, name);
  const before = lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== expectedUid ||
      before.size > MAX_PROJECT_FILE_BYTES) {
    throw new Error('Die Projektkontextdatei hat die Eigentümer-, Modus-, Link- oder Größenprüfung nicht bestanden');
  }
  const fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(target);
    if (!opened.isFile() || opened.uid !== expectedUid || opened.nlink !== 1 ||
        opened.dev !== before.dev || opened.ino !== before.ino || after.isSymbolicLink() ||
        after.dev !== opened.dev || after.ino !== opened.ino || opened.size > MAX_PROJECT_FILE_BYTES) {
      throw new Error('Die Projektkontextdatei hat sich beim Öffnen geändert');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

export function readOptionalProjectFile(projectRoot, name, expectedUid) {
  try { return readProjectFile(projectRoot, name, expectedUid); }
  catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
}

export function resolveSelectedProject(workspace, uid, projectId, agentId, displayId, agentConfig) {
  const safeProjectEntry = typeof projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId) &&
    projectId !== '.' && projectId !== '..';
  const modelMatches = projectCodeModels(agentConfig).some((model) => new RegExp(`^${model.prefix}[0-9]{${model.width}}$`, 'u').test(displayId ?? ''));
  if (!safeProjectEntry || !modelMatches) {
    throw new Error('Ungültige Projekt-ID oder Agenten-Domain');
  }
  const roots = resolveProjectLocations(workspace, agentConfig, uid);
  const projectRoot = roots.map((root) => path.join(root, projectId)).find((candidate) => {
    try { return lstatSync(candidate).isDirectory(); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  });
  if (!projectRoot) throw new Error('Das ausgewählte Projekt wurde in keinem konfigurierten Projektpfad des Agenten gefunden.');
  const projectInfo = lstatSync(projectRoot);
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink() || projectInfo.uid !== uid ||
      realpathSync(projectRoot) !== projectRoot) {
    throw new Error('Das ausgewählte Projekt hat die kanonischen Eigentümerprüfungen nicht bestanden');
  }
  const state = readProjectState(projectRoot, uid);
  if (state.status !== 'active') throw new Error('Das ausgewählte Projekt ist archiviert oder im Papierkorb');
  const referenz = readProjectFile(projectRoot, 'REFERENZ.md', uid);
  if (!referenz.includes(displayId)) throw new Error('Der Projekt-Referenzcode passt nicht zur Auswahl');
  let codexLink;
  try { codexLink = readProjectCodexLink(projectRoot, uid); } catch {}
  return { root: projectRoot, state, referenz, kontext: readOptionalProjectFile(projectRoot, 'KONTEXT.md', uid), codexLink };
}

export function listProjects(workspace, uid, agentId, agentConfig, statuses = ['active']) {
  const projectsRoots = resolveProjectLocations(workspace, agentConfig, uid);
  const models = projectCodeModels(agentConfig);
  const result = [];
  for (const projectsRoot of projectsRoots) {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const projectRoot = path.join(projectsRoot, entry.name);
        const state = readProjectState(projectRoot, uid);
        if (!statuses.includes(state.status)) continue;
        const profile = readProjectFile(projectRoot, 'REFERENZ.md', uid);
        const heading = /^#\s+([^\r\n]+)/mu.exec(profile)?.[1]?.trim();
        const match = models.map((model) => new RegExp(`\\b(${model.prefix}[0-9]{${model.width}})\\b`, 'u').exec(heading ?? profile)).find(Boolean);
        if (heading && match) result.push({ projectId: entry.name, projectRoot, projectsRoot, displayId: match[1], displayName: heading, state });
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM' ||
            /ownership|canonical|regular|link|size|changed/u.test(error?.message ?? '')) continue;
        throw error;
      }
    }
  }
  return result.sort((a, b) => a.displayId.localeCompare(b.displayId));
}

const codexLinkCache = new Map();
export function invalidateCodexLinkCache() { codexLinkCache.clear(); }

export function findCodexWorkspaceProject(workspace, uid, agentId, agentConfig, codexWorkspaceDir) {
  if (typeof codexWorkspaceDir !== 'string' || !path.isAbsolute(codexWorkspaceDir)) return undefined;
  try {
    const info = lstatSync(codexWorkspaceDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || realpathSync(codexWorkspaceDir) !== codexWorkspaceDir) return undefined;
  } catch { return undefined; }
  const cached = codexLinkCache.get(codexWorkspaceDir);
  if (cached && cached.agentId === agentId) return cached.project;
  const matches = [];
  for (const project of listProjects(workspace, uid, agentId, agentConfig)) {
    try {
      const link = readProjectCodexLink(project.projectRoot, uid);
      if (link?.agentId === agentId && link.projectId === project.projectId && link.displayId === project.displayId &&
          link.codexRoot === codexWorkspaceDir) matches.push({ ...project, codexLink: link });
    } catch {}
  }
  if (matches.length === 1) codexLinkCache.set(codexWorkspaceDir, { agentId, project: matches[0] });
  return matches.length === 1 ? matches[0] : undefined;
}

export function makeSelection(identity, project, now, projectStateGeneration = 0) {
  return {
    schema: 'awf.project-conversation-selection.v1',
    agentId: identity.agentId,
    sessionKeyDigest: identity.sessionKeyDigest,
    projectId: project.projectId,
    displayId: project.displayId,
    projectStateGeneration,
    selectedAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString(),
  };
}

export function makeAutoLinkClear(identity, now) {
  return {
    schema: 'awf.project-conversation-selection-clear.v1',
    agentId: identity.agentId,
    sessionKeyDigest: identity.sessionKeyDigest,
    clearedAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + SELECTION_TTL_MS).toISOString(),
  };
}

export function isAutoLinkClearCurrent(value, identity, nowMs) {
  return value?.schema === 'awf.project-conversation-selection-clear.v1' &&
    value.agentId === identity.agentId && value.sessionKeyDigest === identity.sessionKeyDigest &&
    Number.isFinite(Date.parse(value.expiresAt)) && nowMs < Date.parse(value.expiresAt);
}

export function isSelectionCurrent(selection, identity, nowMs) {
  const agentConfigured = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(identity.agentId ?? '');
  const safeProjectEntry = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(selection?.projectId ?? '') &&
    selection.projectId !== '.' && selection.projectId !== '..';
  return selection?.schema === 'awf.project-conversation-selection.v1' &&
    selection.agentId === identity.agentId && selection.sessionKeyDigest === identity.sessionKeyDigest &&
    safeProjectEntry && agentConfigured &&
    /^[A-Z]{1,4}[0-9]{2,6}$/u.test(selection.displayId ?? '') && Number.isFinite(Date.parse(selection.expiresAt)) &&
    nowMs < Date.parse(selection.expiresAt);
}

export function formatProjectCard(project, agentId, state = 'active') {
  const name = project.displayName ?? `${project.displayId}`;
  const codexLine = project.codexLink?.enabled ? `\n- **Codex-Projektpfad:** ${project.codexLink.codexRoot}` : '';
  return `**Projektkontext ${state === 'active' ? 'aktiv' : 'nicht aktiv'}**\n\n- **Projekt:** ${name}\n- **Code:** ${project.displayId}\n- **Agent:** ${agentId}${codexLine}\n- **Gespräch:** aktuelles Gespräch\n- **Kontext:** wird bei Folgeturns automatisch geladen`;
}

export function safeSummary(value) {
  if (typeof value !== 'string') throw new Error('Eine vorgeschlagene Zusammenfassung ist erforderlich');
  const summary = value.trim();
  if (!summary || Buffer.byteLength(summary, 'utf8') > MAX_REVIEW_BYTES) {
    throw new Error('Die Zusammenfassung muss 1–6000 UTF-8-Bytes enthalten');
  }
  return summary;
}
