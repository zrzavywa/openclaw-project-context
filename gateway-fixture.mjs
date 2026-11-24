import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [root, pluginDir, portText = '19349'] = process.argv.slice(2);
if (!root || !pluginDir) throw new Error('Usage: node gateway-fixture.mjs ROOT PLUGIN_DIR [PORT]');
const port = Number(portText);
const mainWorkspace = path.join(root, 'workspace-main');
const privateWorkspace = path.join(root, 'workspace-privat');
const workWorkspace = path.join(root, 'workspace-work');
const projectRoot = path.join(mainWorkspace, 'projects', 'local-00000000-0000-4000-8000-000000000003');
for (const dir of [root, mainWorkspace, privateWorkspace, workWorkspace,
  path.join(mainWorkspace, 'projects'), projectRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(path.join(projectRoot, 'REFERENZ.md'), '# A003 – Synthetic Project Context\n\nAnzeigename: A003 – Synthetic Project Context\n\n| Status | WORKSPACE_READY |\n| OpenClaw-Agent | main |\n', { mode: 0o600 });
writeFileSync(path.join(projectRoot, 'KONTEXT.md'), '# A003 – Synthetic Project Context\n\nAWF_PROJECT_AUTO_CONTEXT_CHECK\n', { mode: 0o600 });

const config = {
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'none' } },
  tools: { profile: 'full', allow: ['awf_project'] },
  agents: {
    ownership: 'explicit',
    defaults: { workspace: mainWorkspace, model: { primary: 'g45stub/g45model' } },
    entries: {
      main: { workspace: mainWorkspace, tools: { alsoAllow: ['awf_project'] } },
      privat: { workspace: privateWorkspace },
      'beruflich-work': { workspace: workWorkspace },
    },
  },
  models: { mode: 'merge', providers: { g45stub: {
    baseUrl: 'http://127.0.0.1:19346/v1', apiKey: 'synthetic-only', api: 'openai-completions',
    models: [{ id: 'g45model', name: 'Project Context synthetic test', contextWindow: 32768, maxTokens: 128 }],
  } } },
  plugins: {
    allow: ['awf-project-context'],
    load: { paths: [pluginDir] },
    entries: { 'awf-project-context': {
      enabled: true,
      hooks: { allowConversationAccess: true, allowPromptInjection: true },
      config: { enabled: true },
    } },
  },
};
writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ mainWorkspace, projectRoot, gatewayPort: port }));
