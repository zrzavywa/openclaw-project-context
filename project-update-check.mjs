#!/usr/bin/env node
// Read-only update check: compares the catalog version with the installed one and
// prints the exact operator command. It never installs anything.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');

export function planUpdate({ catalogVersion, installedVersion }) {
  if (!catalogVersion || !installedVersion) {
    return { status: 'unknown', line: 'update:check UNKNOWN — Katalog- oder Installationsversion fehlt.' };
  }
  if (catalogVersion === installedVersion) {
    return { status: 'current', line: `update:check OK — ${installedVersion} ist Katalog- und Installationsstand.` };
  }
  const command = `openclaw plugins install @zrzavywa/openclaw-project-context@${catalogVersion} --force`;
  return { status: 'available', catalogVersion, installedVersion,
    line: `update:check AVAILABLE — Katalog ${catalogVersion}, installiert ${installedVersion}.`,
    operatorSteps: [command, 'openclaw gateway restart', 'npm run verify:loaded'] };
}

function installedVersion() {
  const candidates = [path.join(stateDir, 'extensions', 'awf-project-context', 'package.json')];
  for (const file of candidates) {
    try { return JSON.parse(readFileSync(file, 'utf8')).version ?? null; } catch { /* next candidate */ }
  }
  return null;
}

function catalogVersion() {
  const given = argValue('--catalog-version');
  if (given) return given;
  try {
    const raw = execFileSync('npx', ['-y', 'clawhub@latest', 'package', 'inspect', '@zrzavywa/openclaw-project-context'],
      { encoding: 'utf8', timeout: 60000 });
    return /\bversion\b[^\n]*?(\d+\.\d+\.\d+)/iu.exec(raw)?.[1] ?? /(\d+\.\d+\.\d+)/u.exec(raw)?.[1] ?? null;
  } catch { return null; }
}

if (process.argv[1] && process.argv[1].endsWith('project-update-check.mjs')) {
  const plan = planUpdate({ catalogVersion: catalogVersion(), installedVersion: installedVersion() });
  console.log(plan.line);
  for (const step of plan.operatorSteps ?? []) console.log(`  ${step}`);
  process.exit(plan.status === 'unknown' ? 2 : 0);
}
