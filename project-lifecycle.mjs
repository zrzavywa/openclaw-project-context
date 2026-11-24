import {
  constants as fsConstants,
  closeSync,
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROJECT_STATE_FILE = '.awf-project-state.json';
export const PROJECT_STATE_SCHEMA = 'awf.project-state.v1';
export const PROJECT_STATUSES = Object.freeze(['active', 'archived', 'trash']);
const PROJECT_FIXTURE_MARKER = '.awf-project-fixture.json';
const PROJECT_FIXTURE_MARKER_SCHEMA = 'awf.project-fixture.v1';
const WORKSPACE_TRASH_DIR = '.project-trash';
const LIFECYCLE_LOG_NAME = 'lifecycle.jsonl';
const LIFECYCLE_LOG_SCHEMA = 'awf.project-lifecycle.v1';
const MAX_LIFECYCLE_BYTES = 1024 * 1024;

const MAX_STATE_BYTES = 4096;
const MAX_HISTORY_WARN_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_FILES = 1000;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

function assertSafeProjectRoot(projectRoot, uid, requirePrivate = true) {
  const stat = lstatSync(projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      realpathSync(projectRoot) !== projectRoot || (requirePrivate && (stat.mode & 0o077) !== 0)) {
    throw new Error('Das Projektverzeichnis hat die kanonische Eigentümer- oder Datenschutzprüfung nicht bestanden');
  }
  return stat;
}

function hasValidProjectFixtureMarker(projectRoot, expectedUid, agentId, projectId) {
  const markerPath = path.join(projectRoot, PROJECT_FIXTURE_MARKER);
  let before;
  try { before = lstatSync(markerPath); }
  catch { return false; }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid || before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 || before.size > 4096) return false;
  let fd;
  try {
    fd = openSync(markerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    const after = lstatSync(markerPath);
    if (!opened.isFile() || opened.uid !== expectedUid || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 ||
        opened.dev !== before.dev || opened.ino !== before.ino || after.isSymbolicLink() ||
        after.dev !== opened.dev || after.ino !== opened.ino || opened.size > 4096) return false;
    const marker = JSON.parse(readFileSync(fd, 'utf8'));
    return marker?.schema === PROJECT_FIXTURE_MARKER_SCHEMA && marker?.kind === 'test-fixture' &&
      marker?.agentId === agentId && marker?.projectId === projectId &&
      typeof marker?.reason === 'string' && marker.reason.trim().length > 0;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function normalizeState(value) {
  if (!value || value.schema !== PROJECT_STATE_SCHEMA || !PROJECT_STATUSES.includes(value.status) ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      (value.movedTo !== undefined && (!value.movedTo || typeof value.movedTo.agentId !== 'string' ||
        typeof value.movedTo.displayId !== 'string'))) {
    throw new Error('Die Metadaten der Projektstatusdatei sind ungültig');
  }
  return value;
}

export function readProjectState(projectRoot, expectedUid) {
  assertSafeProjectRoot(projectRoot, expectedUid, false);
  const filePath = path.join(projectRoot, PROJECT_STATE_FILE);
  let before;
  try { before = lstatSync(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return { schema: PROJECT_STATE_SCHEMA, status: 'active', generation: 0 };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid || before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 || before.size > MAX_STATE_BYTES) {
    throw new Error('Die Projektstatusdatei hat die Eigentümer-, Modus-, Link- oder Größenprüfung nicht bestanden');
  }
  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(filePath);
    if (!opened.isFile() || opened.uid !== expectedUid || opened.nlink !== 1 ||
        opened.dev !== before.dev || opened.ino !== before.ino || after.isSymbolicLink() ||
        after.dev !== opened.dev || after.ino !== opened.ino || opened.size > MAX_STATE_BYTES) {
      throw new Error('Die Projektstatusdatei hat sich beim Öffnen geändert');
    }
    return normalizeState(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}

export function writeProjectState(projectRoot, expectedUid, nextState) {
  assertSafeProjectRoot(projectRoot, expectedUid);
  const state = normalizeState(nextState);
  const filePath = path.join(projectRoot, PROJECT_STATE_FILE);
  const tempPath = path.join(projectRoot, `${PROJECT_STATE_FILE}.${randomUUID()}.tmp`);
  const encoded = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) throw new Error('Die Metadaten der Projektstatusdatei sind zu groß');
  let fd;
  try {
    fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, encoded, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const current = readProjectState(projectRoot, expectedUid);
    const existingInfo = (() => { try { return lstatSync(filePath); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; } })();
    if (existingInfo && (!existingInfo.isFile() || existingInfo.isSymbolicLink() || existingInfo.uid !== expectedUid ||
        existingInfo.nlink !== 1 || (existingInfo.mode & 0o077) !== 0)) {
      throw new Error('Die Projektstatusdatei hat sich vor der Aktualisierung geändert');
    }
    if (state.generation < current.generation || state.generation > current.generation + 1) {
      throw new Error('Die Generation der Projektstatusdatei hat sich parallel geändert');
    }
    renameSync(tempPath, filePath);
    const dirFd = openSync(projectRoot, fsConstants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
  }
  return state;
}

function ensureHistoryDirectory(projectRoot, expectedUid) {
  const directory = path.join(projectRoot, 'history');
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid ||
      realpathSync(directory) !== directory || (info.mode & 0o077) !== 0) {
    throw new Error('Das Projekt-History-Verzeichnis hat die Eigentümer- oder Datenschutzprüfung nicht bestanden');
  }
  return directory;
}

export function appendLifecycleEvent(projectRoot, expectedUid, event) {
  assertSafeProjectRoot(projectRoot, expectedUid);
  const directory = ensureHistoryDirectory(projectRoot, expectedUid);
  const filePath = path.join(directory, LIFECYCLE_LOG_NAME);
  let existing;
  try { existing = lstatSync(filePath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== expectedUid ||
      existing.nlink !== 1 || (existing.mode & 0o077) !== 0)) {
    throw new Error('Das Lifecycle-Log hat die Eigentümer-, Link- oder Datenschutzprüfung nicht bestanden');
  }
  if (existing && existing.size > MAX_LIFECYCLE_BYTES) renameSync(filePath, `${filePath}.1`);
  const line = `${JSON.stringify({ schema: LIFECYCLE_LOG_SCHEMA, ...event })}\n`;
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND |
    (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== expectedUid) throw new Error('Das Lifecycle-Log gehört nicht diesem Agenten');
    writeFileSync(fd, line, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return { path: filePath };
}

export function inspectLifecycleLog(projectRoot, expectedUid, state = undefined) {
  const filePath = path.join(projectRoot, 'history', LIFECYCLE_LOG_NAME);
  let info;
  try { info = lstatSync(filePath); }
  catch (error) { if (error?.code === 'ENOENT') return { status: 'missing', entries: 0 }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedUid || info.nlink !== 1 ||
      info.size > MAX_LIFECYCLE_BYTES) return { status: 'invalid', entries: 0 };
  const lines = readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim());
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { return { status: 'invalid', entries: entries.length }; }
  }
  if (!entries.length) return { status: 'empty', entries: 0 };
  const last = entries[entries.length - 1];
  if (!last || last.schema !== LIFECYCLE_LOG_SCHEMA || !Number.isSafeInteger(last.generation)) {
    return { status: 'invalid', entries: entries.length };
  }
  if (state && last.generation < state.generation) return { status: 'stale', entries: entries.length, last };
  return { status: 'ok', entries: entries.length, last };
}

export function quarantineProjectDirectory(projectRoot, expectedUid, workspaceRoot, now = () => new Date()) {
  assertSafeProjectRoot(projectRoot, expectedUid);
  const workspaceInfo = lstatSync(workspaceRoot);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || workspaceInfo.uid !== expectedUid ||
      realpathSync(workspaceRoot) !== workspaceRoot) {
    throw new Error('Der Workspace ist für die Quarantäne nicht sicher');
  }
  const trash = path.join(workspaceRoot, WORKSPACE_TRASH_DIR);
  try { mkdirSync(trash, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = lstatSync(trash);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid ||
      realpathSync(trash) !== trash || (info.mode & 0o077) !== 0) {
    throw new Error('Das Quarantäne-Verzeichnis hat die Eigentümer- oder Datenschutzprüfung nicht bestanden');
  }
  const stamp = now().toISOString().replace(/[:.]/gu, '-');
  const target = path.join(trash, `${path.basename(projectRoot)}-${stamp}`);
  renameSync(projectRoot, target);
  return { path: target };
}

export function inspectProjectHistory(projectRoot, expectedUid) {
  const summary = { captures: { files: 0, bytes: 0 }, decisions: { files: 0, bytes: 0 },
    legacy: { files: 0, bytes: 0 }, totalBytes: 0 };
  const history = path.join(projectRoot, 'history');
  let info;
  try { info = lstatSync(history); }
  catch (error) { if (error?.code === 'ENOENT') return summary; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid) return summary;
  for (const section of ['captures', 'decisions', 'legacy']) {
    const directory = path.join(history, section);
    let sectionInfo;
    try { sectionInfo = lstatSync(directory); }
    catch { continue; }
    if (!sectionInfo.isDirectory() || sectionInfo.isSymbolicLink() || sectionInfo.uid !== expectedUid) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      let fileInfo;
      try { fileInfo = lstatSync(path.join(directory, entry.name)); } catch { continue; }
      if (!fileInfo.isFile() || fileInfo.uid !== expectedUid || fileInfo.nlink !== 1) continue;
      summary[section].files += 1;
      summary[section].bytes += fileInfo.size;
    }
  }
  summary.totalBytes = summary.captures.bytes + summary.decisions.bytes + summary.legacy.bytes;
  return summary;
}

export function transitionProjectState(projectRoot, expectedUid, status, now, extra = {}) {
  if (!PROJECT_STATUSES.includes(status)) throw new Error('Ungültiger Projektstatus');
  const current = readProjectState(projectRoot, expectedUid);
  const next = { ...extra, schema: PROJECT_STATE_SCHEMA, status, generation: current.generation + 1,
    updatedAt: now().toISOString() };
  const written = writeProjectState(projectRoot, expectedUid, next);
  const result = { ...written };
  try {
    appendLifecycleEvent(projectRoot, expectedUid, {
      at: next.updatedAt,
      projectId: path.basename(projectRoot),
      from: current.status,
      to: status,
      generation: next.generation,
      ...(Object.keys(extra).length ? { detail: extra } : {}),
    });
  } catch (error) {
    result.lifecycleError = error.message;
  }
  return result;
}

export function inspectProjectAssets(sourceRoot, expectedUid) {
  assertSafeProjectRoot(sourceRoot, expectedUid);
  const rows = [];
  let totalBytes = 0;
  const ignored = new Set(['REFERENZ.md', 'KONTEXT.md', PROJECT_STATE_FILE]);
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && ignored.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Der Pfad der Projektdateien ist ungültig');
      }
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink() || stat.uid !== expectedUid) throw new Error(`Unsichere Projektdatei: ${relative}`);
      if (stat.isDirectory()) {
        walk(fullPath, relative);
      } else if (stat.isFile() && stat.nlink === 1) {
        rows.push({ path: relative, size: stat.size });
        totalBytes += stat.size;
        if (rows.length > MAX_ASSET_FILES || totalBytes > MAX_ASSET_BYTES) {
          throw new Error('Die Projektdateien überschreiten die Übertragungsgrenzen');
        }
      } else {
        throw new Error(`Nicht unterstützte Projektdatei: ${relative}`);
      }
    }
  }
  walk(sourceRoot);
  return { files: rows, totalBytes };
}

