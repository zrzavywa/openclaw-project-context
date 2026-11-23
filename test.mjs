import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import register, { prepareWorkspaceProjectCommands } from './index.mjs';
import { resultOk } from './project-commands.mjs';
import { abandonProjectDisplayId, createProjectWorkspace, allocationUtilizationWarning, resolveAgentBaseline, deriveAgentBaseline } from './project-creation.mjs';
import { validateProjectAgentConfig } from './project-config.mjs';
import { inspectProjectHistory, quarantineProjectDirectory } from './project-lifecycle.mjs';
import { readProjectMemoryRecords, saveApprovedProjectMemory } from './project-memory.mjs';
import { computeReleaseManifest, inspectReleaseDirectory, verifyReleaseManifest, writeReleaseManifest } from './project-release.mjs';
import { replaceProjectSnapshotAtomically } from './project-memory.mjs';
import { formatCaptureDiff, PLUGIN_ROOT } from './project-helpers.mjs';

const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awf-project-context-')));
const workspaces = {
  main: path.join(tempRoot, 'workspace-main'),
  privat: path.join(tempRoot, 'workspace-privat'),
  'beruflich-work': path.join(tempRoot, 'workspace-work'),
  research: path.join(tempRoot, 'workspace-research'),
};
for (const root of Object.values(workspaces)) mkdirSync(root, { mode: 0o700 });

function store() {
  const values = new Map();
  return {
    async lookup(key) { return values.get(key); },
    async observe(key) { return { value: values.get(key), comparison: values.get(key) }; },
    async registerIfAbsent(key, value) { if (!values.has(key)) values.set(key, value); },
    async compareAndApply(key, comparison, mutation) {
      if (values.get(key) !== comparison) return { status: 'conflict' };
      if (mutation.action === 'set') values.set(key, mutation.value);
      else if (mutation.action === 'delete') values.delete(key);
      return { status: 'applied' };
    },
  };
}

const selections = store();
const allocations = store();
const reviews = store();
const repairs = store();
const transfers = store();
const projectConfigs = store();
let currentTime = new Date('2026-11-19T20:00:00.000Z');
const commands = prepareWorkspaceProjectCommands({
  selectionStore: selections,
  selectionStoreForCommand: () => selections,
  allocationStoreForCommand: () => allocations,
  reviewStore: reviews,
  reviewStoreForCommand: () => reviews,
  repairStoreForCommand: () => repairs,
  transferStoreForCommand: () => transfers,
  projectConfigStore: projectConfigs,
  projectConfigStoreForCommand: () => projectConfigs,
  resolveWorkspaceDir: (_config, agentId) => workspaces[agentId],
  now: () => new Date(currentTime),
});

function commandContext(agentId, sessionKey, sessionId) {
  return { agentId, sessionKey, sessionId, workspaceDir: workspaces[agentId], config: {},
    senderIsOwner: true, assertOwnerCurrent() {} };
}

