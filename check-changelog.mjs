#!/usr/bin/env node
// Fails when the released version has no changelog entry of its own.
// Keeps package.json, release.json and CHANGELOG.md from drifting apart again.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json');

function fail(code, message, detail) {
  const finding = { code, message, ...(detail ? { detail } : {}) };
  if (asJson) process.stdout.write(`${JSON.stringify({ status: 'FAIL', findings: [finding] }, null, 2)}\n`);
  else process.stderr.write(`FEHLER [${code}] ${message}${detail ? `: ${detail}` : ''}\n`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (error) {
  fail('package-unreadable', 'package.json ist nicht lesbar', error.message);
}
const version = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : '';
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('version-invalid', 'package.json enthält keine gültige Semver-Version', version || '(leer)');
}

let changelog;
try {
  changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
} catch (error) {
  fail('changelog-unreadable', 'CHANGELOG.md ist nicht lesbar', error.message);
}

const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gmu)].map((match) => match[1].trim());
if (headings.length === 0) fail('changelog-empty', 'CHANGELOG.md enthält keinen versionierten Abschnitt');

if (!headings.includes(version)) {
  fail('changelog-entry-missing', `CHANGELOG.md hat keinen Abschnitt für ${version}`,
    `vorhanden: ${headings.slice(0, 3).join(', ')}`);
}
if (headings[0] !== version) {
  fail('changelog-order', `Der neueste CHANGELOG-Abschnitt ist ${headings[0]}, erwartet ${version}`,
    'Neueste Version muss oben stehen');
}
if (new Set(headings).size !== headings.length) {
  fail('changelog-duplicate', 'CHANGELOG.md enthält doppelte Versionsabschnitte');
}

if (asJson) process.stdout.write(`${JSON.stringify({ status: 'PASS', version, headings: headings.length }, null, 2)}\n`);
else process.stdout.write(`CHANGELOG-Gate: PASS (${version}, ${headings.length} Abschnitte)\n`);