export function copyProjectAssets(sourceRoot, targetRoot, expectedUid, manifest) {
  assertSafeProjectRoot(sourceRoot, expectedUid);
  assertSafeProjectRoot(targetRoot, expectedUid);
  if (!manifest || !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.totalBytes) ||
      manifest.files.length > MAX_ASSET_FILES || manifest.totalBytes > MAX_ASSET_BYTES) {
    throw new Error('Der Übertragungsplan der Projektdateien ist ungültig');
  }
  let copied = 0;
  for (const row of manifest.files) {
    if (!row || typeof row.path !== 'string' || !Number.isSafeInteger(row.size) || row.size < 0 ||
        row.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Der Übertragungsplan der Projektdateien enthält einen ungültigen Pfad');
    }
    const source = path.join(sourceRoot, ...row.path.split('/'));
    const target = path.join(targetRoot, ...row.path.split('/'));
    if (!target.startsWith(`${targetRoot}${path.sep}`)) throw new Error('Der Pfad der Projektdateien verlässt das Ziel');
    const sourceInfo = lstatSync(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid !== expectedUid ||
        sourceInfo.nlink !== 1 || sourceInfo.size !== row.size) {
      throw new Error(`Projektdatei hat sich geändert oder ist unsicher geworden: ${row.path}`);
    }
    const targetDir = path.dirname(target);
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const targetDirInfo = lstatSync(targetDir);
    if (!targetDirInfo.isDirectory() || targetDirInfo.isSymbolicLink() || targetDirInfo.uid !== expectedUid ||
        realpathSync(targetDir) !== targetDir) throw new Error('Das Zielverzeichnis der Projektdateien ist nicht sicher');
    const readFd = openSync(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const writeFd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const opened = fstatSync(readFd);
      if (!opened.isFile() || opened.uid !== expectedUid || opened.nlink !== 1 ||
          opened.dev !== sourceInfo.dev || opened.ino !== sourceInfo.ino || opened.size !== row.size) {
        throw new Error(`Projektdatei hat sich beim Kopieren geändert: ${row.path}`);
      }
      const bytes = readFileSync(readFd);
      if (bytes.length !== row.size) throw new Error(`Projektdateigröße hat sich beim Kopieren geändert: ${row.path}`);
      writeFileSync(writeFd, bytes);
      fsyncSync(writeFd);
      copied += bytes.length;
    } finally { closeSync(readFd); closeSync(writeFd); }
  }
  if (copied !== manifest.totalBytes) throw new Error('Die Gesamtmenge der Projektdateien hat sich beim Kopieren geändert');
  return { files: manifest.files.length, totalBytes: copied };
}

