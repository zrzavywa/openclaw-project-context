import {
  constants as fsConstants,
  closeSync,
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
import { createHash, randomUUID } from 'node:crypto';

export const PROJECT_SNAPSHOT_MAX_BYTES = 16 * 1024;
export const PROJECT_RECORD_MAX_BYTES = 8 * 1024;
const LEGACY_CONTEXT_MAX_BYTES = 64 * 1024;
const PROJECT_ROOT_MARKER = '# Current project context';
const RECORD_ID = /^[a-f0-9]{24}$/u;

function assertProjectRoot(root, uid) {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid ||
      realpathSync(root) !== root || (info.mode & 0o077) !== 0) {
    throw new Error('Das Projektverzeichnis hat die kanonische Eigentümer- oder Datenschutzprüfung nicht bestanden');
  }
}

function ensurePrivateDirectory(parent, name, uid) {
  if (!/^[a-z-]{1,32}$/u.test(name)) throw new Error('Der Name des Projekt-Memory-Verzeichnisses ist ungültig');
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== uid ||
      realpathSync(parent) !== parent) throw new Error('Das übergeordnete Projekt-Memory-Verzeichnis ist nicht sicher');
  const directory = path.join(parent, name);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid ||
      realpathSync(directory) !== directory || (info.mode & 0o077) !== 0) {
    throw new Error('Das Projekt-Memory-Verzeichnis hat die Eigentümer- oder Datenschutzprüfung nicht bestanden');
  }
  return directory;
}

function readSafeFile(filePath, uid, maxBytes) {
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 || before.size > maxBytes) {
    throw new Error('Die Projekt-Memory-Datei hat die Eigentümer-, Modus-, Link- oder Größenprüfung nicht bestanden');
  }
  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(filePath);
    if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || opened.size > maxBytes ||
        opened.dev !== before.dev || opened.ino !== before.ino || after.isSymbolicLink() ||
        after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Die Projekt-Memory-Datei hat sich beim Öffnen geändert');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function writeNewFile(filePath, uid, content, maxBytes) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > maxBytes) throw new Error('Der Projekt-Memory-Datensatz überschreitet sein Größenlimit');
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  let created;
  try {
    const info = fstatSync(fd);
    created = { dev: info.dev, ino: info.ino };
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
      throw new Error('Der Projekt-Memory-Datensatz hat die Eigentümer- oder Datenschutzprüfung nicht bestanden');
    }
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (created) {
      try {
        const current = lstatSync(filePath);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) unlinkSync(filePath);
      } catch {}
    }
    throw error;
  }
  closeSync(fd);
}