try {
  const main = commandContext('main', 'channel:main:thread-1', 'session-1');
  const legacyProjectRoot = path.join(workspaces.main, 'projects', 'existing-awf-project-profile');
  mkdirSync(legacyProjectRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(legacyProjectRoot, 'REFERENZ.md'), '# A001 – Existing Project\n\nExisting workspace format.\n', { mode: 0o600 });
  const initialLegacyList = await commands.listProjects(main);
  assert.match(initialLegacyList.text, /A001 — A001 – Existing Project/u, initialLegacyList.text,
    'existing code-named project folders remain discoverable');
  assert.match((await commands.selectProject(main, 'A001')).text, /für dieses Gespräch ausgewählt/u,
    'existing code-named projects can be selected');
  assert.match((await commands.hook({}, main)).prependContext, /A001 – Existing Project/u,
    'existing project reference loads when no optional context file exists');
  assert.match((await commands.clearProject(main)).text, /gelöst/u);

  const created = await commands.createProject(main, 'Integration Pilot');
  assert.match(created.text, /Erstellt und ausgewählt: A004/u);
  assert.deepEqual(deriveAgentBaseline('research'), { prefix: 'R', highWater: 0, domain: 'research' },
    'an unknown agent gets a derived baseline');
  assert.deepEqual(resolveAgentBaseline('research'), { prefix: 'R', highWater: 0, domain: 'research' },
    'the resolver falls back to the derived baseline');
  const researchCtx = commandContext('research', 'channel:research:thread-1', 'research-session-1');
  const researchCreate = await commands.createProject(researchCtx, 'Portable Agent Pilot');
  assert.match(researchCreate.text, /Erstellt und ausgewählt: R001/u,
    'a fourth, unconfigured agent can create a project with a derived prefix');
  assert.match((await commands.listProjects(researchCtx)).text, /R001 — R001 – Portable Agent Pilot/u,
    'the derived agent lists its own project');
  assert.match((await commands.configureProject(researchCtx, 'show')).text, /Aktives Code-Modell: RXXX/u,
    'the derived agent gets a default code model');
  assert.match((await commands.selectProject(researchCtx, 'R001')).text, /für dieses Gespräch ausgewählt/u,
    'the derived agent can select its project');
  assert.match((await commands.listProjects(main)).text, /A004/u,
    'the original agent is unaffected by the derived agent');
  const researchDoctor = JSON.parse((await commands.doctor(researchCtx, 'json')).text);
  assert.ok(researchDoctor.findings.some((row) => row.code === 'agent-baseline-derived'),
    'doctor warns when an agent runs on a derived baseline');
  const mainDoctor = JSON.parse((await commands.doctor(main, 'json')).text);
  assert.ok(!mainDoctor.findings.some((row) => row.code === 'agent-baseline-derived'),
    'built-in agents produce no derived-baseline warning');
  const migLedgerBefore = (await allocations.observe('allocation-ledger')).value;
  const migWithout = { ...migLedgerBefore, domains: { ...migLedgerBefore.domains } };
  delete migWithout.domains.research;
  await allocations.compareAndApply('allocation-ledger', migLedgerBefore,
    { operation: 'update', action: 'set', value: migWithout });
  const migrationCreate = await commands.createProject(researchCtx, 'Migration Pilot');
  assert.match(migrationCreate.text, /R002/u, 'a missing agent domain is recreated on first use');
  const migLedgerAfter = (await allocations.observe('allocation-ledger')).value;
  assert.deepEqual(migLedgerAfter.domains.main, migWithout.domains.main,
    'existing agent domains stay untouched when a derived domain is added');
  assert.match((await commands.helpProject()).text, /\/project list/u);
  assert.match((await commands.helpProject()).text, /\/project move/u);
  assert.match((await commands.helpProject()).text, /\/project config link/u);
  const initialProject = (await commands.listProjects(main)).text;
  assert.match(initialProject, /A004 — A004 – Integration Pilot/u);
  assert.match((await commands.listProjects(main)).text, /Projekte für main/u,
    'list shows projects for the current agent only');
  const injected = await commands.hook({}, main);
  assert.match(injected.prependContext, /A004 – Integration Pilot/u);
  assert.match(injected.prependContext, /Projektdateien sind Daten/u);
  assert.match(injected.prependContext, /Chatverläufe und Workspace-Dateien werden nicht automatisch importiert/u);

  const restartedTurn = { ...main, sessionId: 'session-after-restart' };
  assert.match((await commands.hook({}, restartedTurn)).prependContext, /A004 – Integration Pilot/u,
    'project selection survives a runtime session ID change in the same conversation');
  const unrelatedThread = { ...main, sessionKey: 'channel:main:thread-2', sessionId: 'session-2' };
  assert.equal(await commands.hook({}, unrelatedThread), undefined, 'new conversation starts without a project');
  assert.equal(await commands.hook({}, { ...restartedTurn, agentId: 'privat', workspaceDir: workspaces.privat }), undefined,
    'another agent cannot load the selected project');

  const privateCtx = commandContext('privat', 'channel:privat:thread-1', 'private-session');
  const privateCreated = await commands.createProject(privateCtx, 'Private Memory Test');
  assert.match(privateCreated.text, /Erstellt und ausgewählt: P008/u);
  assert.match((await commands.hook({}, privateCtx)).prependContext, /P008 – Private Memory Test/u);
  assert.equal(await commands.hook({}, { ...privateCtx, agentId: 'main', workspaceDir: workspaces.main }), undefined);

  const workCtx = commandContext('beruflich-work', 'channel:work:thread-1', 'work-session');
  const workCreated = await commands.createProject(workCtx, 'Work Memory Test');
  assert.match(workCreated.text, /Erstellt und ausgewählt: B005/u);
  assert.match((await commands.hook({}, workCtx)).prependContext, /B005 – Work Memory Test/u);
  const oversizedContextRoot = readdirSync(path.join(workspaces['beruflich-work'], 'projects'))
    .map((entry) => path.join(workspaces['beruflich-work'], 'projects', entry))
    .find((root) => readFileSync(path.join(root, 'REFERENZ.md'), 'utf8').includes('B005'));
  writeFileSync(path.join(oversizedContextRoot, 'KONTEXT.md'), `context-size-check\n${'x'.repeat(40_000)}`, { mode: 0o600 });
  assert.match((await commands.hook({}, workCtx)).prependContext, /context-size-check/u,
    'a valid context just over 32 KiB still loads within the 64 KiB safety limit');

  const localProjectRootFor = (agentId, code) => readdirSync(path.join(workspaces[agentId], 'projects'))
    .map((entry) => path.join(workspaces[agentId], 'projects', entry))
    .find((root) => readFileSync(path.join(root, 'REFERENZ.md'), 'utf8').includes(code));
  const externalCodexRoot = path.join(tempRoot, 'codex-checkout-rfp-support');
  mkdirSync(externalCodexRoot, { mode: 0o700 });
  const linkResult = await commands.configureProjectCodexLink(main, 'link', 'A004', externalCodexRoot);
  assert.match(linkResult.text, /Codex-Arbeitsordner mit A004 verknüpft/u);
  assert.ok((await commands.configureProject(main, 'show')).text.includes(`A004 → ${externalCodexRoot}`),
    'per-agent configuration shows each project-specific Codex root');
  assert.match((await commands.configureProjectCodexLink(main, 'link', 'A001', externalCodexRoot)).text,
    /bereits mit A004 verknüpft/u, 'a Codex root cannot ambiguously map to two projects in one agent');
  const codexLinkPath = path.join(localProjectRootFor('main', 'A004'), '.awf-codex-link.json');
  const codexLinkInfo = lstatSync(codexLinkPath);
  assert.ok(codexLinkInfo.isFile() && !codexLinkInfo.isSymbolicLink() && (codexLinkInfo.mode & 0o077) === 0,
    'per-project Codex link metadata is owner-only and cannot be a symlink');
  const invalidCodexRoot = path.join(tempRoot, 'codex-root-symlink');
  symlinkSync(externalCodexRoot, invalidCodexRoot);
  assert.match((await commands.configureProjectCodexLink(main, 'link', 'A004', invalidCodexRoot)).text,
    /kanonisches Verzeichnis im Eigentum/u, 'Codex links reject symbolic or non-canonical roots');
  const uiSelectedExisting = { ...main, sessionKey: 'channel:main:codex-selected-existing', workspaceDir: externalCodexRoot };
  assert.match((await commands.hook({}, uiSelectedExisting)).prependContext, /A004 – Integration Pilot/u,
    'an exact Codex workspace match automatically loads only the current agent project');
  assert.match((await commands.hook({}, uiSelectedExisting)).prependContext, /Projektkontext/u);
  assert.match((await commands.projectStatus(uiSelectedExisting)).text, /A004 – Integration Pilot/u,
    'project status reflects a context loaded from the Codex workspace');
  assert.ok((await commands.selectProject(main, 'A004')).text.includes(externalCodexRoot),
    'selecting an OpenClaw project shows its linked Codex root for the reverse navigation');
  assert.match((await commands.clearProject(uiSelectedExisting)).text, /Projektkontext für dieses Gespräch gelöst/u);
  assert.equal(await commands.hook({}, uiSelectedExisting), undefined,
    'an explicit clear suppresses automatic Codex linking for the rest of that conversation');
  const mismatchedUiRoot = { ...uiSelectedExisting, sessionKey: 'channel:main:codex-mismatch', workspaceDir: workspaces.privat };
  assert.equal(await commands.hook({}, mismatchedUiRoot), undefined,
    'a Codex workspace belonging to another agent cannot trigger the current agent project');
  assert.match(allocationUtilizationWarning('A003', { highWater: 3 }), /Hinweis: 3 von 3/u,
    'code allocation warns at ninety percent utilization');
  assert.equal(allocationUtilizationWarning('A001', { highWater: 3 }), '', 'low utilization stays silent');
  assert.equal(allocationUtilizationWarning('A005', { highWater: 10 }), '', 'utilization below ninety percent stays silent');
  assert.match(allocationUtilizationWarning('A009', { highWater: 10 }), /Hinweis: 9 von 10/u,
    'exactly ninety percent already warns');
  assert.deepEqual(resolveAgentBaseline('main', { baseline: { prefix: 'C', highWater: 12, domain: 'synthetic' } }),
    { prefix: 'C', highWater: 12, domain: 'synthetic' }, 'a configured baseline overrides the built-in default');
  assert.deepEqual(resolveAgentBaseline('main', {}), { prefix: 'A', highWater: 3, domain: 'agent' },
    'without configuration the built-in baseline applies');
  assert.throws(() => validateProjectAgentConfig({
    schema: 'awf.project-agent-config.v1', agentId: 'main', workspacePath: workspaces.main,
    generation: 0, models: [{ model: 'AXXX', active: true }], locations: ['projects'], currentLocation: 'projects',
    baseline: { prefix: 'XY', highWater: 3, domain: 'x' } }, 'main', workspaces.main), /Baseline/u,
    'an invalid baseline prefix is rejected');
  assert.match((await commands.configureProjectCodexLink(main, 'unlink', 'A004')).text, /Codex-Verknüpfung von A004 entfernt/u);
  const afterUnlink = { ...uiSelectedExisting, sessionKey: 'channel:main:codex-after-unlink' };
  assert.equal(await commands.hook({}, afterUnlink), undefined, 'unlinking disables Codex root auto-selection');

  assert.match((await commands.selectProject(main, 'A004')).text, /für dieses Gespräch ausgewählt/u);

  const activeStatus = await commands.projectStatus(main);
  assert.match(activeStatus.text, /Projektkontext aktiv/u);
  assert.match(activeStatus.text, /A004/u);
  assert.match(activeStatus.text, /aktuelles Gespräch/u);

  const doctorBefore = await commands.doctor(main);
  assert.match(doctorBefore.text, /Projekt-Doctor/u);
  assert.match(doctorBefore.text, /Nur-Lese-Prüfung/u);
  assert.match((await commands.changeProjectStatus(main, 'A004', 'archived')).text, /archived/u);
  assert.equal(await commands.hook({}, main), undefined, 'archived project context stops loading');
  assert.doesNotMatch((await commands.listProjects(main)).text, /A004/u, 'archived project is hidden from active list');
  assert.match((await commands.listArchivedProjects(main)).text, /A004/u);
  assert.match((await commands.changeProjectStatus(main, 'A004', 'active')).text, /restored/u);
  assert.match((await commands.selectProject(main, 'A004')).text, /für dieses Gespräch ausgewählt/u);
  assert.match((await commands.changeProjectStatus(main, 'A004', 'trash')).text, /recoverable/u);
  assert.equal(await commands.hook({}, main), undefined, 'trashed project context stops loading');
  assert.match((await commands.changeProjectStatus(main, 'A004', 'active')).text, /restored/u,
    'trash can be restored without deleting project files');
  assert.match((await commands.selectProject(main, 'A004')).text, /für dieses Gespräch ausgewählt/u);

  const mainProjectId = readdirSync(path.join(workspaces.main, 'projects')).find((id) => id.startsWith('local-') && readFileSync(path.join(workspaces.main, 'projects', id, 'REFERENZ.md'), 'utf8').includes('A004'));
  const mainProject = path.join(workspaces.main, 'projects', mainProjectId);
  const contextPath = path.join(mainProject, 'KONTEXT.md');
  let original = readFileSync(contextPath);

  const mergeSource = await commands.createProject(main, 'Merge Source Test');
  assert.match(mergeSource.text, /A005/u);
  assert.match((await commands.previewTransfer(main, 'merge', 'A005', 'A004')).text, /Merge-Vorschau – nicht angewendet/u);
  assert.match((await commands.confirmTransfer(main)).text, /A005 in A004 gemergt/u);
  assert.doesNotMatch((await commands.listProjects(main)).text, /A005/u, 'merged source is archived');
  assert.match(readFileSync(contextPath, 'utf8'), /Übernommen aus A005/u, 'merge content is appended to target project context');
  original = readFileSync(contextPath);
  await commands.selectProject(main, 'A004');

  assert.match((await commands.previewTransfer(privateCtx, 'move', 'P008', undefined, 'beruflich-work')).text,
    /Move-Vorschau – nicht angewendet/u);
  assert.match((await commands.confirmTransfer(privateCtx)).text, /P008 nach beruflich-work als B006 verschoben/u);
  assert.doesNotMatch((await commands.listProjects(privateCtx)).text, /P008/u, 'moved source is archived in the source domain');
  assert.match((await commands.listProjects(workCtx)).text, /B006/u, 'move creates a new code in destination domain');

  chmodSync(path.join(workspaces.main, 'projects'), 0o755);
  assert.match((await commands.repairProject(main, false)).text, /Reparatur-Vorschau – nicht angewendet/u);
  assert.match((await commands.repairProject(main, true)).text, /2 sichere Reparatur/u);
  assert.equal((await commands.doctor(main)).text.includes('Warnungen: 0'), true,
    'doctor confirms the safe permission repair');

  const captureDraft = await commands.proposeSummary(main, '## Aktueller Stand\n- Ziel: Projektkontext sicherstellen.\n\n## Neue Beschlüsse dieses Gesprächs\n- Nur freigegebene Projektdateien laden.');
  assert.match(captureDraft.text, /Vorschau – noch nicht gespeichert/u);
  assert.match(captureDraft.text, /\/project capture confirm/u);
  assert.deepEqual(readFileSync(contextPath), original, 'preview does not write project files');
  assert.match((await commands.confirmSummary({ ...main, senderIsOwner: false })).text,
    /authentifizierten Owner-Befehl/u, 'non-owner cannot confirm a draft');
  assert.deepEqual(readFileSync(contextPath), original, 'rejected confirmation leaves project files unchanged');
  assert.match((await commands.confirmSummary(main)).text, /freigegebene Zusammenfassung wurde der Historie hinzugefügt/u);
  const afterCapture = readFileSync(contextPath, 'utf8');
  assert.match(afterCapture, /> - Ziel: Projektkontext sicherstellen/u);
  assert.match(afterCapture, /> - Nur freigegebene Projektdateien laden/u);
  assert.match((await commands.confirmSummary(main)).text, /Keine aktuelle Projektzusammenfassung/u,
    'a confirmed review cannot be appended a second time');
  assert.equal((readFileSync(contextPath, 'utf8').match(/Capture:/gu) ?? []).length, 1,
    'the current snapshot contains one capture marker');
  assert.equal(readdirSync(path.join(mainProject, 'history', 'captures')).length, 2,
    'merge and capture each create an immutable history record');
  assert.equal(readdirSync(path.join(mainProject, 'history', 'decisions')).length, 1,
    'newly approved decisions are stored separately');

  const cancelDraft = await commands.proposeSummary(main, 'This draft must be discarded.');
  assert.match(cancelDraft.text, /Vorschau/u);
  assert.match((await commands.cancelSummary(main)).text, /verworfen/u);
  assert.equal(readFileSync(contextPath, 'utf8').includes('This draft must be discarded'), false,
    'cancel discards a draft without writing project files');

  await commands.proposeSummary(main, 'Expired summary.');
  currentTime = new Date(currentTime.getTime() + 15 * 60 * 1000 + 1);
  assert.match((await commands.confirmSummary(main)).text, /Keine aktuelle Projektzusammenfassung/u,
    'expired drafts cannot be confirmed');
  assert.equal(readFileSync(contextPath, 'utf8').includes('Expired summary.'), false);
  currentTime = new Date('2026-11-19T20:00:00.000Z');

  await commands.proposeSummary(main, 'Project finished; remaining work transferred. The next project owner is identified.', 'close');
  assert.match((await commands.confirmSummary(main)).text, /für dieses Gespräch geschlossen/u);
  assert.equal(await commands.hook({}, main), undefined, 'confirmed closeout clears the active project selection');
  assert.match((await commands.projectStatus(main)).text, /Kein Projekt aktiv/u);

  assert.match((await commands.clearProject(main)).text, /kein Projekt ausgewählt/u,
    'confirmed closeout has already cleared the active selection');
  assert.equal(await commands.hook({}, main), undefined, 'cleared selection stops context injection');

  rmSync(contextPath);
  symlinkSync(path.join(workspaces.privat, 'projects', 'missing-private-file'), contextPath);
  assert.equal(await commands.hook({}, restartedTurn), undefined, 'symlink context source is denied');
  rmSync(contextPath);
  writeFileSync(contextPath, original, { mode: 0o600 });

  assert.match((await commands.createProject({ ...main, senderIsOwner: false }, 'Denied Project')).text,
    /authentifizierten Owner-Befehl/u, 'unauthenticated project creation is denied');

  const toolWorkspace = path.join(tempRoot, 'tool-workspace-main');
  mkdirSync(toolWorkspace, { mode: 0o700 });
  const toolInvocationWorkspace = path.join(tempRoot, 'codex-project-worktree');
  mkdirSync(toolInvocationWorkspace, { mode: 0o700 });
  const toolSelections = store();
  const toolAllocations = store();
  let registeredFactory;
  let registeredCommand;
  let promptHook;
  const toolApi = {
    pluginConfig: { enabled: true },
    runtime: {
      config: { current() { return {}; } },
      state: { openKeyedStoreV2(options) { return options.namespace.includes('selection') ? toolSelections : toolAllocations; } },
      agent: { resolveAgentWorkspaceDir(_config, agentId) { return agentId === 'main' ? toolWorkspace : workspaces[agentId]; } },
    },
    on(name, handler) { if (name === 'before_prompt_build') promptHook = handler; },
    registerTool(factory, options) { registeredFactory = { factory, options }; },
    registerCommand(command) { registeredCommand = command; },
  };
  register(toolApi);
  assert.equal(registeredFactory.options.name, 'awf_project');
  assert.equal(registeredFactory.options.workspaceAccess, true);
  assert.equal(registeredCommand.name, 'project');
  const toolContext = {
    senderIsOwner: true,
    agentId: 'main',
    sessionKey: 'controlui:thread-tool',
    sessionId: 'tool-session-1',
    workspaceDir: toolInvocationWorkspace,
    config: {},
    memoryAudience: { kind: 'conversation', agentId: 'main', sessionKey: 'controlui:thread-tool', sessionId: 'tool-session-1' },
    assertInvocationCurrent() {},
    assertMemoryAudienceCurrent() {},
  };
  const agentTool = registeredFactory.factory.create(toolContext);
  assert.ok(agentTool, 'owner request gets the project tool');
  assert.equal(registeredFactory.factory.create({ ...toolContext, senderIsOwner: false }), null,
    'non-owner request does not get the project tool');
  const toolResult = await agentTool.execute('tool-call-1', { action: 'create', name: 'Natural Request Pilot' });
  assert.match(toolResult.content[0].text, /Erstellt und ausgewählt: A004/u);
  assert.equal(toolResult.details.ok, true, 'a successful create reports ok:true despite the German text');
  const duplicateCreate = await agentTool.execute('tool-call-duplicate', { action: 'create', name: 'Natural Request Pilot' });
  assert.equal(duplicateCreate.details.ok, false, 'a blocked duplicate create reports ok:false');
  assert.match(duplicateCreate.content[0].text, /blockiert/u, 'the blocked create keeps its German explanation');
  assert.equal(resultOk('Erstellt und ausgewählt: A004 – Example'), true, 'success text maps to ok');
  assert.equal(resultOk('Projektanlage blockiert: Ein Projekt mit diesem Namen existiert bereits.'), false,
    'blocked create text maps to not-ok');
  assert.equal(resultOk('Doctor konnte diesen Workspace nicht sicher prüfen: kaputt'), false, 'doctor failure maps to not-ok');
  assert.equal(resultOk('**Vorschau – noch nicht gespeichert**'), true, 'a capture preview is a normal result');
  assert.match((await promptHook({}, toolContext)).prependContext, /A004 – Natural Request Pilot/u,
    'agent-callable tool creates and activates context in the same conversation');
  const configToolResult = await agentTool.execute('tool-config', { action: 'config', setting: 'show' });
  assert.match(configToolResult.content[0].text, /Aktives Code-Modell: AXXX/u);
  const helpCommandResult = await registeredCommand.handler({ agentId: 'main', sessionKey: 'controlui:slash-help',
    workspaceDir: toolInvocationWorkspace, config: {}, senderIsOwner: true, assertOwnerCurrent() {}, args: 'help' });
  assert.match(helpCommandResult.text, /\/project config show/u, 'help slash command lists configuration commands');
  const listCommandResult = await registeredCommand.handler({ agentId: 'main', sessionKey: 'controlui:slash-list',
    workspaceDir: toolInvocationWorkspace, config: {}, senderIsOwner: true, assertOwnerCurrent() {}, args: 'list' });
  assert.match(listCommandResult.text, /A004 — A004 – Natural Request Pilot/u,
    'slash-command listing uses the agent workspace instead of a Codex project checkout');
  assert.match((await commands.helpProject()).text, /OpenClaw-Projektbefehle\*\* \(Plugin 0\./u,
    'help shows the loaded plugin version');
  assert.match((await commands.helpProject()).text, /set baseline/u, 'help lists the baseline command');
  assert.match((await commands.configureProject(main, 'show')).text, /Aktives Code-Modell: AXXX/u);
  assert.match((await commands.configureProject(privateCtx, 'show')).text, /Aktives Code-Modell: PXXX/u,
    'agent project configuration is isolated by agent');
  assert.match((await commands.configureProject(main, 'set-baseline', 'A 2 agent')).text,
    /liegt unter dem hoechsten bereits vergebenen Code A0[0-9][0-9]/u, 'lowering below a reserved code is refused');
  assert.match((await commands.configureProject(main, 'set-baseline', 'XY 5 agent')).text, /Praefix/u,
    'an invalid baseline prefix is refused');
  assert.match((await commands.configureProject(main, 'set-baseline', 'A 12 agent')).text, /Code-Baseline fuer main gesetzt/u,
    'raising the high-water mark is allowed');
  assert.match((await commands.configureProject(main, 'show')).text, /Code-Baseline: A \/ 12 \/ agent/u,
    'the configured baseline is shown');
  assert.match((await commands.configureProject(main, 'set-baseline', 'C 12 agent')).text, /Code-Baseline fuer main gesetzt/u,
    'an unclaimed prefix is accepted');
  assert.match((await commands.configureProject(privateCtx, 'set-baseline', 'C 8 privat')).text,
    /gehoert bereits Agent main/u, 'a prefix claimed by another agent is refused');
  assert.match((await commands.configureProject(privateCtx, 'set-baseline', 'B 8 privat')).text,
    /gehoert bereits Agent beruflich-work/u, 'seeded default prefixes are protected too');
  assert.match((await commands.configureProject(privateCtx, 'set-baseline', 'P 20 privat')).text,
    /Code-Baseline fuer privat gesetzt/u, 'an agent keeps its own prefix');
  assert.match((await commands.configureProject(main, 'set-model', 'BXXYY')).text, /Aktives Modell: BXXYY/u);
  const bModelCreated = await commands.createProject(main, 'Four Digit Code Model');
  assert.match(bModelCreated.text, /B0001/u, 'model digit placeholders allocate the configured width');
  assert.match((await commands.listProjects(main)).text, /A004/u, 'legacy A code remains visible after model change');
  assert.match((await commands.configureProject(main, 'rename-prefix', 'BXXYY', 'QXXX')).text, /Aktives Modell: QXXX/u);
  assert.match((await commands.createProject(main, 'Renamed Prefix Project')).text, /Q001/u);
  assert.match((await commands.configureProject(main, 'delete-prefix', 'QXXX')).text, /Aktives Modell: none/u);
  assert.match((await commands.createProject(main, 'Blocked Without Prefix')).text, /kein aktives Projekt-Codemodell/u);
  await commands.configureProject(main, 'set-model', 'QXXX');
  assert.match((await commands.configureProject(main, 'set-location', 'projects-alt')).text, /Bestehende Projekte bleiben, wo sie sind/u);
  const alternateLocation = await commands.createProject(main, 'Alternate Location Project');
  assert.match(alternateLocation.text, /Erstellt und ausgewählt: Q002/u, alternateLocation.text);
  assert.match(alternateLocation.text, /projects-alt/u, 'location affects new projects only');
  assert.match((await commands.listProjects(main)).text, /A004/u, 'old location projects remain visible');
  const alternateContext = await commands.hook({}, main);
  assert.ok(alternateContext, (await commands.projectStatus(main)).text);
  assert.match(alternateContext.prependContext, /Alternate Location Project/u,
    'project context resolves from the newly configured location');
  assert.match((await commands.selectProject(main, 'A004')).text, /für dieses Gespräch ausgewählt/u,
    'old location projects remain selectable');
  // --- release integrity manifest ---------------------------------------
  const releaseRoot = path.join(tempRoot, 'release-fixture');
  mkdirSync(releaseRoot, { mode: 0o700 });
  writeFileSync(path.join(releaseRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', files: ['a.mjs', 'release.json'] }), { mode: 0o600 });
  writeFileSync(path.join(releaseRoot, 'a.mjs'), 'export const value = 1;\n', { mode: 0o600 });
  const manifest = computeReleaseManifest(releaseRoot);
  assert.deepEqual(manifest.files.map((row) => row.path), ['a.mjs', 'package.json'],
    'release manifest covers package.json and the declared files, not itself');
  assert.equal(verifyReleaseManifest(releaseRoot, manifest).status, 'PASS');
  writeFileSync(path.join(releaseRoot, 'a.mjs'), 'export const value = 2;\n', { mode: 0o600 });
  const tampered = verifyReleaseManifest(releaseRoot, manifest);
  assert.equal(tampered.status, 'MISMATCH');
  assert.ok(tampered.findings.some((row) => row.code === 'release-hash-mismatch'), 'content drift is detected');
  writeFileSync(path.join(releaseRoot, 'a.mjs'), 'export const value = 1;\n', { mode: 0o600 });
  const withExtra = { ...manifest, files: [...manifest.files,
    { path: 'extra.mjs', bytes: 1, sha256: '0'.repeat(64) }] };
  assert.ok(verifyReleaseManifest(releaseRoot, withExtra).findings
    .some((row) => row.code === 'release-file-unexpected'), 'manifest entries outside package.json are reported');
  const incomplete = { ...manifest, files: manifest.files.filter((row) => row.path !== 'a.mjs') };
  assert.ok(verifyReleaseManifest(releaseRoot, incomplete).findings
    .some((row) => row.code === 'release-file-missing'), 'declared files missing from the manifest are reported');
  const writtenManifest = writeReleaseManifest(releaseRoot);
  assert.equal(verifyReleaseManifest(releaseRoot, writtenManifest).status, 'PASS');
  assert.ok(verifyReleaseManifest(releaseRoot, { ...manifest, version: '9.9.9' }).findings
    .some((row) => row.code === 'release-version-mismatch'), 'version drift is reported');
  const missingRoot = path.join(tempRoot, 'release-missing-fixture');
  mkdirSync(missingRoot, { mode: 0o700 });
  writeFileSync(path.join(missingRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }), { mode: 0o600 });
  const missingRelease = inspectReleaseDirectory(missingRoot);
  assert.equal(missingRelease.status, 'MISSING');
  assert.ok(missingRelease.findings.some((row) => row.code === 'release-manifest-missing'));
  assert.equal(inspectReleaseDirectory(releaseRoot).status, 'PASS', 'a written manifest verifies against its directory');

  // --- snapshot replace re-hashes immediately before rename --------------
  const snapshotRoot = path.join(tempRoot, 'snapshot-fixture');
  mkdirSync(snapshotRoot, { mode: 0o700 });
  const snapshotPath = path.join(snapshotRoot, 'KONTEXT.md');
  writeFileSync(snapshotPath, 'first\n', { mode: 0o600 });
  const staleDigest = createHash('sha256').update(Buffer.from('0', 'utf8')).digest('hex');
  assert.throws(() => replaceProjectSnapshotAtomically(snapshotPath, snapshotRoot,
    lstatSync(snapshotRoot).uid, Buffer.from('second\n', 'utf8'), staleDigest), /vor dem Ersetzen geändert/u,
    'a stale digest blocks the replacement');
  assert.equal(readFileSync(snapshotPath, 'utf8'), 'first\n', 'the previous snapshot survives a stale digest');
  const currentDigest = createHash('sha256').update(Buffer.from('first\n', 'utf8')).digest('hex');
  replaceProjectSnapshotAtomically(snapshotPath, snapshotRoot, lstatSync(snapshotRoot).uid,
    Buffer.from('second\n', 'utf8'), currentDigest);
  assert.equal(readFileSync(snapshotPath, 'utf8'), 'second\n', 'a matching digest allows the replacement');

  // --- creation rollback and abandoned reservation -----------------------
  const altProjectsRoot = path.join(workspaces.main, 'projects-alt');
  const cleanupProjectId = 'local-00000000-0000-4000-8000-000000000000';
  const cleanupReservation = { displayId: 'Q999', projectId: cleanupProjectId, agentId: 'main',
    domain: 'agent', displayName: 'Q999 – Cleanup Fixture', status: 'reserved', reservedAt: currentTime.toISOString() };
  let writeCalls = 0;
  assert.throws(() => createProjectWorkspace({ workspaceRoot: workspaces.main, projectsRoot: altProjectsRoot,
    reservation: cleanupReservation, writeFile: (filePath, contents) => {
      writeCalls += 1;
      if (writeCalls === 2) throw new Error('synthetic write failure');
      writeFileSync(filePath, contents, { mode: 0o600 });
    } }), /synthetic write failure/u);
  assert.equal(writeCalls, 2);
  assert.equal(readdirSync(altProjectsRoot).includes(cleanupProjectId), false,
    'a partially created project directory is removed');
  const ledgerBefore = (await allocations.observe('allocation-ledger')).value;
  const pendingReservation = ledgerBefore.domains.main.reservations.at(-1);
  const abandoned = await abandonProjectDisplayId({ store: allocations, agentId: 'main',
    projectId: pendingReservation.projectId, displayId: pendingReservation.displayId, assertCurrent: () => {} });
  assert.equal(abandoned.status, 'abandoned');
  const ledgerAfter = (await allocations.observe('allocation-ledger')).value;
  assert.equal(ledgerAfter.domains.main.reservations.at(-1).status, 'abandoned',
    'an unused reservation can be marked abandoned without reusing the code');
  assert.equal(ledgerAfter.domains.main.highWater, ledgerBefore.domains.main.highWater,
    'abandoning a reservation never recycles its number');

  // --- lifecycle audit log ----------------------------------------------
  const lifecycleCreated = await commands.createProject(main, 'Lifecycle Fixture');
  const lifecycleCode = /Erstellt und ausgewählt: ([A-Z][0-9]+)/u.exec(lifecycleCreated.text)[1];
  const lifecycleRoot = readdirSync(altProjectsRoot)
    .map((entry) => path.join(altProjectsRoot, entry))
    .find((root) => readFileSync(path.join(root, 'REFERENZ.md'), 'utf8').includes(lifecycleCode));
  assert.ok(lifecycleRoot, 'lifecycle fixture project was created');
  await commands.changeProjectStatus(main, lifecycleCode, 'archived');
  await commands.changeProjectStatus(main, lifecycleCode, 'active');
  const lifecycleLog = readFileSync(path.join(lifecycleRoot, 'history', 'lifecycle.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lifecycleLog.map((row) => [row.from, row.to]), [['active', 'archived'], ['archived', 'active']],
    'status changes are appended to the lifecycle log');
  assert.deepEqual(lifecycleLog.map((row) => row.generation), [1, 2]);
  assert.equal(lifecycleLog[1].projectId, path.basename(lifecycleRoot));
  const doctorAfterLifecycle = (await commands.doctor(main)).text;
  assert.match(doctorAfterLifecycle, /Release: .*integrity: (PASS|MISMATCH|MISSING|INVALID|VERSION_DRIFT)/u,
    'doctor reports the plugin release integrity state separately');
  assert.doesNotMatch(doctorAfterLifecycle, new RegExp(`lifecycle-log-stale \\[${path.basename(lifecycleRoot)}\\]`, 'u'));

  // --- test fixture marker ----------------------------------------------
  const fixtureRoot = path.join(workspaces.main, 'projects', 'marked-test-fixture');
  mkdirSync(fixtureRoot, { mode: 0o700 });
  writeFileSync(path.join(fixtureRoot, 'REFERENZ.md'), '# Fixture without code\n', { mode: 0o600 });
  writeFileSync(path.join(fixtureRoot, '.awf-project-fixture.json'), JSON.stringify({ schema: 'awf.project-fixture.v1',
    kind: 'test-fixture', agentId: 'main', projectId: 'marked-test-fixture', reason: 'synthetic doctor fixture' }),
    { mode: 0o600 });
  const fixtureDoctor = (await commands.doctor(main)).text;
  assert.match(fixtureDoctor, /Test-Fixtures übersprungen: marked-test-fixture/u,
    'a valid owner marker excludes a fixture from project findings');
  assert.doesNotMatch(fixtureDoctor, /\[marked-test-fixture\]/u,
    'a skipped fixture produces no project findings');
  assert.ok(JSON.parse((await commands.doctor(main, 'json')).text).skippedFixtures.includes('marked-test-fixture'));
  writeFileSync(path.join(fixtureRoot, '.awf-project-fixture.json'), JSON.stringify({ schema: 'awf.project-fixture.v1',
    kind: 'other', agentId: 'main', projectId: 'marked-test-fixture', reason: 'wrong kind' }), { mode: 0o600 });
  assert.match((await commands.doctor(main)).text, /reference-code-missing \[marked-test-fixture\]/u,
    'an invalid marker does not hide a project');
  rmSync(fixtureRoot, { recursive: true, force: true });

  // --- doctor project IDs and JSON output --------------------------------
  const brokenRoot = path.join(workspaces.main, 'projects', 'broken-project-without-reference');
  mkdirSync(brokenRoot, { mode: 0o700 });
  const doctorText = (await commands.doctor(main)).text;
  assert.match(doctorText, /reference-missing \[broken-project-without-reference\]/u,
    'doctor findings name the affected project');
  assert.match(doctorText, /integrity: (PASS|MISMATCH|MISSING|INVALID|VERSION_DRIFT)/u, 'doctor always reports release integrity');
  const doctorJson = JSON.parse((await commands.doctor(main, 'json')).text);
  assert.ok(doctorJson.findings.some((row) => row.projectId === 'broken-project-without-reference'),
    'JSON doctor output keeps project-scoped findings');
  assert.ok(['PASS', 'MISMATCH', 'MISSING', 'INVALID', 'VERSION_DRIFT'].includes(doctorJson.release.status));
  assert.equal(doctorJson.release.loadedVersion, JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version);
  assert.ok(doctorJson.counts.projects >= 1);
  assert.ok(Array.isArray(doctorJson.projects));
  rmSync(brokenRoot, { recursive: true, force: true });

  writeFileSync(path.join(lifecycleRoot, 'history', 'lifecycle.jsonl'), 'not json\n', { mode: 0o600 });
  assert.match((await commands.doctor(main)).text,
    new RegExp(`lifecycle-log-invalid \\[${path.basename(lifecycleRoot)}\\]`, 'u'),
    'an unreadable lifecycle log is reported');

  // --- 0.4.0: quarantine, history report, prompt budget, legacy limit -----
  const quarantineSource = path.join(altProjectsRoot, 'quarantine-fixture');
  mkdirSync(quarantineSource, { mode: 0o700 });
  writeFileSync(path.join(quarantineSource, 'REFERENZ.md'), '# Q – Quarantine Fixture\n', { mode: 0o600 });
  const quarantined = quarantineProjectDirectory(quarantineSource, lstatSync(workspaces.main).uid, workspaces.main, () => currentTime);
  assert.equal(existsSync(quarantineSource), false, 'the failed destination is moved, not deleted');
  assert.ok(quarantined.path.startsWith(path.join(workspaces.main, '.project-trash') + path.sep));
  assert.ok(existsSync(path.join(quarantined.path, 'REFERENZ.md')), 'quarantined content is preserved');

  const historySummary = inspectProjectHistory(lifecycleRoot, lstatSync(workspaces.main).uid);
  assert.ok(historySummary.captures.files >= 0 && historySummary.totalBytes >= 0);
  const captureProject = await commands.createProject(main, 'History Report Fixture');
  const captureCode = /Erstellt und ausgewählt: ([A-Z][0-9]+)/u.exec(captureProject.text)[1];
  const captureRoot = readdirSync(altProjectsRoot).map((entry) => path.join(altProjectsRoot, entry))
    .find((root) => readFileSync(path.join(root, 'REFERENZ.md'), 'utf8').includes(captureCode));
  saveApprovedProjectMemory({ projectRoot: captureRoot, uid: lstatSync(workspaces.main).uid,
    summary: '## Aktueller Stand\n\nSynthetisch.\n\n## Neue Beschlüsse dieses Gesprächs\n\n- Beschluss: Report-Fixture.', now: () => new Date(currentTime), kind: 'capture', reviewId: 'a'.repeat(24) });
  const capturedHistory = inspectProjectHistory(captureRoot, lstatSync(workspaces.main).uid);
  assert.equal(capturedHistory.captures.files, 1);
  assert.equal(capturedHistory.decisions.files, 1);
  assert.ok(capturedHistory.totalBytes > 0);
  assert.match((await commands.projectMemory(main, 'decisions', 'latest')).text, /Beschluss: Report-Fixture/u,
    'decision archives are readable on demand');
  assert.match((await commands.projectMemory(main, 'captures', 'latest')).text, /Synthetisch/u);

  const bigContext = path.join(captureRoot, 'KONTEXT.md');
  writeFileSync(bigContext, 'x'.repeat(30 * 1024), { mode: 0o600 });
  const budgeted = await commands.selectProject(main, captureCode);
  assert.match(budgeted.text, /für dieses Gespräch ausgewählt/u);
  const budgetedHook = await commands.hook({}, main);
  assert.match(budgetedHook.prependContext, /\[project-context: \d+ UTF-8-Bytes gekürzt/u,
    'oversized context is truncated with an explicit marker');
  assert.ok(Buffer.byteLength(budgetedHook.prependContext, 'utf8') < 60 * 1024);

  const legacyDir = path.join(captureRoot, 'history', 'legacy');
  mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  const legacyBefore = inspectProjectHistory(captureRoot, lstatSync(workspaces.main).uid).legacy.files;
  for (let index = 0; index < 55; index += 1) {
    writeFileSync(path.join(legacyDir, `legacy-context-${String(index).padStart(24, '0')}.md`), 'legacy\n', { mode: 0o600 });
  }
  const legacyRead = readProjectMemoryRecords({ projectRoot: captureRoot, uid: lstatSync(workspaces.main).uid,
    section: 'legacy', recordId: 'legacy' });
  assert.equal(legacyRead.records.length, 50, 'legacy listings are capped');
  assert.equal(legacyRead.total, legacyBefore + 55, 'the total reports every archived legacy record');

  assert.throws(() => replaceProjectSnapshotAtomically(path.join(captureRoot, 'KONTEXT.md'), captureRoot,
    lstatSync(workspaces.main).uid, Buffer.from('y'.repeat(17 * 1024), 'utf8'), undefined), /überschreitet/u,
    'snapshots above 16 KiB are refused');

  currentTime = new Date('2027-01-15T12:00:00.000Z');
  const expiredStatus = (await commands.projectStatus(main)).text;
  assert.match(expiredStatus, /selection-expired/u, 'an expired selection reports its reason');
  assert.match(expiredStatus, /abgelaufen/u);


  // --- 0.10.0 acceptance tests A1-A14 (context care) -----------------------
  const careCreated = await commands.createProject(main, 'Context Care');
  const careCode = careCreated.text.match(/Erstellt und ausgewählt: ([A-Z]\d+)/u)?.[1];
  assert.ok(careCode, 'the care project was created with an A code: ' + careCreated.text);
  const careRoot = (/Workspace: (\S+)/u.exec(careCreated.text)?.[1] ?? '').replace(/\.$/u, '') || undefined;
  assert.ok(careRoot, 'the care project path is reported');
  const careContext = path.join(careRoot, 'KONTEXT.md');
  currentTime = new Date('2026-11-23T10:00:00.000Z');

  // A2: a project without a snapshot names that instead of inventing a diff.
  rmSync(careContext, { force: true });
  const firstPreview = await commands.proposeSummary(main, 'Erster Stand ohne Vorlauf');
  assert.match(firstPreview.text, /Kein vorheriger Arbeitsstand vorhanden/u, 'A2: preview names the missing previous state: ' + firstPreview.text);

  const beforeText = '# Current project context\n\nGleich: Diese Zeile bleibt\nALT: Diese Zeile ändert sich\n';
  const afterText = '# Current project context\n\nGleich: Diese Zeile bleibt\nNEU: Diese Zeile ändert sich\n';
  writeFileSync(careContext, beforeText, { mode: 0o600 });
  const beforeHash = createHash('sha256').update(readFileSync(careContext)).digest('hex');
  const diffPreview = await commands.proposeSummary(main, afterText);
  assert.match(diffPreview.text, /^-ALT: Diese Zeile ändert sich$/mu, 'A1: removed line is shown');
  assert.match(diffPreview.text, /^\+NEU: Diese Zeile ändert sich$/mu, 'A1: added line is shown');
  const afterHash = createHash('sha256').update(readFileSync(careContext)).digest('hex');
  assert.equal(afterHash, beforeHash, 'A1: the preview does not touch KONTEXT.md');

  const diffBody = diffPreview.text.split('```diff')[1].split('```')[0].split('\n').filter(Boolean);
  assert.ok(diffBody.length > 0, 'A5: the preview contains a diff body');
  for (const row of diffBody) {
    const payload = row.slice(1);
    assert.ok(beforeText.includes(payload) || afterText.includes(payload),
      'A5: diff lines only quote the two compared versions');
  }

  const capturesDir = path.join(careRoot, 'history', 'captures');
  assert.equal(existsSync(capturesDir) ? readdirSync(capturesDir).length : 0, 0,
    'A4: a preview stores nothing without confirm');

  const longBefore = Array.from({ length: 60 }, (_, i) => `Zeile ${i}`).join('\n');
  const longAfter = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? `Zeile ${i}` : `Geändert ${i}`)).join('\n');
  const longDiff = formatCaptureDiff(longBefore, longAfter, 40);
  assert.match(longDiff, /weitere Zeile\(n\) ausgelassen/u, 'A3: the diff is capped and says so');
  assert.ok(longDiff.split('\n').filter((line) => line.startsWith('+') || line.startsWith('-')).length <= 40,
    'A3: at most the configured number of diff lines is shown');

  // A6/A9/A7: a backdated snapshot produces exactly one hint per project and day.
  const oldStamp = new Date('2026-11-03T10:00:00.000Z');
  utimesSync(careContext, oldStamp, oldStamp);
  const staleHook = await commands.hook({}, main);
  assert.match(staleHook.prependContext, /Tage alt/u, 'A6: a stale snapshot produces a hint');
  assert.equal(staleHook.prependContext.split('Hinweis:').length - 1, 1, 'A9: the hint is a single line');
  const secondHook = await commands.hook({}, main);
  assert.doesNotMatch(secondHook.prependContext, /Tage alt/u, 'A6: the hint is not repeated in the same day');

  const freshCreated = await commands.createProject(main, 'Context Fresh');
  const freshCode = freshCreated.text.match(/Erstellt und ausgewählt: ([A-Z]\d+)/u)?.[1];
  assert.ok(freshCode, 'the fresh project was created with an A code');
  const freshRoot = (/Workspace: (\S+)/u.exec(freshCreated.text)?.[1] ?? '').replace(/\.$/u, '') || undefined;
  assert.ok(freshRoot, 'the fresh project path is reported');
  writeFileSync(path.join(freshRoot, 'KONTEXT.md'), '# Current project context\n\n- frisch\n', { mode: 0o600 });
  const freshHook = await commands.hook({}, main);
  assert.doesNotMatch(freshHook.prependContext, /Tage alt/u, 'A7: a fresh snapshot produces no hint');

  // A8: staleContextDays 0 disables the hint even for an old snapshot.
  const zeroCommands = prepareWorkspaceProjectCommands({
    selectionStore: selections, selectionStoreForCommand: () => selections,
    allocationStoreForCommand: () => allocations, reviewStore: reviews, reviewStoreForCommand: () => reviews,
    repairStoreForCommand: () => repairs, transferStoreForCommand: () => transfers,
    projectConfigStore: projectConfigs, projectConfigStoreForCommand: () => projectConfigs,
    resolveWorkspaceDir: (_config, agentId) => workspaces[agentId],
    staleContextDays: () => 0, pluginLoadPaths: () => [], now: () => new Date(currentTime),
  });
  await zeroCommands.selectProject(main, careCode);
  const zeroHook = await zeroCommands.hook({}, main);
  assert.doesNotMatch(zeroHook.prependContext, /Tage alt/u, 'A8: staleContextDays 0 disables the hint');

  // A10: a project without a snapshot must not break the hook.
  await commands.createProject(main, 'Context Missing');
  const missingHook = await commands.hook({}, main);
  assert.ok(typeof missingHook.prependContext === 'string', 'A10: the hook still returns context');
  assert.doesNotMatch(missingHook.prependContext, /Tage alt/u, 'A10: no hint without a snapshot');

  // A11/A12/A13/A14: install-source drift, unknown catalog metadata, offline doctor.
  const driftCommands = prepareWorkspaceProjectCommands({
    selectionStore: selections, selectionStoreForCommand: () => selections,
    allocationStoreForCommand: () => allocations, reviewStore: reviews, reviewStoreForCommand: () => reviews,
    repairStoreForCommand: () => repairs, transferStoreForCommand: () => transfers,
    projectConfigStore: projectConfigs, projectConfigStoreForCommand: () => projectConfigs,
    resolveWorkspaceDir: (_config, agentId) => workspaces[agentId],
    pluginLoadPaths: () => [PLUGIN_ROOT], now: () => new Date(currentTime),
  });
  const driftDoctor = (await driftCommands.doctor(main)).text;
  assert.match(driftDoctor, /install-source-drift/u, 'A11: a load-path install is reported');
  assert.match(driftDoctor, /Fehler: 0/u, 'A11: the finding is informative only');
  assert.doesNotMatch((await commands.doctor(main)).text, /install-source-drift/u,
    'A12: a registered install reports no drift');

  const unknownCommands = prepareWorkspaceProjectCommands({
    selectionStore: selections, selectionStoreForCommand: () => selections,
    allocationStoreForCommand: () => allocations, reviewStore: reviews, reviewStoreForCommand: () => reviews,
    repairStoreForCommand: () => repairs, transferStoreForCommand: () => transfers,
    projectConfigStore: projectConfigs, projectConfigStoreForCommand: () => projectConfigs,
    resolveWorkspaceDir: (_config, agentId) => workspaces[agentId],
    pluginLoadPaths: () => { throw new Error('no local catalog'); }, now: () => new Date(currentTime),
  });
  const unknownDoctor = (await unknownCommands.doctor(main)).text;
  assert.match(unknownDoctor, /Fehler: 0/u, 'A13: unknown catalog metadata is not an error');
  assert.doesNotMatch(unknownDoctor, /install-source-drift/u, 'A13: unknown means no drift claim');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('doctor must not use the network'); };
  try {
    assert.match((await commands.doctor(main)).text, /Projekt-Doctor/u, 'A14: doctor works without network access');
  } finally { globalThis.fetch = originalFetch; }


  // --- 0.11.0 acceptance tests S1-S10 (search) -----------------------------
  const searchCreated = await commands.createProject(main, 'Search Target');
  const searchRoot = ((/Workspace: (\S+)/u.exec(searchCreated.text)?.[1]) ?? '').replace(/\.$/u, '') || undefined;
  assert.ok(searchRoot, 'the search project path is reported');
  const searchCode = /Erstellt und ausgewählt: ([A-Z]\d+)/u.exec(searchCreated.text)?.[1];
  assert.ok(searchCode, 'the search project has a code');
  const searchContext = path.join(searchRoot, 'KONTEXT.md');
  writeFileSync(searchContext, '# Kontext\n\nBudget 2027 ist freigegeben.\n', { mode: 0o600 });

  const s1 = (await commands.searchProjects(main, 'budget')).text;
  assert.match(s1, /Suche – \d+ Treffer/u, 'S1: a hit in KONTEXT is reported');
  assert.ok(s1.includes(searchCode), 'S1: the hit names the project code');
  assert.match(s1, /Budget 2027/u, 'S4: matching is case-insensitive');

  assert.match((await commands.searchProjects(main, 'a')).text, /zu kurz/u, 'S7: a one-character query is rejected');
  assert.match((await commands.searchProjects(main, '')).text, /zu kurz/u, 'S7: an empty query is rejected');
  assert.match((await commands.searchProjects(main, 'xyzzyplugh')).text, /Kein Treffer/u, 'S6: no hit is a normal result');

  assert.match((await commands.searchProjects(main, 'budget 2027')).text, /Treffer für/u, 'S5: both terms match');
  assert.match((await commands.searchProjects(main, 'budget zahnrad')).text, /Kein Treffer/u, 'S5: all terms must match');

  const searchPreview = await commands.proposeSummary(main, 'Orbitstart wurde für Dienstag bestätigt.');
  assert.match(searchPreview.text, /Vorschau/u, 'the capture preview for the search fixture is created');
  await commands.confirmSummary(main);
  const s2 = (await commands.searchProjects(main, 'Orbitstart')).text;
  assert.match(s2, /Capture/u, 'S2: a capture record is searched');
  assert.match(s2, /[a-f0-9]{24}/u, 'S2: the capture id is named');

  const decisionsDir = path.join(searchRoot, 'history', 'decisions');
  mkdirSync(decisionsDir, { recursive: true, mode: 0o700 });
  chmodSync(decisionsDir, 0o700);
  const decisionName = 'decisions-2026-11-23T19-00-00Z-' + 'a'.repeat(24) + '.md';
  writeFileSync(path.join(decisionsDir, decisionName), '# Approved decisions\n\n- Kometenstart am Montag.\n', { mode: 0o600 });
  const s3 = (await commands.searchProjects(main, 'Kometenstart')).text;
  assert.match(s3, /Entscheidung/u, 'S3: a decision record is searched');

  const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const beforeReference = hashOf(path.join(searchRoot, 'REFERENZ.md'));
  const beforeContext = hashOf(searchContext);
  await commands.searchProjects(main, 'budget');
  assert.equal(hashOf(path.join(searchRoot, 'REFERENZ.md')), beforeReference, 'S9: search does not write the reference');
  assert.equal(hashOf(searchContext), beforeContext, 'S9: search does not write the context');

  const broadRows = (await commands.searchProjects(main, 'Projekt')).text.split('\n').filter((line) => line.startsWith('- **'));
  assert.ok(broadRows.length <= 20, 'S8: at most 20 hits are shown');

  await commands.changeProjectStatus(main, searchCode, 'archived');
  assert.match((await commands.searchProjects(main, 'budget')).text, /Kein Treffer/u, 'S10: archived projects are not searched');


  // --- 0.12.0 acceptance tests E1-E12 (export/import) ----------------------
  const exportSource = await commands.createProject(main, 'Export Source');
  const exportSourceCode = /Erstellt und ausgewählt: ([A-Z]\d+)/u.exec(exportSource.text)?.[1];
  const exportSourceRoot = ((/Workspace: (\S+)/u.exec(exportSource.text)?.[1]) ?? '').replace(/\.$/u, '') || undefined;
  assert.ok(exportSourceCode && exportSourceRoot, 'the export fixture exists');
  writeFileSync(path.join(exportSourceRoot, 'KONTEXT.md'), '# Kontext\n\nExportierbarer Stand.\n', { mode: 0o600 });

  const exported = await commands.exportProject(main, exportSourceCode);
  assert.match(exported.text, /Export geschrieben/u, 'E1: export reports a written file');
  const exportPath = /Export geschrieben: (\S+)/u.exec(exported.text)?.[1];
  assert.ok(exportPath && existsSync(exportPath), 'E1: the export file exists');
  assert.ok(!exportPath.startsWith(exportSourceRoot + path.sep), 'E1/E2: the export lives outside the project folder');
  const archive = JSON.parse(readFileSync(exportPath, 'utf8'));
  assert.equal(archive.schema, 'awf.project-export.v1', 'E1: the schema is recorded');
  assert.ok(Array.isArray(archive.captures) && Array.isArray(archive.decisions), 'E1: history sections are present');
  assert.equal(archive.selection, undefined, 'E2: no selection state is exported');
  assert.equal(archive.codexLink, undefined, 'E2: no Codex link is exported');

  const sourceReferenceBefore = createHash('sha256').update(readFileSync(path.join(exportSourceRoot, 'REFERENZ.md'))).digest('hex');
  const imported = await commands.importProject(main, exportPath);
  assert.match(imported.text, /Import abgeschlossen/u, 'E3: import succeeds: ' + imported.text);
  const importedCode = /Import abgeschlossen: ([A-Z]\d+)/u.exec(imported.text)?.[1];
  assert.ok(importedCode && importedCode !== exportSourceCode, 'E3/E9: import allocates a new code');
  assert.equal(createHash('sha256').update(readFileSync(path.join(exportSourceRoot, 'REFERENZ.md'))).digest('hex'), sourceReferenceBefore,
    'E11: the source project is unchanged');
  const importedRoot = /Pfad: (\S+)/u.exec(imported.text)?.[1];
  assert.ok(importedRoot && existsSync(importedRoot), 'E3: the imported project directory exists');
  assert.ok(readFileSync(path.join(importedRoot, 'REFERENZ.md'), 'utf8').includes('## Herkunft'), 'E3: provenance is recorded');
  const listedAfterImport = (await commands.listProjects(main)).text;
  assert.ok(listedAfterImport.includes(importedCode), 'E8: the imported project is active and listed');

  const badSchemaPath = path.join(os.tmpdir(), 'awf-bad-schema.json');
  writeFileSync(badSchemaPath, JSON.stringify({ schema: 'awf.other.v1' }), { mode: 0o600 });
  assert.match((await commands.importProject(main, badSchemaPath)).text, /Unbekanntes Exportschema/u, 'E4: unknown schema is rejected');

  const noReference = JSON.parse(readFileSync(exportPath, 'utf8'));
  delete noReference.referenz;
  const noReferencePath = path.join(os.tmpdir(), 'awf-no-reference.json');
  writeFileSync(noReferencePath, JSON.stringify(noReference), { mode: 0o600 });
  assert.match((await commands.importProject(main, noReferencePath)).text, /keine gültige Referenz/u, 'E12: a missing reference is rejected');

  assert.match((await commands.importProject(main, 'relative/path.json')).text, /absoluten Pfad/u, 'E5: a relative path is rejected');

  const badRecord = JSON.parse(readFileSync(exportPath, 'utf8'));
  badRecord.captures = [{ id: 'not-hex', text: 'x' }];
  const badRecordPath = path.join(os.tmpdir(), 'awf-bad-record.json');
  writeFileSync(badRecordPath, JSON.stringify(badRecord), { mode: 0o600 });
  assert.match((await commands.importProject(main, badRecordPath)).text, /Ungültiger Historieneintrag/u, 'E5: invalid record ids are rejected');

  const oversize = JSON.parse(readFileSync(exportPath, 'utf8'));
  oversize.captures = [{ id: 'a'.repeat(24), text: 'x'.repeat(9 * 1024) }];
  const oversizePath = path.join(os.tmpdir(), 'awf-oversize.json');
  writeFileSync(oversizePath, JSON.stringify(oversize), { mode: 0o600 });
  assert.match((await commands.importProject(main, oversizePath)).text, /Größenlimit/u, 'E6: oversized records are rejected');

  const binaryPath = path.join(os.tmpdir(), 'awf-binary.json');
  writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  assert.match((await commands.importProject(main, binaryPath)).text, /kein gültiges UTF-8-JSON/u, 'E7: non-UTF-8 content is rejected');

  assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).captures.length, archive.captures.length, 'E10: the round trip keeps the capture count');
  assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).decisions.length, archive.decisions.length, 'E10: the round trip keeps the decision count');

  const foreignCtx = { ...main, senderIsOwner: false };
  assert.match((await commands.exportProject(foreignCtx, exportSourceCode)).text, /Owner-Befehl|authentifizierten Owner/u, 'E11: export requires owner authority');


  // --- 0.13.0 acceptance tests M1-M10 (mention loading) --------------------
  const mentionCommands = prepareWorkspaceProjectCommands({
    selectionStore: selections, selectionStoreForCommand: () => selections,
    allocationStoreForCommand: () => allocations, reviewStore: reviews, reviewStoreForCommand: () => reviews,
    repairStoreForCommand: () => repairs, transferStoreForCommand: () => transfers,
    projectConfigStore: projectConfigs, projectConfigStoreForCommand: () => projectConfigs,
    resolveWorkspaceDir: (_config, agentId) => workspaces[agentId],
    autoLoadOnMention: () => true, pluginLoadPaths: () => [], now: () => new Date(currentTime),
  });

  const mentionA = await commands.createProject(main, 'Raketenprogramm');
  const mentionACode = /Erstellt und ausgewählt: ([A-Z]\d+)/u.exec(mentionA.text)?.[1];
  const mentionARoot = ((/Workspace: (\S+)/u.exec(mentionA.text)?.[1]) ?? '').replace(/\.$/u, '') || undefined;
  assert.ok(mentionACode && mentionARoot, 'the mention fixture exists');
  writeFileSync(path.join(mentionARoot, 'KONTEXT.md'), '# Kontext\n\nRaketenprogramm Startfenster im April.\n', { mode: 0o600 });
  await commands.clearProject(main);

  const m1 = await mentionCommands.hook({ currentUserMessage: 'Wie steht es um das Raketenprogramm?' }, main);
  assert.match(m1.prependContext, /automatisch geladen/u, 'M1: a unique name loads the context');
  assert.ok(m1.prependContext.includes(mentionACode), 'M9: the load line names the code');

  const m2 = await mentionCommands.hook({ currentUserMessage: `Status von ${mentionACode} bitte` }, main);
  assert.match(m2.prependContext, /automatisch geladen/u, 'M2: a unique code loads the context');

  const m3 = await mentionCommands.hook({ currentUserMessage: 'RAKETENPROGRAMM und nichts anderes' }, main);
  assert.match(m3.prependContext, /automatisch geladen/u, 'M3: matching ignores case');

  const m4 = await mentionCommands.hook({ currentUserMessage: 'Das RaketenprogrammX ist etwas anderes' }, main);
  assert.doesNotMatch(m4?.prependContext ?? '', /automatisch geladen/u, 'M4: a partial word does not match');

  const m6 = await commands.hook({ currentUserMessage: 'Wie steht es um das Raketenprogramm?' }, main);
  assert.doesNotMatch(m6?.prependContext ?? '', /automatisch geladen/u, 'M6: the switch is off by default');

  const mentionB = await commands.createProject(main, 'Raketenbasis');
  const mentionBRoot = ((/Workspace: (\S+)/u.exec(mentionB.text)?.[1]) ?? '').replace(/\.$/u, '') || undefined;
  writeFileSync(path.join(mentionBRoot, 'KONTEXT.md'), '# Kontext\n\nRaketenbasis Wartung im Mai.\n', { mode: 0o600 });
  await commands.clearProject(main);
  const m5 = await mentionCommands.hook({ currentUserMessage: 'Bitte Raketen kurz zusammenfassen' }, main);
  assert.equal(m5, undefined, 'M5: an ambiguous prefix loads nothing');
  const m5b = await mentionCommands.hook({ currentUserMessage: 'Raketenprogramm und Raketenbasis vergleichen' }, main);
  assert.match(m5b.prependContext, /Mehrere Projekte passen/u, 'M5: two names list the candidates');
  assert.doesNotMatch(m5b.prependContext, /<project-reference>/u, 'M5: no context is loaded when ambiguous');

  await commands.selectProject(main, mentionACode);
  const m7 = await mentionCommands.hook({ currentUserMessage: 'Was macht die Raketenbasis?' }, main);
  assert.match(m7.prependContext, /Raketenprogramm/u, 'M7: an explicit selection wins over a mention');
  await commands.clearProject(main);

  const mentionHash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const beforeMention = [mentionHash(path.join(mentionARoot, 'KONTEXT.md')), mentionHash(path.join(mentionBRoot, 'KONTEXT.md'))];
  await mentionCommands.hook({ currentUserMessage: 'Raketenprogramm Status?' }, main);
  assert.deepEqual([mentionHash(path.join(mentionARoot, 'KONTEXT.md')), mentionHash(path.join(mentionBRoot, 'KONTEXT.md'))], beforeMention,
    'M8: mention loading writes nothing');

  await commands.changeProjectStatus(main, mentionACode, 'archived');
  const m10 = await mentionCommands.hook({ currentUserMessage: 'Wie steht es um das Raketenprogramm?' }, main);
  assert.doesNotMatch(m10?.prependContext ?? '', /automatisch geladen/u, 'M10: archived projects are not auto-loaded [' + mentionACode + '] ' + String(m10?.prependContext ?? '').slice(0, 160));

  console.log('Workspace project-context checks passed: help/list, A/P/B creation, model changes, legacy codes, per-agent locations, exact Codex workspace auto-link, conversation isolation, context loading, archive/trash/restore, merge, cross-agent move, Doctor, confirmed Repair, capture/closeout, release integrity, snapshot re-hash, creation rollback, lifecycle audit, quarantine rollback, history report, prompt budget, legacy limit, context-care diffs, stale hints, install-source drift, local search, project export and import, mention loading, and authorization.');
} finally {
  for (const root of Object.values(workspaces)) chmodSync(root, 0o700);
  rmSync(tempRoot, { recursive: true, force: true });
}

