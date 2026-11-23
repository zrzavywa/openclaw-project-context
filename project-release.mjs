import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_MANIFEST_FILE = 'release.json';
export const RELEASE_SCHEMA = 'awf.project-release.v1';
const MAX_RELEASE_FILE_BYTES = 1024 * 1024;

function safeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return undefined;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  return parts.join(path.sep);
}

function readChecked(root, relative) {
  const target = path.join(root, ...relative.split(path.sep));
  const before = lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RELEASE_FILE_BYTES) {
    throw new Error('ist keine sichere reguläre Datei');
  }
  const fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(target);
    if (!opened.isFile() || opened.size > MAX_RELEASE_FILE_BYTES || opened.dev !== before.dev ||
        opened.ino !== before.ino || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('hat sich beim Lesen geändert');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function digestOf(files) {
  return createHash('sha256')
    .update(files.map((row) => `${row.sha256}  ${row.path}\n`).join(''))
    .digest('hex');
}

export function releaseFileList(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = Array.isArray(pkg.files) ? pkg.files : [];
  const normalized = ['package.json', ...declared].map(safeRelative).filter(Boolean);
  const unique = [...new Set(normalized)];
  return unique
    .filter((relative) => relative.split(path.sep).pop() !== RELEASE_MANIFEST_FILE)
    .sort();
}

export function computeReleaseManifest(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = releaseFileList(root).map((relative) => {
    const bytes = readChecked(root, relative);
    return {
      path: relative.split(path.sep).join('/'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return { schema: RELEASE_SCHEMA, name: pkg.name, version: pkg.version, files, digest: digestOf(files) };
}

export function verifyReleaseManifest(root, manifest) {
  const findings = [];
  if (!manifest || manifest.schema !== RELEASE_SCHEMA || !Array.isArray(manifest.files) ||
      manifest.files.some((row) => !row || typeof row.path !== 'string' || typeof row.sha256 !== 'string' ||
        !Number.isSafeInteger(row.bytes))) {
    return { status: 'INVALID', findings: [{ severity: 'error', code: 'release-manifest-invalid',
      message: 'release.json has an unsupported schema or shape' }] };
  }
  let pkg;
  try { pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch { return { status: 'INVALID', findings: [{ severity: 'error', code: 'package-json-unreadable',
    message: 'package.json could not be read' }] }; }
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
    findings.push({ severity: 'error', code: 'release-version-mismatch',
      message: `release.json declares ${manifest.name}@${manifest.version}; package.json has ${pkg.name}@${pkg.version}` });
  }
  if (manifest.digest !== undefined && digestOf(manifest.files) !== manifest.digest) {
    findings.push({ severity: 'error', code: 'release-manifest-invalid',
      message: 'release.json content digest does not match its file list' });
  }
  const expected = new Map(manifest.files.map((row) => [row.path, row]));
  const actual = new Set(releaseFileList(root).map((relative) => relative.split(path.sep).join('/')));
  for (const [relative, row] of expected) {
    if (!actual.has(relative)) {
      findings.push({ severity: 'error', code: 'release-file-unexpected',
        message: `release.json lists ${relative}, which package.json does not declare` });
      continue;
    }
    let bytes;
    try { bytes = readChecked(root, relative.split('/').join(path.sep)); }
    catch (error) {
      findings.push({ severity: 'error', code: 'release-file-missing',
        message: `${relative}: ${error.message}` });
      continue;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== row.sha256 || bytes.length !== row.bytes) {
      findings.push({ severity: 'error', code: 'release-hash-mismatch',
        message: `${relative} differs from the release manifest` });
    }
  }
  for (const relative of actual) {
    if (!expected.has(relative)) {
      findings.push({ severity: 'error', code: 'release-file-missing',
        message: `${relative} is declared by package.json but missing from release.json` });
    }
  }
  return { status: findings.length ? 'MISMATCH' : 'PASS', findings, version: manifest.version, checked: actual.size };
}

export function writeReleaseManifest(root) {
  const manifest = computeReleaseManifest(root);
  const target = path.join(root, RELEASE_MANIFEST_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) { try { unlinkSync(temp); } catch {} }
  }
  return manifest;
}

export function inspectReleaseDirectory(root) {
  try {
    const manifest = readReleaseManifest(root);
    if (!manifest) {
      return { status: 'MISSING', label: '(release.json not installed)', findings: [{
        severity: 'warning', code: 'release-manifest-missing', scope: 'plugin',
        message: `${RELEASE_MANIFEST_FILE} is not present; installed plugin files cannot be verified against a release manifest.` }] };
    }
    const result = verifyReleaseManifest(root, manifest);
    return { status: result.status, version: result.version, label: `${manifest.name}@${manifest.version}`,
      findings: (result.findings ?? []).map((item) => ({ ...item, scope: 'plugin' })) };
  } catch (error) {
    return { status: 'INVALID', label: '(unreadable release.json)', findings: [{
      severity: 'error', code: 'release-manifest-invalid', scope: 'plugin', message: error.message }] };
  }
}

export function readReleaseManifest(root) {
  const target = path.join(root, RELEASE_MANIFEST_FILE);
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`release.json konnte nicht gelesen werden: ${error.message}`);
  }
}

function main() {
  const [mode, target] = process.argv.slice(2);
  const root = path.resolve(target ?? '.');
  if (mode === '--write') {
    process.stdout.write(`${JSON.stringify(writeReleaseManifest(root), null, 2)}\n`);
    return;
  }
  if (mode === '--verify') {
    let manifest;
    try { manifest = readReleaseManifest(root); }
    catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'INVALID', findings: [{ severity: 'error', code: 'release-manifest-invalid', message: error.message }] }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const result = manifest
      ? verifyReleaseManifest(root, manifest)
      : { status: 'MISSING', findings: [{ severity: 'warning', code: 'release-manifest-missing', message: 'release.json is not present' }] };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'PASS') process.exitCode = 1;
    return;
  }
  process.stderr.write('Usage: node project-release.mjs --write|--verify [directory]\n');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
