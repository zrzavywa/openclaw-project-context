import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOAD_MARKER_PREFIX = 'awf-project-context loaded';

export function describeLoadState({ loadedVersion, installedVersion }) {
  if (!loadedVersion || !installedVersion) {
    return { status: 'unknown', loadedVersion: loadedVersion ?? null, installedVersion: installedVersion ?? null };
  }
  if (loadedVersion !== installedVersion) {
    return { status: 'pending-restart', loadedVersion, installedVersion };
  }
  return { status: 'loaded', loadedVersion, installedVersion };
}

export function formatLoadStateLine(state) {
  if (!state || state.status === 'unknown') {
    return '- **Laufzeit:** UNKNOWN — geladene Version nicht belegbar.';
  }
  if (state.status === 'pending-restart') {
    return `- **Laufzeit:** MISMATCH — geladen ${state.loadedVersion}, installiert ${state.installedVersion}. Die neue Generation wird erst nach einem Neustart wirksam.`;
  }
  return `- **Laufzeit:** geladen ${state.loadedVersion}, installiert ${state.installedVersion}.`;
}

export function readInstalledVersion(packageJsonPath) {
  try { return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version ?? null; } catch { return null; }
}

export function parseLoadedVersionFromLog(text) {
  if (typeof text !== 'string' || !text) return null;
  const pattern = new RegExp(`${LOAD_MARKER_PREFIX} (\\d+\\.\\d+\\.\\d+)`, 'gu');
  let last = null;
  for (const match of text.matchAll(pattern)) last = match[1];
  return last;
}

export function inspectInstalledPlugin({ moduleUrl = import.meta.url } = {}) {
  try {
    const root = dirname(fileURLToPath(moduleUrl));
    return readInstalledVersion(join(root, 'package.json'));
  } catch { return null; }
}
