#!/usr/bin/env node
// Static health summary. Runs the read-only checks that do not need a session:
// release integrity, loaded generation and (optionally) the project documents.
import { spawnSync } from 'node:child_process';

const checks = [
  ['release:verify', ['npm', ['run', 'release:verify']]],
  ['verify:loaded', ['npm', ['run', 'verify:loaded']]],
];
const docsRoot = process.env.AWF_DOCS_DIR;
if (docsRoot) checks.push(['check:docs', ['npm', ['run', 'check:docs', '--', docsRoot]]]);

let failed = 0;
for (const [name, [command, argv]] of checks) {
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  const ok = result.status === 0;
  if (!ok) failed += 1;
  const last = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${last ? ` — ${last}` : ''}`);
}
console.log(failed === 0 ? 'health PASS' : `health FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
