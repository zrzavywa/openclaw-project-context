import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROJECT_CODE_BASELINE = Object.freeze({
  main: Object.freeze({ prefix: 'A', highWater: 3, domain: 'agent' }),
  privat: Object.freeze({ prefix: 'P', highWater: 7, domain: 'private' }),
  'beruflich-work': Object.freeze({ prefix: 'B', highWater: 4, domain: 'work' }),
});

// Portable fallback for agents without a built-in entry and without a configured
// baseline: derive a stable prefix from the agent id instead of refusing the agent.
export function deriveAgentBaseline(agentId) {
  const words = String(agentId ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const letters = words.map((word) => word[0].toUpperCase()).join('').replace(/[XY]/gu, '').slice(0, 4);
  const prefix = /^[A-WZ]{1,4}$/u.test(letters) ? letters : 'A';
  return { prefix, highWater: 0, domain: String(agentId ?? '').trim() || 'workspace' };
}

export function resolveAgentBaseline(agentId, agentConfig) {
  const configured = agentConfig?.baseline;
  if (configured && typeof configured.prefix === 'string' && /^[A-WZ]{1,4}$/u.test(configured.prefix) &&
      Number.isSafeInteger(configured.highWater) && configured.highWater >= 0 &&
      typeof configured.domain === 'string' && configured.domain.trim()) {
    return { prefix: configured.prefix, highWater: configured.highWater, domain: configured.domain.trim() };
  }
  return PROJECT_CODE_BASELINE[agentId] ?? deriveAgentBaseline(agentId);
}

export const PREFIX_REGISTRY_SCHEMA = 'awf.project-prefix-registry.v1';
const PREFIX_REGISTRY_KEY = 'prefix-registry';

function seedPrefixRegistry() {
  return { schema: PREFIX_REGISTRY_SCHEMA, prefixes: Object.fromEntries(
    Object.entries(PROJECT_CODE_BASELINE).map(([agentId, row]) => [row.prefix, agentId])) };
}

export async function claimAgentPrefix({ store, agentId, prefix, assertCurrent = () => {} }) {
  await store.registerIfAbsent(PREFIX_REGISTRY_KEY, seedPrefixRegistry());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertCurrent();
    const observed = await store.observe(PREFIX_REGISTRY_KEY);
    const registry = observed.value && observed.value.prefixes ? observed.value : seedPrefixRegistry();
    const holder = registry.prefixes[prefix];
    if (holder && holder !== agentId) return { status: 'conflict', agentId: holder };
    if (holder === agentId) return { status: 'unchanged' };
    const value = { schema: PREFIX_REGISTRY_SCHEMA, prefixes: { ...registry.prefixes, [prefix]: agentId } };
    const result = await store.compareAndApply(PREFIX_REGISTRY_KEY, observed.comparison, { operation: 'update', action: 'set', value });
    if (result.status === 'applied' || result.status === 'unchanged') return { status: 'claimed' };
  }
  return { status: 'retry' };
}

export function allocationUtilizationWarning(displayId, baseline) {
  if (typeof displayId !== 'string' || !baseline || !Number.isSafeInteger(baseline.highWater) || baseline.highWater <= 0) return '';
  const digits = displayId.replace(/^[A-Z]+/u, '');
  const number = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(number)) return '';
  if (number / baseline.highWater < 0.9) return '';
  return ' Hinweis: ' + number + ' von ' + baseline.highWater + ' Codes dieses Praefixes sind belegt.';
}

const ALLOCATION_SCHEMA = 'awf.project-code-allocation.v1';
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 80;

export function resolveProjectAssignment(agentId) {
  return { agentId, ...resolveAgentBaseline(agentId) };
}

