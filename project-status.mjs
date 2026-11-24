#!/usr/bin/env node
// Read-only status report. Prints what is true right now instead of asking a
// human to copy commit hashes and versions into a document that will be stale
// within hours. Never writes.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(argValue('--root') ?? scriptDir);

function run(command, argv, options = {}) {
  return execFileSync(command, argv, { encoding: 'utf8', timeout: 20000, ...options }).trim();
}

function repoState() {
  // Version and git state are read independently: a directory without git still
  // has a package.json, and reporting UNKNOWN for both would hide that.
  let version = 'UNKNOWN';
  try { version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { /* keep UNKNOWN */ }
  let head = 'UNKNOWN';
  try { head = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }); } catch { /* keep UNKNOWN */ }
  return { head, version };
}

function installedVersion() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  const candidates = [
    path.join(stateDir, 'extensions', 'awf-project-context', 'package.json'),
    path.join(stateDir, 'extensions', '@zrzavywa', 'openclaw-project-context', 'package.json'),
  ];
  for (const file of candidates) {
    try { return JSON.parse(readFileSync(file, 'utf8')).version; } catch { /* try next */ }
  }
  return 'nicht installiert';
}

function projectStats(workspaceDir) {
  if (!workspaceDir) return undefined;
  const projectsRoot = path.join(path.resolve(workspaceDir), 'projects');
  try {
    const entries = readdirSync(projectsRoot, { withFileTypes: true });
    const projects = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const active = projects.filter((entry) => {
      try {
        const profile = readFileSync(path.join(projectsRoot, entry.name, 'REFERENZ.md'), 'utf8');
        return !/^\|\s*Status\s*\|\s*(archived|trash)/imu.test(profile);
      } catch { return false; }
    });
    const archives = projects.reduce((sum, entry) => {
      const dir = path.join(projectsRoot, entry.name, 'history', 'captures');
      try { return sum + (statSync(dir).isDirectory() ? readdirSync(dir).length : 0); } catch { return sum; }
    }, 0);
    return { active: active.length, archives };
  } catch { return undefined; }
}

function onlineState() {
  if (!has('--online')) return { mirror: 'UNKNOWN (--online)', catalog: 'UNKNOWN (--online)' };
  let mirror = 'UNKNOWN';
  try {
    const tags = JSON.parse(run('gh', ['api', 'repos/zrzavywa/openclaw-project-context/tags']));
    mirror = tags?.[0]?.name ? `${tags[0].name} ${String(tags[0].commit?.sha ?? '').slice(0, 7)}` : 'UNKNOWN';
  } catch { mirror = 'UNKNOWN (Abfrage fehlgeschlagen)'; }
  let catalog = 'UNKNOWN';
  try {
    const raw = run('npx', ['-y', 'clawhub@latest', 'package', 'inspect', '@zrzavywa/openclaw-project-context']);
    catalog = /^Latest:\s*(\S+)/mu.exec(raw)?.[1] ?? 'UNKNOWN';
  } catch { catalog = 'UNKNOWN (Abfrage fehlgeschlagen)'; }
  return { mirror, catalog };
}

const repo = repoState();
const online = onlineState();
const stats = projectStats(argValue('--workspace'));

const rows = [
  ['Repo', `${repo.head}  ${repo.version}`],
  ['Spiegel', online.mirror],
  ['Katalog', online.catalog],
  ['Installiert', installedVersion()],
];
if (stats) rows.push(['Projekte', `${stats.active} aktiv, ${stats.archive ?? stats.archives} Archive`]);

const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value] of rows) console.log(`${label.padEnd(width)}  ${value}`);
if (!has('--online')) console.log('\nKatalog und Spiegel nur mit --online lesbar.');
