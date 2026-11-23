import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CODEX_LINK_FILE = '.awf-codex-link.json';
export const CODEX_LINK_SCHEMA = 'awf.project-codex-link.v1';
const MAX_LINK_BYTES = 4096;

function assertProjectRoot(projectRoot, expectedUid) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new Error('Der OpenClaw-Projektpfad ist ungültig.');
  const stat = lstatSync(projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || realpathSync(projectRoot) !== projectRoot ||
      (stat.mode & 0o077) !== 0) throw new Error('Der OpenClaw-Projektordner hat die kanonische Eigentümer- oder Datenschutzprüfung nicht bestanden.');
  return stat;
}

export function validateCodexRoot(codexRoot, expectedUid) {
  if (typeof codexRoot !== 'string' || !path.isAbsolute(codexRoot) || codexRoot.includes('\0')) {
    throw new Error('Der Codex-Projektpfad muss ein absoluter Pfad sein.');
  }
  const stat = lstatSync(codexRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || realpathSync(codexRoot) !== codexRoot) {
    throw new Error('Der Codex-Projektpfad muss ein vorhandenes kanonisches Verzeichnis im Eigentum des OpenClaw-Eigentümers sein.');
  }
  return codexRoot;
}

function readLinkFile(projectRoot, expectedUid) {
  assertProjectRoot(projectRoot, expectedUid);
  const target = path.join(projectRoot, CODEX_LINK_FILE);
  if (!existsSync(target)) return undefined;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 || stat.size > MAX_LINK_BYTES) throw new Error('Die Codex-Link-Datei hat die Eigentümer-, Modus-, Link- oder Größenprüfung nicht bestanden.');
  const fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(target);
    if (!opened.isFile() || opened.uid !== expectedUid || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 ||
        opened.dev !== stat.dev || opened.ino !== stat.ino || after.isSymbolicLink() ||
        after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('Die Codex-Projektverknüpfung hat sich beim Öffnen geändert.');
    const link = JSON.parse(readFileSync(fd, 'utf8'));
    if (!link || link.schema !== CODEX_LINK_SCHEMA || link.projectRoot !== projectRoot ||
        typeof link.agentId !== 'string' || typeof link.projectId !== 'string' ||
        typeof link.displayId !== 'string' || typeof link.codexRoot !== 'string' ||
        link.enabled !== true || link.desktopRegistration !== 'manual') throw new Error('Die Codex-Link-Datei ist ungültig.');
    return link;
  } finally { closeSync(fd); }
}

export function readProjectCodexLink(projectRoot, expectedUid) {
  return readLinkFile(projectRoot, expectedUid);
}

export function writeProjectCodexLink({ projectRoot, expectedUid, agentId, projectId, displayId, codexRoot }) {
  assertProjectRoot(projectRoot, expectedUid);
  validateCodexRoot(codexRoot, expectedUid);
  const target = path.join(projectRoot, CODEX_LINK_FILE);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0) throw new Error('Die vorhandene Codex-Link-Datei ist nicht sicher.');
  }
  const value = {
    schema: CODEX_LINK_SCHEMA,
    enabled: true,
    agentId,
    projectId,
    displayId,
    projectRoot,
    codexRoot,
    desktopRegistration: 'manual',
    updatedAt: new Date().toISOString(),
  };
  const temporary = path.join(projectRoot, `.${CODEX_LINK_FILE}.${randomUUID()}.tmp`);
  let fd;
  let createdTemporary = false;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    createdTemporary = true;
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    readLinkFile(projectRoot, expectedUid);
    return value;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (createdTemporary) try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function removeProjectCodexLink(projectRoot, expectedUid) {
  const link = readLinkFile(projectRoot, expectedUid);
  if (!link) return false;
  unlinkSync(path.join(projectRoot, CODEX_LINK_FILE));
  return true;
}