export function replaceProjectSnapshotAtomically(filePath, parent, uid, content, expectedPreviousDigest) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > PROJECT_SNAPSHOT_MAX_BYTES) {
    throw new Error(`Der aktuelle Projekt-Snapshot überschreitet ${PROJECT_SNAPSHOT_MAX_BYTES} Bytes; es wurde nichts ersetzt`);
  }
  let previous;
  try { previous = lstatSync(filePath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== uid || previous.nlink !== 1 ||
      (previous.mode & 0o077) !== 0 || previous.size > 64 * 1024)) {
    throw new Error('Der aktuelle Projekt-Snapshot hat die Eigentümer-, Datenschutz- oder Größenprüfung nicht bestanden');
  }
  const tempPath = path.join(parent, `.KONTEXT-${randomUUID()}.tmp`);
  try {
    writeNewFile(tempPath, uid, bytes, PROJECT_SNAPSHOT_MAX_BYTES);
    if (previous) {
      const current = lstatSync(filePath);
      if (!current.isFile() || current.isSymbolicLink() || current.uid !== uid || current.nlink !== 1 ||
          (current.mode & 0o077) !== 0 || current.dev !== previous.dev || current.ino !== previous.ino) {
        throw new Error('Der aktuelle Projekt-Snapshot hat sich vor dem Ersetzen geändert');
      }
    } else {
      try { lstatSync(filePath); throw new Error('Der aktuelle Projekt-Snapshot ist vor dem Ersetzen aufgetaucht'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    // Re-hash immediately before the rename so an in-place rewrite with the same
    // inode cannot be replaced silently. The caller's digest is authoritative.
    if (previous && expectedPreviousDigest !== undefined) {
      const currentBytes = readSafeFile(filePath, uid, 64 * 1024);
      if (createHash('sha256').update(currentBytes).digest('hex') !== expectedPreviousDigest) {
        throw new Error('Der aktuelle Projekt-Snapshot hat sich vor dem Ersetzen geändert');
      }
    }
    renameSync(tempPath, filePath);
    const dirFd = openSync(parent, fsConstants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    try { unlinkSync(tempPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function extractDecisions(summary) {
  const lines = summary.split(/\r?\n/u);
  const sections = [];
  let active = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      if (active) break;
      active = /^(?:beschlossene\s+entscheidungen|entscheidungen|settled\s+decisions|neue\s+beschlüsse\s+dieses\s+gesprächs|new\s+decisions\s+this\s+conversation)$/iu.test(heading[1]);
      continue;
    }
    if (active && line.trim()) sections.push(line);
  }
  return sections.length ? sections.join('\n').trim() : '';
}

function buildSnapshot(summary, now, reviewId, kind, existing = '') {
  const heading = `${PROJECT_ROOT_MARKER}\n\nUpdated: ${now().toISOString()}\nCapture: ${reviewId}\nType: ${kind}\n`;
  const quotedSummary = summary.trim().split(/\r?\n/u).map((line) => line ? `> ${line}` : '>').join('\n');
  if (kind === 'merge' && existing.trim()) {
    const currentBody = existing.startsWith(PROJECT_ROOT_MARKER)
      ? existing.slice(existing.indexOf('## Current state') >= 0 ? existing.indexOf('## Current state') : PROJECT_ROOT_MARKER.length).trim()
      : existing.trim();
    return `${heading}\n${currentBody}\n\n## Merged project context – ${now().toISOString()}\n\n${quotedSummary}\n`;
  }
  return `${heading}\n## Current state\n\n${quotedSummary}\n`;
}

export function saveApprovedProjectMemory({ projectRoot, uid, summary, now, kind, reviewId, capturedAt, expectedContextDigest }) {
  assertProjectRoot(projectRoot, uid);
  if (typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary, 'utf8') > 6000 ||
      !RECORD_ID.test(reviewId ?? '') || !['capture', 'close', 'merge'].includes(kind)) {
    throw new Error('Der freigegebene Projekt-Memory-Datensatz ist ungültig');
  }
  const snapshotPath = path.join(projectRoot, 'KONTEXT.md');
  let existing = '';
  let snapshotBytes;
  try {
    snapshotBytes = readSafeFile(snapshotPath, uid, 64 * 1024);
    existing = new TextDecoder('utf-8', { fatal: true }).decode(snapshotBytes);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (expectedContextDigest !== undefined &&
      createHash('sha256').update(Buffer.from(existing, 'utf8')).digest('hex') !== expectedContextDigest) {
    throw new Error('Der aktuelle Projekt-Snapshot hat sich nach der Vorschau geändert; erstelle eine neue Aufnahme- oder Merge-Vorschau');
  }

  const historyRoot = ensurePrivateDirectory(projectRoot, 'history', uid);
  const captureDir = ensurePrivateDirectory(historyRoot, 'captures', uid);
  const decisionsDir = ensurePrivateDirectory(historyRoot, 'decisions', uid);
  const nowDate = Number.isFinite(capturedAt) ? new Date(capturedAt) : now();
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Der Aufnahme-Zeitstempel ist ungültig');
  const stamp = nowDate.toISOString().replace(/[:.]/gu, '-');
  const recordName = `capture-${stamp}-${reviewId}.md`;
  const recordPath = path.join(captureDir, recordName);
  const record = `# Approved project capture\n\n- Project root: ${path.basename(projectRoot)}\n- Captured: ${nowDate.toISOString()}\n- Review ID: ${reviewId}\n- Type: ${kind}\n\n${summary.trim()}\n`;
  try { writeNewFile(recordPath, uid, record, PROJECT_RECORD_MAX_BYTES); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const previousRecord = new TextDecoder('utf-8', { fatal: true }).decode(readSafeFile(recordPath, uid, PROJECT_RECORD_MAX_BYTES));
    if (!previousRecord.includes(`- Review ID: ${reviewId}\n`) || !previousRecord.endsWith(`\n${summary.trim()}\n`)) {
      throw new Error('Eine andere Aufnahme verwendet diese Review-ID bereits');
    }
  }

  const decisions = extractDecisions(summary);
  if (decisions) {
    const decisionPath = path.join(decisionsDir, `decisions-${stamp}-${reviewId}.md`);
    const decisionRecord = `# Approved decisions\n\n- Captured: ${nowDate.toISOString()}\n- Review ID: ${reviewId}\n\n${decisions}\n`;
    try { writeNewFile(decisionPath, uid, decisionRecord, PROJECT_RECORD_MAX_BYTES); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const previousRecord = new TextDecoder('utf-8', { fatal: true }).decode(readSafeFile(decisionPath, uid, PROJECT_RECORD_MAX_BYTES));
      if (!previousRecord.includes(`- Review ID: ${reviewId}\n`) || !previousRecord.endsWith(`\n${decisions}\n`)) {
        throw new Error('Ein anderer Entscheidungsdatensatz verwendet diese Review-ID bereits');
      }
    }
  }

  if (existing && !existing.startsWith(PROJECT_ROOT_MARKER)) {
    const legacyDir = ensurePrivateDirectory(historyRoot, 'legacy', uid);
    const digest = createHash('sha256').update(snapshotBytes).digest('hex').slice(0, 24);
    const legacyPath = path.join(legacyDir, `legacy-context-${digest}.md`);
    try { writeNewFile(legacyPath, uid, snapshotBytes, 64 * 1024); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!readSafeFile(legacyPath, uid, 64 * 1024).equals(snapshotBytes)) throw new Error('Das alte Kontext-Archiv steht im Konflikt mit einem vorhandenen Datensatz');
    }
  }

  const next = buildSnapshot(summary, now, reviewId, kind, existing);
  const existingDigest = snapshotBytes === undefined ? undefined
    : createHash('sha256').update(snapshotBytes).digest('hex');
  replaceProjectSnapshotAtomically(snapshotPath, projectRoot, uid, next, existingDigest);
  return { recordName, decisionsSaved: Boolean(decisions), snapshotBytes: Buffer.byteLength(next, 'utf8') };
}

function listSafeRecords(projectRoot, uid, section) {
  assertProjectRoot(projectRoot, uid);
  if (!['captures', 'decisions', 'legacy'].includes(section)) throw new Error('Der Projekt-History-Abschnitt ist ungültig');
  const directory = path.join(projectRoot, 'history', section);
  let info;
  try { info = lstatSync(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || realpathSync(directory) !== directory ||
      (info.mode & 0o077) !== 0) throw new Error('Das Projekt-History-Verzeichnis ist nicht sicher');
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name).filter((name) => section === 'captures'
      ? /^capture-[0-9TZ-]+-[a-f0-9]{24}\.md$/u.test(name)
      : section === 'decisions'
        ? /^decisions-[0-9TZ-]+-[a-f0-9]{24}\.md$/u.test(name)
        : /^legacy-context-[a-f0-9]{24}\.md$/u.test(name))
    .sort((a, b) => b.localeCompare(a));
}

export function readProjectMemoryRecords({ projectRoot, uid, section, recordId, limit = 10 }) {
  const names = listSafeRecords(projectRoot, uid, section);
  if (recordId !== undefined && !['latest', 'legacy'].includes(recordId) && !RECORD_ID.test(recordId)) {
    throw new Error('Die Datensatz-ID muss eine 24-stellige hexadezimale Aufnahme-ID sein');
  }
  const selected = recordId === undefined ? names.slice(0, Math.max(1, Math.min(limit, 20)))
    : recordId === 'legacy' ? names.slice(0, 50)
      : names.filter((name) => recordId === 'latest' ? names[0] === name : name.endsWith(`-${recordId}.md`)).slice(0, 1);
  if (recordId !== undefined && selected.length === 0) return { records: [], missing: true };
  const directory = path.join(projectRoot, 'history', section);
  const records = selected.map((name) => ({
    id: name.match(/-([a-f0-9]{24})\.md$/u)?.[1],
    name,
    text: new TextDecoder('utf-8', { fatal: true }).decode(readSafeFile(path.join(directory, name), uid,
      section === 'legacy' ? LEGACY_CONTEXT_MAX_BYTES : PROJECT_RECORD_MAX_BYTES)),
  }));
  return { records, missing: false, total: names.length };
}

// --- history listing / pruning ---------------------------------------------
// Retention needs the full name list, not just the newest records.
export function listProjectHistory({ projectRoot, uid, section }) {
  const names = listSafeRecords(projectRoot, uid, section);
  return { names, total: names.length };
}

// Record names carry a filesystem-safe ISO stamp: capture-YYYY-MM-DDTHH-MM-SS-sssZ-<id>.md
export function recordTimestamp(name) {
  const match = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/u.exec(String(name ?? ''));
  if (!match) return undefined;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : undefined;
}
