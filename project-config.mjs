import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveAgentBaseline } from './project-creation.mjs';

export const PROJECT_AGENT_CONFIG_SCHEMA = 'awf.project-agent-config.v1';
const LOCATION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function parseProjectCodeModel(model) {
  if (typeof model !== 'string') throw new Error('Das Projekt-Codemodell muss Text wie AXXX sein.');
  const normalized = model.trim().toUpperCase();
  const placeholderStart = normalized.search(/[XY]/u);
  const prefix = placeholderStart < 0 ? '' : normalized.slice(0, placeholderStart);
  const placeholders = placeholderStart < 0 ? '' : normalized.slice(placeholderStart);
  if (!/^[A-WZ]{1,4}$/u.test(prefix) || !/^[XY]{2,6}$/u.test(placeholders)) {
    throw new Error('Das Modellformat muss aus 1–4 Buchstaben ohne X/Y und danach 2–6 X/Y-Ziffernplätzen bestehen, zum Beispiel AXXX oder BXXYY.');
  }
  return { model: normalized, prefix, width: placeholders.length };
}

export function defaultProjectAgentConfig(agentId, workspacePath) {
  const baseline = resolveAgentBaseline(agentId);
  return { schema: PROJECT_AGENT_CONFIG_SCHEMA, agentId, workspacePath,
    generation: 0, models: [{ model: `${baseline.prefix}XXX`, active: true }],
    currentLocation: 'projects', locations: ['projects'] };
}

export function validateProjectAgentConfig(value, agentId, workspacePath) {
  if (!value) return defaultProjectAgentConfig(agentId, workspacePath);
  if (value.schema !== PROJECT_AGENT_CONFIG_SCHEMA || value.agentId !== agentId ||
      value.workspacePath !== workspacePath || !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 16 ||
      !Array.isArray(value.locations) || value.locations.length < 1 || value.locations.length > 32 ||
      typeof value.currentLocation !== 'string') {
    throw new Error('Die Projektkonfiguration des Agenten ist ungültig oder gehört zu einem anderen Workspace.');
  }
  const seen = new Set();
  let active = 0;
  for (const item of value.models) {
    const parsed = parseProjectCodeModel(item?.model);
    if (seen.has(parsed.model) || typeof item.active !== 'boolean') throw new Error('Die Projekt-Codemodelle des Agenten sind doppelt oder ungültig.');
    seen.add(parsed.model);
    if (item.active) active += 1;
  }
  // No active model is valid after deleting the current prefix; project creation
  // stays disabled until another model is configured.
  if (active > 1) throw new Error('Es darf nur ein Projekt-Codemodell aktiv sein.');
  let baseline;
  if (value.baseline !== undefined) {
    const b = value.baseline;
    if (!b || typeof b !== 'object' || typeof b.prefix !== 'string' || !/^[A-WZ]{1,4}$/u.test(b.prefix) ||
        !Number.isSafeInteger(b.highWater) || b.highWater < 0 || b.highWater > 999999 ||
        typeof b.domain !== 'string' || !b.domain.trim() || b.domain.trim().length > 64) {
      throw new Error('Die konfigurierte Code-Baseline ist ungültig (Präfix, Obergrenze, Domain).');
    }
    baseline = { prefix: b.prefix, highWater: b.highWater, domain: b.domain.trim() };
  }
  const normalizedLocations = value.locations.map(normalizeProjectLocation);
  if (new Set(normalizedLocations).size !== normalizedLocations.length ||
      !normalizedLocations.includes(normalizeProjectLocation(value.currentLocation))) {
    throw new Error('Die Projektpfade des Agenten sind doppelt oder widersprüchlich.');
  }
  return { ...value, ...(baseline ? { baseline } : {}), locations: normalizedLocations, currentLocation: normalizeProjectLocation(value.currentLocation) };
}

export function normalizeProjectLocation(value) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
    throw new Error('Der Projektpfad muss ein relativer Pfad innerhalb dieses Agenten-Workspace sein.');
  }
  const parts = value.trim().split(/[\\/]+/u);
  if (parts.some((part) => !LOCATION_SEGMENT_RE.test(part) || part === '.' || part === '..')) {
    throw new Error('Der Projektpfad darf nur sichere relative Ordnernamen innerhalb dieses Agenten-Workspace enthalten.');
  }
  return parts.join(path.sep);
}

export function resolveProjectLocations(workspacePath, config, expectedUid, { createCurrent = false } = {}) {
  const locations = [];
  for (const relative of config.locations) {
    const normalized = normalizeProjectLocation(relative);
    const root = path.resolve(workspacePath, normalized);
    if (root === workspacePath || !root.startsWith(`${workspacePath}${path.sep}`)) throw new Error('Der Projektpfad verlässt den Workspace des Agenten.');
    let cursor = workspacePath;
    let complete = true;
    for (const segment of path.relative(workspacePath, root).split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (!existsSync(cursor) && createCurrent && normalized === config.currentLocation) mkdirSync(cursor, { mode: 0o700 });
      if (!existsSync(cursor)) { complete = false; break; }
      const info = lstatSync(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid || realpathSync(cursor) !== cursor ||
          (createCurrent && normalized === config.currentLocation && (info.mode & 0o077) !== 0)) {
        throw new Error('Der konfigurierte Projektpfad ist kein kanonisches Verzeichnis nur für den Eigentümer.');
      }
    }
    if (complete) locations.push(root);
  }
  if (createCurrent && !locations.includes(path.resolve(workspacePath, config.currentLocation))) {
    throw new Error('Der konfigurierte Projektpfad konnte nicht sicher angelegt werden.');
  }
  return [...new Set(locations)];
}

export function activeProjectCodeModel(config) {
  const row = config.models.find((item) => item.active);
  return row ? parseProjectCodeModel(row.model) : undefined;
}

export function projectCodeModels(config) {
  return config.models.map((item) => ({ ...parseProjectCodeModel(item.model), active: item.active }));
}

export function makeProjectCode(model, number) {
  const parsed = parseProjectCodeModel(model);
  if (!Number.isSafeInteger(number) || number < 0 || number >= 10 ** parsed.width) throw new Error('Der Projektcode-Bereich ist erschöpft.');
  return `${parsed.prefix}${String(number).padStart(parsed.width, '0')}`;
}