export function normalizeProjectName(value) {
  if (typeof value !== 'string') throw new Error('Ein Projektname ist erforderlich');
  const name = value.trim().replace(/\s+/gu, ' ');
  if (!name || name.length > MAX_NAME_LENGTH || !/^[\p{L}\p{N}][\p{L}\p{N} .()'_&-]*$/u.test(name)) {
    throw new Error('Projektname muss aus 1–80 Buchstaben, Zahlen, Leerzeichen oder den Zeichen .()\'_&- bestehen');
  }
  return name;
}

function allocationBaseline() {
  return {
    schema: ALLOCATION_SCHEMA,
    baselineDate: '2026-11-19',
    domains: Object.fromEntries(Object.entries(PROJECT_CODE_BASELINE).map(([agentId, row]) => [agentId, {
      prefix: row.prefix,
      highWater: row.highWater,
      reservations: [],
    }])),
  };
}

function parseDisplayCode(value, prefix, width = 3) {
  if (typeof value !== 'string') return undefined;
  const match = new RegExp(`(?:^|[^A-Za-z0-9])(${prefix}[0-9]{${width}})(?=$|[^A-Za-z0-9])`, 'u').exec(value);
  return match?.[1];
}

function collectProjectFacts(projectRows, localProjectRows, prefix, width) {
  const codes = new Set();
  const names = new Set();
  for (const row of [...projectRows, ...localProjectRows]) {
    if (!row || typeof row !== 'object') continue;
    const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : '';
    const code = parseDisplayCode(displayName, prefix, width);
    if (code) codes.add(code);
    const namedProject = /^([A-Z]{1,4}[0-9]{2,6})\s*[–-]\s*(.+)$/u.exec(displayName);
    if (namedProject?.[2]) names.add(namedProject[2].trim().toLocaleLowerCase());
    else if (row.localProject === true && typeof row.name === 'string' && row.name.trim()) {
      names.add(row.name.trim().toLocaleLowerCase());
    }
  }
  return { codes, names };
}

function scanLocalProjects(workspaceRoot, projectLocations, currentProjectsRoot) {
  const projectsRoot = currentProjectsRoot ?? path.join(workspaceRoot, 'projects');
  const rows = [];
  for (const location of projectLocations ?? [projectsRoot]) {
    if (!existsSync(location)) continue;
    const rootInfo = lstatSync(location);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(location) !== location) {
      throw new Error('Der Projektpfad muss ein kanonisches echtes Verzeichnis sein');
    }
    for (const entry of readdirSync(location, { withFileTypes: true })) {
    const actualEntryPath = path.join(location, entry.name);
    if (projectLocations?.includes(actualEntryPath)) continue;
    const info = lstatSync(actualEntryPath);
    if (info.isSymbolicLink()) throw new Error('Das Projekte-Verzeichnis enthält einen Symlink; die Vergabe ist blockiert');
    if (!info.isDirectory()) continue;
    const profilePath = path.join(actualEntryPath, 'REFERENZ.md');
    if (!existsSync(profilePath)) {
      rows.push({ displayName: entry.name });
      continue;
    }
    const profileInfo = lstatSync(profilePath);
    if (!profileInfo.isFile() || profileInfo.isSymbolicLink() || profileInfo.size > MAX_PROFILE_BYTES) {
      throw new Error('Das Projektprofil ist keine sichere reguläre Datei');
    }
    const fd = openSync(profilePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      const after = lstatSync(profilePath);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== profileInfo.dev || opened.ino !== profileInfo.ino ||
          after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error('Das Projektprofil hat sich beim Durchsuchen geändert');
      }
      const contents = readFileSync(fd, 'utf8');
      const match = /^\s*(?:displayName|Anzeigename):\s*([^\r\n]+)/imu.exec(contents);
      rows.push({ displayName: match?.[1]?.replace(/^[`"']|[`"']$/gu, '').trim() ?? entry.name, localProject: true, name: entry.name, projectRoot: actualEntryPath });
    } finally {
      closeSync(fd);
    }
    }
  }
  return { projectsRoot, rows };
}

function validateLedger(value) {
  if (!value || value.schema !== ALLOCATION_SCHEMA || !value.domains || typeof value.domains !== 'object') {
    throw new Error('Das Projektcode-Vergabe-Register ist ungültig');
  }
  for (const [agentId, baseline] of Object.entries(PROJECT_CODE_BASELINE)) {
    const row = value.domains[agentId];
    if (!row || row.prefix !== baseline.prefix || !Number.isInteger(row.highWater) ||
        row.highWater < baseline.highWater || row.highWater > 999 || !Array.isArray(row.reservations)) {
      throw new Error(`Das Projektcode-Vergabe-Register ist unvollständig für ${agentId}`);
    }
    if (row.models !== undefined && (!row.models || typeof row.models !== 'object' || Array.isArray(row.models))) {
      throw new Error(`Die Projektcode-Modellzuordnungen sind ungültig für ${agentId}`);
    }
    row.models ??= {};
  }
  return value;
}

export async function reserveProjectDisplayId({
  agentId,
  name,
  projectRows,
  workspaceRoot,
  agentConfig,
  projectLocations,
  currentProjectsRoot,
  store,
  assertCurrent = () => {},
  now = () => new Date().toISOString(),
  makeProjectId = () => `local-${randomUUID()}`,
  maxAttempts = 5,
}) {
  const baseline = resolveAgentBaseline(agentId, agentConfig);
  const activeModel = agentConfig?.models?.find((row) => row.active)?.model;
  const placeholderStart = activeModel?.search(/[XY]/u) ?? -1;
  const activePrefix = placeholderStart >= 0 ? activeModel.slice(0, placeholderStart) : '';
  const activePlaceholders = placeholderStart >= 0 ? activeModel.slice(placeholderStart) : '';
  const parsedModel = /^[A-WZ]{1,4}$/u.test(activePrefix) && /^[XY]{2,6}$/u.test(activePlaceholders);
  const assignment = baseline && parsedModel ? { agentId, prefix: activePrefix, width: activePlaceholders.length,
    model: activeModel, domain: baseline.domain,
    highWater: activeModel === `${baseline.prefix}XXX` ? baseline.highWater : 0 }
    : agentConfig ? undefined : resolveProjectAssignment(agentId);
  const normalizedName = normalizeProjectName(name);
  const rootInfo = lstatSync(workspaceRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(workspaceRoot) !== workspaceRoot) {
    throw new Error('Der aktuelle Agenten-Workspace muss kanonisch und lokal sein');
  }
  if (!assignment) throw new Error('Für diesen Agenten ist kein aktives Projekt-Codemodell konfiguriert. Konfiguriere zuerst ein Präfixmodell.');
  const local = scanLocalProjects(workspaceRoot, projectLocations, currentProjectsRoot);
  await store.registerIfAbsent('allocation-ledger', allocationBaseline());

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    assertCurrent();
    const observed = await store.observe('allocation-ledger');
    const ledger = validateLedger(observed.value);
    const domainLedger = ledger.domains[agentId]
      ?? { prefix: baseline.prefix, highWater: baseline.highWater, reservations: [], models: {} };
    const facts = collectProjectFacts(projectRows, local.rows, assignment.prefix, assignment.width ?? 3);
    if (facts.names.has(normalizedName.toLocaleLowerCase())) {
      throw new Error('Ein Projekt mit diesem Namen existiert in der aktuellen Domain bereits');
    }
    const defaultModel = `${baseline.prefix}XXX`;
    const initialHighWater = assignment.model === defaultModel || !agentConfig
      ? Math.max(assignment.highWater ?? 0, domainLedger.highWater) : assignment.highWater ?? 0;
    const modelLedger = domainLedger.models[assignment.model ?? defaultModel] ?? { highWater: initialHighWater, reservations: [] };
    const observedHighWater = Math.max(modelLedger.highWater ?? assignment.highWater, ...[...facts.codes].map((code) => Number(code.slice(assignment.prefix.length))));
    const nextNumber = observedHighWater + 1;
    if (nextNumber >= 10 ** (assignment.width ?? 3)) throw new Error('Der Projektcode-Bereich ist erschöpft');
    const displayId = `${assignment.prefix}${String(nextNumber).padStart(assignment.width ?? 3, '0')}`;
    const projectId = makeProjectId();
    if (typeof projectId !== 'string' || !/^local-[a-f0-9-]{36}$/u.test(projectId)) {
      throw new Error('Der Projekt-ID-Generator hat eine ungültige Kennung geliefert');
    }
    const reservation = {
      displayId,
      projectId,
      agentId,
      domain: assignment.domain,
      displayName: `${displayId} – ${normalizedName}`,
      status: 'reserved',
      reservedAt: now(),
    };
    const nextModelLedger = { highWater: nextNumber, reservations: [...(modelLedger.reservations ?? []), reservation] };
    const nextLedger = {
      ...ledger,
      domains: {
        ...ledger.domains,
        [agentId]: {
          ...domainLedger,
          ...(assignment.model === `${baseline.prefix}XXX` || !agentConfig
            ? { highWater: nextNumber, reservations: [...domainLedger.reservations, reservation] } : {}),
          models: { ...domainLedger.models, [assignment.model ?? `${assignment.prefix}XXX`]: nextModelLedger },
        },
      },
    };
    assertCurrent();
    const result = await store.compareAndApply('allocation-ledger', observed.comparison, {
      operation: 'update',
      action: 'set',
      value: nextLedger,
    });
    if (result.status === 'applied' || result.status === 'unchanged') {
      return { assignment, reservation, projectsRoot: currentProjectsRoot ?? local.projectsRoot };
    }
    if (result.status !== 'conflict') throw new Error('Die Projektcode-Reservierung ist fehlgeschlagen');
  }
  throw new Error('Die Projektcode-Vergabe ist wiederholt kollidiert; es wurde kein Workspace angelegt');
}

function writeNewFile(filePath, contents) {
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function cleanupCreatedProject(projectRoot, uid, written) {
  for (const name of written) {
    const target = path.join(projectRoot, name);
    try {
      const info = lstatSync(target);
      if (info.isFile() && !info.isSymbolicLink() && info.uid === uid && info.nlink === 1) unlinkSync(target);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const info = lstatSync(projectRoot);
  if (info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && realpathSync(projectRoot) === projectRoot) {
    // Non-recursive on purpose: refuses to remove anything this helper did not create.
    rmdirSync(projectRoot);
  }
}

export async function abandonProjectDisplayId({ store, agentId, projectId, displayId, assertCurrent = () => {}, now = () => new Date().toISOString() }) {
  const observed = await store.observe('allocation-ledger');
  const ledger = validateLedger(observed.value);
  const domain = ledger.domains[agentId];
  if (!domain) return { status: 'not-found' };
  let changed = false;
  const mark = (rows) => (rows ?? []).map((row) => {
    if (row && row.projectId === projectId && row.displayId === displayId && row.status === 'reserved') {
      changed = true;
      return { ...row, status: 'abandoned', abandonedAt: now() };
    }
    return row;
  });
  const nextDomain = {
    ...domain,
    reservations: mark(domain.reservations),
    models: Object.fromEntries(Object.entries(domain.models ?? {})
      .map(([model, row]) => [model, { ...row, reservations: mark(row?.reservations) }])),
  };
  if (!changed) return { status: 'not-found' };
  assertCurrent();
  const result = await store.compareAndApply('allocation-ledger', observed.comparison,
    { operation: 'update', action: 'set', value: { ...ledger, domains: { ...ledger.domains, [agentId]: nextDomain } } });
  if (result.status !== 'applied' && result.status !== 'unchanged') return { status: 'conflict' };
  return { status: 'abandoned', displayId };
}

export function createProjectWorkspace({ workspaceRoot, projectsRoot, reservation, owner = '', now = () => new Date().toISOString(), writeFile = writeNewFile }) {
  const workspaceInfo = lstatSync(workspaceRoot);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || realpathSync(workspaceRoot) !== workspaceRoot) {
    throw new Error('Der aktuelle Agenten-Workspace muss ein kanonisches echtes Verzeichnis sein');
  }
  const projectRoot = path.join(projectsRoot, reservation.projectId);
  if (!projectRoot.startsWith(`${workspaceRoot}${path.sep}`) || path.dirname(projectRoot) !== projectsRoot) {
    throw new Error('Der aufgelöste Projektpfad verlässt den aktuellen Agenten-Workspace');
  }
  mkdirSync(projectsRoot, { recursive: true, mode: 0o700 });
  const projectsInfo = lstatSync(projectsRoot);
  if (!projectsInfo.isDirectory() || projectsInfo.isSymbolicLink() || realpathSync(projectsRoot) !== projectsRoot) {
    throw new Error('Das Projekte-Verzeichnis muss ein kanonisches echtes Verzeichnis sein');
  }
  mkdirSync(projectRoot, { mode: 0o700 });
  const projectInfo = lstatSync(projectRoot);
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink() || realpathSync(projectRoot) !== projectRoot ||
      projectInfo.uid !== workspaceInfo.uid) {
    throw new Error('Das angelegte Projektverzeichnis hat die Eigentümer- und Kanonisch-Pfadprüfung nicht bestanden');
  }
  const profile = `# ${reservation.displayName}\n\nAnzeigename: ${reservation.displayName}\n\n| Feld | Wert |\n|---|---|\n| Status | WORKSPACE_READY |\n| Anzeigename | ${reservation.displayName} |\n| Stabile lokale Projekt-ID | \`${reservation.projectId}\` |\n| OpenClaw-Agent | \`${reservation.agentId}\` |\n| Domain | ${reservation.domain} |\n| Owner | ${owner || '—'} |\n| Workspace | \`${workspaceRoot}\` |\n| Projektpfad | \`${projectRoot}\` |\n| Dashboard | UNSUPPORTED_FOR_LOCAL_FOLDER |\n| Kontextbindung | OPENCLAW_AGENT_WORKSPACE_ONLY |\n| Erstellt | ${now()} |\n\n## Zweck und führende Quellen\n\nNoch nicht eingetragen.\n\n## Freigegebene Kontextquellen\n\nNoch keine Quellen übernommen. Chatverläufe und Workspace-Dateien werden nicht automatisch importiert.\n`;
  const context = `# ${reservation.displayName} – Arbeitskontext\n\nStatus: WORKSPACE_READY; Kontext wird ausschließlich für den zuständigen Agenten und eine diesem Projekt zugeordnete Unterhaltung geladen.\n\n## Ziel\n\nNoch nicht eingetragen.\n\n## Letzter bestätigter Stand\n\nProjekt-Workspace wurde am ${now()} angelegt. Es wurden keine Chats oder Dateien übernommen.\n\n## Entscheidungen und offene Punkte\n\n- Projektzweck und führende Quellen festlegen.\n- Neue Entscheidungen nur nach ausdrücklichem Arbeitsauftrag in diesem Projektkontext festhalten.\n`;
  const written = [];
  try {
    writeFile(path.join(projectRoot, 'REFERENZ.md'), profile);
    written.push('REFERENZ.md');
    writeFile(path.join(projectRoot, 'KONTEXT.md'), context);
    written.push('KONTEXT.md');
  } catch (error) {
    try { cleanupCreatedProject(projectRoot, workspaceInfo.uid, written); }
    catch (cleanupError) { error.message = `${error.message}; cleanup incomplete: ${cleanupError.message}`; }
    throw error;
  }
  return { projectRoot, displayName: reservation.displayName, projectId: reservation.projectId };
}