export function diagnoseProjectWorkspace(workspaceRoot, expectedUid, agentId, expectedModels, projectsRootOverride, allProjectRoots = []) {
  const findings = [];
  const skippedFixtures = [];
  const projectsRoot = projectsRootOverride ?? path.join(workspaceRoot, 'projects');
  const models = Array.isArray(expectedModels) ? expectedModels : [{ prefix: expectedModels, width: 3 }];
  let rootInfo;
  try { rootInfo = lstatSync(projectsRoot); }
  catch (error) {
    if (error?.code === 'ENOENT') return { projectsRoot, projects: [], findings };
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== expectedUid || realpathSync(projectsRoot) !== projectsRoot) {
    return { projectsRoot, projects: [], findings: [{ severity: 'error', code: 'projects-root-unsafe',
      message: 'Projects root is not a canonical directory owned by this agent workspace.' }] };
  }
  if ((rootInfo.mode & 0o077) !== 0) findings.push({ severity: 'warning', code: 'projects-root-permissions',
    path: projectsRoot, message: 'Projects root permissions allow group or other access.', repairable: true });
  const projects = [];
  const codes = new Map();
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    const projectRoot = path.join(projectsRoot, entry.name);
    if (allProjectRoots.includes(projectRoot)) continue;
    if (entry.isSymbolicLink()) {
      findings.push({ severity: 'error', code: 'project-symlink', projectId: entry.name,
        message: 'Project entry is a symbolic link and is excluded.' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const result = { projectId: entry.name, status: 'unknown', displayId: undefined };
    const localFindings = [];
    let projectInfo;
    try { projectInfo = lstatSync(projectRoot); }
    catch { findings.push({ severity: 'error', code: 'project-unreadable', projectId: entry.name, message: 'Project directory cannot be inspected.' }); continue; }
    if (!projectInfo.isDirectory() || projectInfo.uid !== expectedUid || realpathSync(projectRoot) !== projectRoot) {
      findings.push({ severity: 'error', code: 'project-root-unsafe', projectId: entry.name,
        message: 'Project root is not a canonical directory owned by this workspace.' });
      continue;
    }
    if ((projectInfo.mode & 0o077) === 0 && hasValidProjectFixtureMarker(projectRoot, expectedUid, agentId, entry.name)) {
      skippedFixtures.push(entry.name);
      continue;
    }
    if ((projectInfo.mode & 0o077) !== 0) localFindings.push({ severity: 'warning', code: 'project-permissions',
      projectId: entry.name, path: projectRoot, message: 'Project directory permissions allow group or other access.', repairable: true });
    let state;
    try {
      state = readProjectState(projectRoot, expectedUid);
      result.status = state.status;
      result.generation = state.generation;
    } catch (error) {
      localFindings.push({ severity: 'error', code: 'project-state-invalid', projectId: entry.name,
        message: `Project status metadata is invalid: ${error.message}` });
    }
    try {
      const lifecycle = inspectLifecycleLog(projectRoot, expectedUid, state);
      if (lifecycle.status === 'invalid' || lifecycle.status === 'empty') {
        localFindings.push({ severity: 'warning', code: 'lifecycle-log-invalid', projectId: entry.name,
          path: path.join(projectRoot, 'history', LIFECYCLE_LOG_NAME),
          message: 'Lifecycle log exists but is not a readable append-only event list.' });
      } else if (lifecycle.status === 'stale' && state) {
        localFindings.push({ severity: 'warning', code: 'lifecycle-log-stale', projectId: entry.name,
          path: path.join(projectRoot, 'history', LIFECYCLE_LOG_NAME),
          message: `Lifecycle log ends at generation ${lifecycle.last.generation}; project state is at ${state.generation}.` });
      }
    } catch {
      localFindings.push({ severity: 'warning', code: 'lifecycle-log-unreadable', projectId: entry.name,
        message: 'Lifecycle log could not be inspected safely.' });
    }
    try {
      const history = inspectProjectHistory(projectRoot, expectedUid);
      result.history = history;
      if (history.totalBytes > MAX_HISTORY_WARN_BYTES) {
        localFindings.push({ severity: 'warning', code: 'history-size', projectId: entry.name,
          path: path.join(projectRoot, 'history'),
          message: `Archive history uses ${Math.round(history.totalBytes / 1024)} KiB across ${history.captures.files + history.decisions.files + history.legacy.files} files.` });
      }
    } catch {
      localFindings.push({ severity: 'warning', code: 'history-unreadable', projectId: entry.name,
        message: 'Project history could not be inspected safely.' });
    }
    const referencePath = path.join(projectRoot, 'REFERENZ.md');
    try {
      const refInfo = lstatSync(referencePath);
      if (!refInfo.isFile() || refInfo.isSymbolicLink() || refInfo.uid !== expectedUid || refInfo.nlink !== 1 || refInfo.size > 64 * 1024) {
        localFindings.push({ severity: 'error', code: 'reference-unsafe', projectId: entry.name,
          message: 'REFERENZ.md is not a safe regular file.' });
      } else {
        if ((refInfo.mode & 0o077) !== 0) localFindings.push({ severity: 'warning', code: 'reference-permissions',
          projectId: entry.name, path: referencePath, message: 'REFERENZ.md permissions allow group or other access.', repairable: true });
        const profile = readFileSync(referencePath, 'utf8');
        const heading = /^#\s+([^\r\n]+)/mu.exec(profile)?.[1]?.trim();
        const match = models.map((model) => new RegExp(`\\b(${model.prefix}[0-9]{${model.width}})\\b`, 'u').exec(heading ?? profile)).find(Boolean);
        if (!heading || !match) localFindings.push({ severity: 'error', code: 'reference-code-missing', projectId: entry.name,
          message: 'Project reference has no recognizable display code for this agent.' });
        else {
          result.displayId = match[1];
          codes.set(match[1], [...(codes.get(match[1]) ?? []), entry.name]);
          if (!heading.includes(match[1])) localFindings.push({ severity: 'warning', code: 'reference-heading-mismatch', projectId: entry.name,
            message: 'Project display code is not present in the reference heading.' });
        }
      }
    } catch (error) {
      if (error?.code === 'ENOENT') localFindings.push({ severity: 'error', code: 'reference-missing', projectId: entry.name,
        message: 'REFERENZ.md is missing and cannot be reconstructed safely.' });
      else localFindings.push({ severity: 'error', code: 'reference-read-failed', projectId: entry.name,
        message: `REFERENZ.md could not be read: ${error.message}` });
    }
    const contextPath = path.join(projectRoot, 'KONTEXT.md');
    try {
      const contextInfo = lstatSync(contextPath);
      if (!contextInfo.isFile() || contextInfo.isSymbolicLink() || contextInfo.uid !== expectedUid || contextInfo.nlink !== 1 ||
          contextInfo.size > 64 * 1024) {
        localFindings.push({ severity: 'error', code: 'context-unsafe', projectId: entry.name,
          message: 'KONTEXT.md is not a safe regular file.' });
      } else {
        if (contextInfo.size > 16 * 1024) localFindings.push({ severity: 'warning', code: 'context-needs-compaction', projectId: entry.name,
          path: contextPath, message: 'The automatically loaded working snapshot is above 16 KiB. The next approved capture will replace it and preserve this legacy context in the project history.' });
        if ((contextInfo.mode & 0o077) !== 0) localFindings.push({ severity: 'warning', code: 'context-permissions', projectId: entry.name,
          path: contextPath, message: 'KONTEXT.md permissions allow group or other access.', repairable: true });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') localFindings.push({ severity: 'info', code: 'context-missing', projectId: entry.name,
        path: contextPath, message: 'Optional KONTEXT.md is missing; a minimal empty context file can be created.', repairable: true });
      else localFindings.push({ severity: 'error', code: 'context-read-failed', projectId: entry.name,
        message: `KONTEXT.md could not be inspected: ${error.message}` });
    }
    projects.push(result);
    findings.push(...localFindings);
  }
  for (const [displayId, ids] of codes) if (ids.length > 1) findings.push({ severity: 'error', code: 'duplicate-project-code',
    displayId, projectIds: ids, message: `Project code ${displayId} appears in multiple project folders.` });
  return { projectsRoot, projects, findings, skippedFixtures };
}

export function buildProjectRepairPlan(workspaceRoot, expectedUid, projectRoots = undefined) {
  const actions = [];
  const allRoots = projectRoots ?? [path.join(workspaceRoot, 'projects')];
  for (const projectsRoot of allRoots) {
  let rootInfo;
  try { rootInfo = lstatSync(projectsRoot); }
  catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== expectedUid || realpathSync(projectsRoot) !== projectsRoot) {
    throw new Error('Das Projekte-Stammverzeichnis ist nicht sicher zu reparieren');
  }
  if ((rootInfo.mode & 0o077) !== 0) actions.push({ type: 'chmod', path: projectsRoot, mode: 0o700, expectedDev: rootInfo.dev, expectedIno: rootInfo.ino });
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const projectRoot = path.join(projectsRoot, entry.name);
    if (allRoots.includes(projectRoot)) continue;
    const info = lstatSync(projectRoot);
    if (!info.isDirectory() || info.uid !== expectedUid || realpathSync(projectRoot) !== projectRoot) continue;
    let state;
    try { state = readProjectState(projectRoot, expectedUid); } catch { continue; }
    if ((info.mode & 0o077) !== 0) actions.push({ type: 'chmod', path: projectRoot, mode: 0o700, expectedDev: info.dev, expectedIno: info.ino });
    for (const name of ['REFERENZ.md', PROJECT_STATE_FILE]) {
      const filePath = path.join(projectRoot, name);
      try {
        const fileInfo = lstatSync(filePath);
        if (fileInfo.isFile() && !fileInfo.isSymbolicLink() && fileInfo.uid === expectedUid && fileInfo.nlink === 1 &&
            (fileInfo.mode & 0o077) !== 0) actions.push({ type: 'chmod', path: filePath, mode: 0o600, expectedDev: fileInfo.dev, expectedIno: fileInfo.ino });
      } catch {}
    }
    const contextPath = path.join(projectRoot, 'KONTEXT.md');
    try {
      const info = lstatSync(contextPath);
      if (info.isFile() && !info.isSymbolicLink() && info.uid === expectedUid && info.nlink === 1 &&
          (info.mode & 0o077) !== 0) actions.push({ type: 'chmod', path: contextPath, mode: 0o600, expectedDev: info.dev, expectedIno: info.ino });
    } catch (error) {
      if (error?.code === 'ENOENT') actions.push({ type: 'create-context', path: contextPath, expectedParentDev: info.dev, expectedParentIno: info.ino, content:
        `# ${entry.name} – Arbeitskontext\n\nStatus: ${state.status}.\n\n## Ziel\n\nNoch nicht eingetragen.\n\n## Letzter bestätigter Stand\n\nEine minimale Kontextdatei wurde nach ausdrücklicher Bestätigung angelegt. Es wurden keine Chats oder anderen Dateien importiert.\n` });
    }
  }
  }
  return actions;
}

export function applyProjectRepairPlan(actions, expectedUid) {
  for (const action of actions) {
    if (action.type === 'create-context') {
      const parent = lstatSync(path.dirname(action.path));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expectedUid || parent.dev !== action.expectedParentDev || parent.ino !== action.expectedParentIno || realpathSync(path.dirname(action.path)) !== path.dirname(action.path)) {
        throw new Error('Das übergeordnete Verzeichnis der Kontextreparatur hat sich geändert oder ist nicht sicher');
      }
      try { lstatSync(action.path); throw new Error('Die Kontextdatei ist vor der Reparatur aufgetaucht'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const fd = openSync(action.path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      try { writeFileSync(fd, action.content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      continue;
    }
    const info = lstatSync(action.path);
    if (info.uid !== expectedUid || info.isSymbolicLink() || info.dev !== action.expectedDev || info.ino !== action.expectedIno) throw new Error('Das Reparaturziel hat sich geändert oder gehört nicht diesem Agenten');
    if (action.type === 'chmod') {
      if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error('Das Reparaturziel ist kein sicheres Verzeichnis und keine sichere Datei');
      chmodSync(action.path, action.mode);
      continue;
    }
    throw new Error('Nicht unterstützte Reparaturaktion');
  }
  return actions.length;
}
