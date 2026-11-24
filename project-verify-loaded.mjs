#!/usr/bin/env node
// Verifies that the running gateway generation matches the installed package.
// Read-only: reads the installed package.json and the plugin load marker from
// the gateway log. Never writes, never touches the network.
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeLoadState, parseLoadedVersionFromLog } from './project-runtime.mjs';

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');

function installedVersion() {
  const candidates = [
    path.join(stateDir, 'extensions', 'awf-project-context', 'package.json'),
    path.join(stateDir, 'extensions', '@zrzavywa', 'openclaw-project-context', 'package.json'),
  ];
  for (const file of candidates) {
    try { return JSON.parse(readFileSync(file, 'utf8')).version ?? null; } catch { /* next candidate */ }
  }
  return null;
}

function loadedVersionFromLogs() {
  const logsRoot = path.join(stateDir, 'logs');
  let files = [];
  try {
    files = readdirSync(logsRoot)
      .filter((name) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/u.test(name))
      .sort()
      .reverse()
      .slice(0, 2);
  } catch { return null; }
  let loaded = null;
  // Newest file first: a marker in the newest log wins; older files only fill gaps.
  for (const name of files) {
    try {
      const found = parseLoadedVersionFromLog(readFileSync(path.join(logsRoot, name), 'utf8'));
      if (found) { loaded = found; break; }
    } catch { /* unreadable log is not a verdict */ }
  }
  return loaded;
}

const state = describeLoadState({ loadedVersion: loadedVersionFromLogs(), installedVersion: installedVersion() });
const label = state.status === 'loaded' ? 'PASS' : state.status === 'pending-restart' ? 'FAIL' : 'UNKNOWN';
console.log(`verify:loaded ${label}`);
console.log(`  geladen:     ${state.loadedVersion ?? 'UNKNOWN'}`);
console.log(`  installiert: ${state.installedVersion ?? 'UNKNOWN'}`);
process.exit(state.status === 'loaded' ? 0 : state.status === 'pending-restart' ? 1 : 2);
