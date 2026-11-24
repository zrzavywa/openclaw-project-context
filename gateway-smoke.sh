#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-/home/openclaw/.npm-global/bin/openclaw}"
NODE_BIN="${NODE_BIN:-node}"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d /tmp/awf-project-context-gateway.XXXXXX)"
GATEWAY_PID=""
STUB_PID=""

cleanup() {
  if [[ -n "$GATEWAY_PID" ]]; then kill "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true; fi
  if [[ -n "$STUB_PID" ]]; then kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; fi
  if [[ "${KEEP_TEMP:-0}" == "1" ]]; then
    echo "Retained synthetic profile for diagnosis: $ROOT" >&2
  else
    chmod -R u+w "$ROOT" 2>/dev/null || true
    rm -rf "$ROOT"
  fi
}
trap cleanup EXIT

if ss -ltn | grep -Eq ':(19346|19349)\b'; then
  echo "Synthetic ports 19346 or 19349 are already occupied" >&2
  exit 2
fi

export OPENCLAW_STATE_DIR="$ROOT/state"
export OPENCLAW_CONFIG_PATH="$ROOT/openclaw.json"
"$NODE_BIN" "$PLUGIN_DIR/gateway-fixture.mjs" "$ROOT" "$PLUGIN_DIR" 19349
"$OPENCLAW_BIN" config validate

"$NODE_BIN" "$PLUGIN_DIR/gateway-model-stub.mjs" >"$ROOT/model-stub.log" 2>&1 &
STUB_PID=$!
"$OPENCLAW_BIN" gateway run --verbose --port 19349 --allow-unconfigured >"$ROOT/gateway.log" 2>&1 &
GATEWAY_PID=$!

ready=false
for _ in $(seq 1 80); do
  if "$OPENCLAW_BIN" gateway health >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.5
done
if [[ "$ready" != true ]]; then cat "$ROOT/gateway.log"; exit 3; fi

set +e
"$OPENCLAW_BIN" agent --agent main --session-key awf-project-context-smoke \
  --message "Create a project named Synthetic Gateway Pilot." --timeout 45 --json >"$ROOT/select.json"
FIRST_RC=$?
set -e
if [[ "$FIRST_RC" -ne 0 ]]; then
  cat "$ROOT/select.json" >&2
  "$OPENCLAW_BIN" devices approve --latest --json --timeout 10000 >"$ROOT/device-approval.json"
  "$OPENCLAW_BIN" agent --agent main --session-key awf-project-context-smoke \
    --message "Create a project named Synthetic Gateway Pilot." --timeout 45 --json >"$ROOT/select.json"
fi

"$NODE_BIN" --input-type=module - "$ROOT/workspace-main/projects" <<'NODE'
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const projectsRoot = process.argv[2];
const projectRoot = readdirSync(projectsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  .map((entry) => path.join(projectsRoot, entry.name))
  .find((root) => readFileSync(path.join(root, 'REFERENZ.md'), 'utf8').includes('A004'));
if (!projectRoot) throw new Error('Synthetic A004 project was not created');
appendFileSync(path.join(projectRoot, 'KONTEXT.md'), '\nAWF_PROJECT_AUTO_CONTEXT_CHECK\n');
NODE

"$OPENCLAW_BIN" agent --agent main --session-key awf-project-context-smoke \
  --message "Check whether the selected project context is available." --timeout 45 --json >"$ROOT/context-check.json"

"$NODE_BIN" --input-type=module - "$ROOT/model-stub.log" "$ROOT/select.json" "$ROOT/context-check.json" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const calls = readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const toolMessages = calls.flatMap((call) => call.tool_messages ?? []);
assert.ok(toolMessages.some((message) => /(?:Erstellt und ausgewählt|Created and selected):\s*A004/u.test(message.content)),
  'OpenClaw created and selected the project for this conversation');
assert.ok(toolMessages.some((message) => /Projektkontext aktiv/u.test(message.content) &&
  /A004/u.test(message.content) && !/(?:Erstellt und ausgewählt|Created and selected):\s*A004/u.test(message.content)),
  'project status returned its visible card between independent Gateway calls');
assert.equal(calls.at(-1).marker_present, true, 'selected project context reached the next Gateway turn');
const select = readFileSync(process.argv[3], 'utf8');
const context = readFileSync(process.argv[4], 'utf8');
assert.match(select, /A004/u, 'project creation returned its allocated code');
assert.match(context, /PROJECT_CONTEXT_OK/u, 'model observed the automatically injected project marker');
console.log('OpenClaw Gateway smoke passed: project tool executed, project status returned its card, and selected context loaded on the next turn.');
NODE
