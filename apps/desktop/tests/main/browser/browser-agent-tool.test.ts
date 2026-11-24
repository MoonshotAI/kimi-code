import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentMcpService,
  IEventBus,
  SubagentSpawned,
  IAgentPermissionModeService,
  IAgentToolApprovalService,
  IAgentToolExecutorService,
  IAgentToolPolicyService,
  IAgentProfileService,
  IAgentToolRegistryService,
  IAgentToolSelectService,
  ISessionManager,
  ISessionMcpHandle,
} from '@moonshot-ai/agent-core-v2';
import { startServer } from '@moonshot-ai/kap-server';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import {
  DESKTOP_BROWSER_DIRECT_REMINDER,
  DESKTOP_BROWSER_DISABLED_REMINDER,
  DESKTOP_BROWSER_ENABLED_REMINDER,
  DESKTOP_BROWSER_REMINDER_VARIANT,
  createDesktopBrowserAccess,
  registerDesktopBrowserMcp,
} from '../../../src/main/browser/browser-mcp-registration';
import { runBrowserAutomation } from '../../../src/main/browser/browser-automation';
import {
  DESKTOP_BROWSER_BLOCKED_GUIDANCE,
  DESKTOP_BROWSER_DISABLED_ERROR,
  DESKTOP_BROWSER_MCP_TOOL,
  startDesktopBrowserMcp,
  type DesktopBrowserAgentControl,
} from '../../../src/main/browser/browser-mcp';
import { browserControlOwnership } from '../../../src/main/browser/browser-control-ownership';

vi.mock('../../../src/main/browser/browser-automation', () => ({
  isAgentLocalFileAddress: () => false,
  runBrowserAutomation: vi.fn(async (request) => ({
    ok: true,
    operation: request.operation,
    browser: { available: true, panelVisible: false, activeTabId: null, visibleTabId: null, tabs: [] },
  })),
}));

const NAME = 'mcp__desktop_browser__run';
const PROTOCOL = 'kimi.browser/1.0.0';

type Control = DesktopBrowserAgentControl & { set(enabled: boolean): void };

function createControl(initial = true): Control {
  let enabled = initial;
  const listeners = new Set<(enabled: boolean) => void>();
  return {
    enabled: () => enabled,
    onDidChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      enabled = next;
      for (const listener of listeners) listener(next);
    },
  };
}

async function startBrowserTestServer(prefix: string, control: Control, subagentControl?: Control) {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  const home = await mkdtemp(join(tmpdir(), prefix));
  const access = createDesktopBrowserAccess(control, subagentControl);
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const registration = registerDesktopBrowserMcp(server.core, browser.config, access);
  const sessions = server.core.accessor.get(ISessionManager);
  return {
    home,
    access,
    sessions,
    async dispose() {
      registration.dispose();
      await server.close();
      await browser.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

type Session = Awaited<ReturnType<ISessionManager['create']>>;
type Agent = NonNullable<ReturnType<IAgentLifecycleService['handleOf']>>;

async function agentOf(session: Session, agentId = 'main', dynamic = true): Promise<Agent> {
  await session.accessor.get(ISessionMcpHandle).ready;
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  if (lifecycle.handleOf(agentId) === undefined) await lifecycle.create({ agentId });
  const agent = lifecycle.handleOf(agentId)!;
  vi.spyOn(agent.accessor.get(IAgentProfileService), 'getModelCapabilities').mockReturnValue({
    image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
    max_context_tokens: 128000, dynamically_loaded_tools: dynamic,
  });
  await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
  return agent;
}

async function runReminderStep(agent: Agent): Promise<void> {
  const loop = agent.accessor.get(IAgentLoopService);
  const entries = Reflect.get(loop.hooks.onWillBeginStep, 'entries') as readonly {
    readonly id: string;
    readonly handler: (
      context: { turnId: number; step: number; firstStepOfTurn: boolean; signal: AbortSignal },
      next: () => Promise<void>,
    ) => void | Promise<void>;
  }[];
  const injector = entries.find((entry) => entry.id === 'context-injector');
  if (injector === undefined) throw new Error('expected context-injector hook');
  await injector.handler({ turnId: 0, step: 0, firstStepOfTurn: false, signal: new AbortController().signal }, async () => {});
  loop.flushReminders();
}

function reminders(agent: Agent): string[] {
  return agent.accessor.get(IAgentLoopService).history()
    .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === DESKTOP_BROWSER_REMINDER_VARIANT)
    .map((message) => JSON.stringify(message.content));
}

function tool(agent: Agent) {
  return agent.accessor.get(IAgentToolRegistryService).resolve(NAME);
}

let callSequence = 0;
async function call(agent: Agent, turnId = 1, operation = 'browser.get_state') {
  const toolCall = { type: 'function' as const, id: `call-${++callSequence}`, name: NAME, arguments: JSON.stringify({ protocol: PROTOCOL, operation }) };
  const result = await agent.accessor.get(IAgentToolExecutorService).executor.execute(toolCall, { origin: 'loop', turnId });
  if ('detached' in result) throw new Error('unexpected detached tool result');
  return {
    output: result.content.every((part) => part.type === 'text') ? result.content.map((part) => part.type === 'text' ? part.text : '').join('') : JSON.stringify(result.content),
    isError: result.outcome.type === 'success' ? undefined : true,
  };
}

async function resolveRun(agent: Agent, operation = 'browser.get_state') {
  const execution = await tool(agent)!.resolveExecution({ protocol: PROTOCOL, operation });
  if (!('execute' in execution)) throw new Error('browser execution was not resolved');
  return (turnId = 1) => execution.execute({ turnId, toolCallId: `queued-${++callSequence}`, signal: new AbortController().signal });
}

function outputText(result: { output: unknown }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(runBrowserAutomation).mockClear();
});

it('offers the browser as a deferred tool with the published schema and restores it on resume', async () => {
  const harness = await startBrowserTestServer('desktop-browser-tool-load-', createControl());
  try {
    const session = await harness.sessions.create({ workDir: harness.home });
    const agent = await agentOf(session);
    agent.accessor.get(IAgentPermissionModeService).setMode('yolo');
    const registry = agent.accessor.get(IAgentToolRegistryService);
    const selection = agent.accessor.get(IAgentToolSelectService);
    await selection.prepareForRequest();
    expect(selection.enabled()).toBe(true);
    expect(registry.resolve('select_tools')).toBeDefined();
    expect(tool(agent)).toMatchObject({ description: DESKTOP_BROWSER_MCP_TOOL.description, parameters: DESKTOP_BROWSER_MCP_TOOL.inputSchema });
    await selection.prepareForRequest();
    expect(selection.shapeTools(registry.list()).map((entry) => entry.name)).not.toContain(NAME);
    expect(selection.loadableToolsAnnouncement()?.content[0]).toMatchObject({ text: expect.stringContaining(NAME) });
    const loaded = selection.load([NAME]);
    expect(loaded.toLoad).toEqual([NAME]);
    expect(loaded.schemas.map((schema) => schema.name)).toEqual([NAME]);

    const result = await call(agent);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('browser.get_state');
    expect(runBrowserAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id);

    await harness.sessions.close(session.id);
    const restored = await agentOf((await harness.sessions.resume(session.id))!);
    await vi.waitFor(() => expect(tool(restored)).toBeDefined());
  } finally {
    await harness.dispose();
  }
}, 30000);

it('reminds agents about the built-in browser and follows the agent control switch live', async () => {
  const control = createControl();
  const harness = await startBrowserTestServer('desktop-browser-tool-control-', control);
  try {
    const existing = await harness.sessions.create({ workDir: harness.home });
    const createdDir = join(harness.home, 'created');
    await mkdir(createdDir);
    const created = await harness.sessions.create({ workDir: createdDir });
    const agents = await Promise.all([existing, created].map((session) => agentOf(session)));
    for (const agent of agents) {
      await runReminderStep(agent);
      await runReminderStep(agent);
      expect(reminders(agent)).toHaveLength(1);
      expect(reminders(agent)[0]).toContain('select_tools');
    }
    expect(DESKTOP_BROWSER_ENABLED_REMINDER).toContain(NAME);

    const agent = agents[1]!;
    expect(agent.accessor.get(IAgentLoopService).replaceHistory([], 'clear')).toBe(true);
    await runReminderStep(agent);
    expect(reminders(agent)).toHaveLength(1);

    const selection = agent.accessor.get(IAgentToolSelectService);
    const loop = agent.accessor.get(IAgentLoopService);
    const requestView = () => {
      const base = loop.baselineTools();
      const disclosure = selection.enabled();
      const tools = selection.requestTools(base, disclosure);
      const deferred = base.filter((entry) => entry.deferred === true);
      const messages = selection.shapeHistory(loop.history(), disclosure, tools, deferred);
      const announcements = messages
        .map((message) => JSON.stringify(message.content))
        .filter((text) => text.includes('<tools_added>') || text.includes('<tools_removed>'))
        .join('\n');
      return { toolNames: tools.map((entry) => entry.name), announcements };
    };
    await selection.prepareForRequest();
    expect(tool(agent)).toBeDefined();
    const enabledView = requestView();
    expect(enabledView.toolNames).not.toContain(NAME);
    expect(enabledView.announcements).toContain(NAME);
    const queued = await resolveRun(agent);
    control.set(false);
    await vi.waitFor(() => expect(tool(agent)).toBeUndefined());
    await selection.prepareForRequest();
    expect(requestView().toolNames).not.toContain(NAME);
    await runReminderStep(agent);
    const disabledAfterStep = requestView();
    expect(disabledAfterStep.announcements).toContain('<tools_removed>');
    expect(disabledAfterStep.announcements).toContain(NAME);
    const denied = await queued();
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.output)).toContain(JSON.stringify(DESKTOP_BROWSER_DISABLED_ERROR).slice(1, -1));
    expect(runBrowserAutomation).not.toHaveBeenCalled();
    await runReminderStep(agent);
    await runReminderStep(agent);
    expect(reminders(agent)).toHaveLength(2);
    expect(reminders(agent)[1]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));

    expect(loop.replaceHistory([], 'clear')).toBe(true);
    await runReminderStep(agent);
    expect(reminders(agent)).toHaveLength(1);
    expect(reminders(agent)[0]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));

    control.set(true);
    await vi.waitFor(() => expect(tool(agent)).toBeDefined());
    await selection.prepareForRequest();
    const reenabledView = requestView();
    expect(reenabledView.toolNames).not.toContain(NAME);
    expect(reenabledView.announcements).toContain(NAME);
    await runReminderStep(agent);
    expect(reminders(agent)).toHaveLength(2);
    expect(reminders(agent)[1]).toContain('select_tools');
    expect(selection.load([NAME]).toLoad).toEqual([NAME]);
  } finally {
    await harness.dispose();
  }
}, 30000);

it('keeps the built-in browser for chats that already used it when agent control turns off', async () => {
  const control = createControl();
  const harness = await startBrowserTestServer('desktop-browser-tool-keep-', control);
  const useTool = (agent: Agent, toolName: string, args: string) => {
    const loop = agent.accessor.get(IAgentLoopService);
    loop.remind(historyEntryFromContext(
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: `call-${toolName}`, name: toolName, arguments: args }] },
    ));
    loop.flushReminders();
  };
  try {
    const dirs = await Promise.all(['used', 'fresh', 'past', 'schema'].map(async (dir) => {
      await mkdir(join(harness.home, dir));
      return join(harness.home, dir);
    }));
    const [usedSession, freshSession, pastSession, schemaSession] = await Promise.all(dirs.map((workDir) => harness.sessions.create({ workDir })));
    const [used, fresh, past, schema] = await Promise.all([usedSession!, freshSession!, pastSession!, schemaSession!].map((session) => agentOf(session)));
    for (const agent of [used!, fresh!, past!, schema!]) {
      agent.accessor.get(IAgentPermissionModeService).setMode('yolo');
      await runReminderStep(agent);
    }
    useTool(used!, NAME, '{}');
    useTool(past!, 'select_tools', JSON.stringify({ names: [NAME] }));
    const schemaLoop = schema!.accessor.get(IAgentLoopService);
    schemaLoop.remind(historyEntryFromContext({
      role: 'system',
      content: [],
      tools: [{ name: NAME, description: 'Built-in browser', parameters: {} }],
      origin: { kind: 'injection', variant: 'dynamic_tool_schema' },
    }));
    schemaLoop.flushReminders();
    await harness.sessions.close(pastSession!.id);
    const queued = await resolveRun(fresh!);

    control.set(false);
    await vi.waitFor(() => expect(tool(fresh!)).toBeUndefined());
    await runReminderStep(fresh!);
    expect(reminders(fresh!)).toHaveLength(2);
    expect(reminders(fresh!)[1]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));
    expect((await queued()).isError).toBe(true);

    expect(tool(used!)).toBeDefined();
    expect(tool(schema!)).toBeDefined();
    await runReminderStep(used!);
    expect(reminders(used!)).toHaveLength(1);
    expect((await call(used!)).isError).not.toBe(true);

    const resumed = await agentOf((await harness.sessions.resume(pastSession!.id))!);
    resumed.accessor.get(IAgentPermissionModeService).setMode('yolo');
    await vi.waitFor(() => expect(tool(resumed)).toBeDefined());
    await runReminderStep(resumed);
    expect(reminders(resumed).join()).not.toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));
    expect((await call(resumed)).isError).not.toBe(true);

    control.set(true);
    await vi.waitFor(() => expect(tool(fresh!)).toBeDefined());
    expect(tool(used!)).toBeDefined();
    expect(tool(schema!)).toBeDefined();
    expect(tool(resumed)).toBeDefined();
    await runReminderStep(fresh!);
    expect(reminders(fresh!)).toHaveLength(3);
    expect(reminders(fresh!)[2]).toContain('select_tools');

    control.set(false);
    await vi.waitFor(() => expect(tool(fresh!)).toBeUndefined());
    control.set(true);
    await vi.waitFor(() => expect(tool(fresh!)).toBeDefined());
  } finally {
    await harness.dispose();
  }
}, 30000);

it('does not keep the built-in browser for chats whose only browser attempts were refused', async () => {
  const control = createControl();
  const harness = await startBrowserTestServer('desktop-browser-tool-refused-', control);
  const settle = (agent: Agent, toolName: string, args: string, output: string) => {
    const loop = agent.accessor.get(IAgentLoopService);
    const id = `call-${toolName}`;
    loop.remind(
      historyEntryFromContext({ role: 'assistant', content: [], toolCalls: [{ type: 'function', id, name: toolName, arguments: args }] }),
      historyEntryFromContext({ role: 'tool', content: [{ type: 'text', text: output }], toolCallId: id, isError: true }),
    );
    loop.flushReminders();
  };
  type Kind = 'call' | 'rewritten' | 'select' | 'erred';
  const histories: Record<Kind, (agent: Agent) => void> = {
    call: (agent) => settle(agent, NAME, '{}', `Tool "${NAME}" not found`),
    rewritten: (agent) => settle(
      agent,
      NAME,
      '{}',
      'Agent control of the built-in browser is turned off in Kimi Code Settings > Browser, so `mcp__desktop_browser__run` is unavailable. The user can turn it back on there. For read-only web lookups, use WebSearch or FetchURL instead. Otherwise, stop and tell the user (or your parent agent) that the built-in browser is unavailable and why.',
    ),
    select: (agent) => settle(
      agent,
      'select_tools',
      JSON.stringify({ names: [NAME] }),
      `Unknown tool: ${NAME}. No tools can be loaded in this session — use the tools you already have.`,
    ),
    erred: (agent) => settle(agent, NAME, '{}', 'TAB_NOT_ACTIVE: the tab is not the active tab'),
  };
  try {
    const live: Partial<Record<Kind, Agent>> = {};
    const queued: Partial<Record<Kind, Awaited<ReturnType<typeof resolveRun>>>> = {};
    const closed: Partial<Record<Kind, string>> = {};
    for (const kind of ['call', 'rewritten', 'select', 'erred'] as const) {
      for (const phase of ['live', 'closed']) {
        const workDir = join(harness.home, `${kind}-${phase}`);
        await mkdir(workDir);
        const session = await harness.sessions.create({ workDir });
        const agent = await agentOf(session);
        histories[kind](agent);
        if (phase === 'live') {
          live[kind] = agent;
          queued[kind] = await resolveRun(agent);
        } else {
          closed[kind] = session.id;
          await harness.sessions.close(session.id);
        }
      }
    }
    const directDir = join(harness.home, 'direct');
    await mkdir(directDir);
    const direct = await agentOf(await harness.sessions.create({ workDir: directDir }), 'main', false);
    await runReminderStep(direct);
    expect(reminders(direct)).toHaveLength(1);
    expect(reminders(direct)[0]).toContain(DESKTOP_BROWSER_DIRECT_REMINDER.slice(0, 80));
    expect(reminders(direct)[0]).not.toContain('select_tools');
    expect(DESKTOP_BROWSER_DIRECT_REMINDER).toContain(NAME);
    expect(DESKTOP_BROWSER_DIRECT_REMINDER).not.toContain('select_tools');

    control.set(false);
    for (const kind of ['call', 'rewritten', 'select'] as const) {
      await vi.waitFor(() => expect(tool(live[kind]!)).toBeUndefined());
      expect(outputText(await queued[kind]!())).toContain(DESKTOP_BROWSER_DISABLED_ERROR);
    }
    expect(tool(live.erred!)).toBeDefined();
    expect((await queued.erred!()).isError).not.toBe(true);

    for (const kind of ['call', 'rewritten', 'select'] as const) {
      const resumed = await agentOf((await harness.sessions.resume(closed[kind]!))!);
      expect(harness.access.kept.has(closed[kind]!)).toBe(false);
      expect(tool(resumed)).toBeUndefined();
      expect(outputText(await call(resumed))).toContain('turned off in Kimi Code Settings > Browser');
    }
    const resumed = await agentOf((await harness.sessions.resume(closed.erred!))!);
    resumed.accessor.get(IAgentPermissionModeService).setMode('yolo');
    expect(harness.access.kept.has(closed.erred!)).toBe(true);
    await vi.waitFor(() => expect(tool(resumed)).toBeDefined());
    expect((await call(resumed)).isError).not.toBe(true);
  } finally {
    await harness.dispose();
  }
}, 30000);

it('tells every agent why the built-in browser is blocked and allows other available tools', async () => {
  const control = createControl(false);
  const subagentControl = createControl(false);
  const harness = await startBrowserTestServer('desktop-browser-tool-blocked-', control, subagentControl);
  try {
    const session = await harness.sessions.create({ workDir: harness.home });
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
    for (const agentId of ['worker', 'explorer', 'approver', 'runner']) await lifecycle.create({ agentId });
    const [main, worker, explorer, approver, runner] = await Promise.all(['main', 'worker', 'explorer', 'approver', 'runner'].map((agentId) => agentOf(session, agentId, false)));
    vi.spyOn(explorer!.accessor.get(IAgentToolPolicyService), 'isToolActive').mockImplementation((toolName) => !toolName.startsWith('mcp__'));
    const expectGuidance = (result: Awaited<ReturnType<typeof call>>, reason: string) => {
      expect(result.isError).toBe(true);
      const output = outputText(result);
      expect(output).toContain(reason);
      expect(output).toContain('Use WebSearch, FetchURL, or other available tools if they fit the task.');
      expect(output).toContain('tell the user (or your parent agent) that the built-in browser is unavailable and why.');
      expect(output).not.toContain('workaround');
      expect(output).not.toContain('computer use');
      expect(output).not.toContain('Otherwise, stop');
    };

    for (const agent of [main!, worker!]) {
      await runReminderStep(agent);
      expect(reminders(agent)).toHaveLength(1);
      expect(reminders(agent)[0]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 120));
      expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
      expect(DESKTOP_BROWSER_DISABLED_REMINDER).not.toContain('workaround');
      expect(DESKTOP_BROWSER_DISABLED_REMINDER).not.toContain('computer use');
      expect(tool(agent)).toBeUndefined();
      expectGuidance(await call(agent), 'turned off in Kimi Code Settings > Browser');
    }
    expect(DESKTOP_BROWSER_DISABLED_ERROR).toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    expect(DESKTOP_BROWSER_DISABLED_ERROR).not.toContain('workaround');

    control.set(true);
    subagentControl.set(true);
    for (const agent of [explorer!, approver!, runner!]) {
      await vi.waitFor(() => expect(tool(agent)).toBeDefined());
    }
    expectGuidance(await call(explorer!), 'tool policy of this agent does not allow');

    const approval = approver!.accessor.get(IAgentToolApprovalService);
    approver!.accessor.get(IAgentToolExecutorService).registerLegacyStarting((event) => {
      event.veto({ output: approval.formatApprovalRejectionMessage(NAME, { decision: 'rejected' }), isError: true });
    });
    expectGuidance(await call(approver!), 'was not run because the user rejected the approval request');

    runner!.accessor.get(IAgentPermissionModeService).setMode('yolo');
    const runnerLoop = runner!.accessor.get(IAgentLoopService);
    const runnerBase = runnerLoop.snapshot();
    vi.spyOn(runnerLoop, 'snapshot').mockImplementation(() => ({ ...runnerBase, state: 'running', activeTurnId: 100 }));
    const allowed = await call(runner!, 100);
    expect(allowed.isError).not.toBe(true);
    expect(outputText(allowed)).toContain('browser.get_state');
    expect(outputText(allowed)).not.toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    await runReminderStep(worker!);
    expect(reminders(worker!)).toHaveLength(2);
    expect(reminders(worker!)[1]).not.toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    await runReminderStep(runner!);
    expect(reminders(runner!)).toEqual([expect.stringContaining('built-in browser of Kimi Code Desktop')]);
  } finally {
    await harness.dispose();
  }
}, 30000);

it('passes trusted subagent runs through dynamic and direct tools without weakening restrictions', async () => {
  const control = createControl();
  const subagentControl = createControl();
  const harness = await startBrowserTestServer('desktop-browser-tool-subagents-', control, subagentControl);
  try {
    const session = await harness.sessions.create({ workDir: harness.home });
    await session.accessor.get(ISessionMcpHandle).ready;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const mainContext = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    const prepare = async (agentId: string, dynamic: boolean, turnId: number, profileName?: string, approve = true) => {
      const agent = lifecycle.handleOf(agentId)!;
      const profile = agent.accessor.get(IAgentProfileService);
      if (profileName !== undefined) {
        const data = profile.data();
        vi.spyOn(profile, 'data').mockReturnValue({ ...data, profileName });
      }
      vi.spyOn(profile, 'getModelCapabilities').mockReturnValue({
        image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
        max_context_tokens: 128000, dynamically_loaded_tools: dynamic,
      });
      await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
      if (approve) agent.accessor.get(IAgentPermissionModeService).setMode('yolo');
      const loop = agent.accessor.get(IAgentLoopService);
      const base = loop.snapshot();
      const activity = { running: true, turnId };
      vi.spyOn(loop, 'snapshot').mockImplementation(() => ({
        ...base,
        state: activity.running ? 'running' : 'idle',
        activeTurnId: activity.turnId,
      }));
      if (dynamic) expect(agent.accessor.get(IAgentToolSelectService).load([NAME]).toLoad).toEqual([NAME]);
      return { agent, activity };
    };

    const workerContext = await lifecycle.create({ agentId: 'worker' });
    const worker = await prepare('worker', true, 7, 'coder');
    session.accessor.get(ISessionEventBus).publish(new SubagentSpawned({
      subagentId: 'worker', subagentName: 'coder', parentToolCallId: 'parent-call', description: 'Inspect docs', runInBackground: true,
    }));
    expect((await call(worker.agent, 7)).isError).not.toBe(true);
    const directContext = await lifecycle.create({ agentId: 'direct' });
    const direct = await prepare('direct', false, 8);
    expect((await call(direct.agent, 8)).isError).not.toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(2);
    expect(runBrowserAutomation).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id,
      expect.objectContaining({ run: { agentId: 'worker', generation: workerContext.generation, turnId: 7 }, profile: 'coder', description: 'Inspect docs' }),
    );
    expect(runBrowserAutomation).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id,
      expect.objectContaining({ run: { agentId: 'direct', generation: directContext.generation, turnId: 8 } }),
    );

    const revoked = vi.fn();
    harness.access.runs.onDidRevoke(revoked);
    worker.agent.accessor.get(IEventBus).publish(new TurnEnded({ agentId: 'worker', turnId: 7, reason: 'completed' }), workerContext);
    expect(revoked).toHaveBeenCalledWith(session.id, { agentId: 'worker', generation: workerContext.generation, turnId: 7 });
    worker.activity.running = false;
    expect((await call(worker.agent, 7, 'browser.get_downloads')).isError).toBe(true);
    worker.activity.running = true;
    worker.activity.turnId = 9;
    expect((await call(worker.agent, 7, 'browser.get_history')).isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(2);

    const queued = await resolveRun(worker.agent);
    subagentControl.set(false);
    expect((await queued(9)).isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(2);

    const queuedDynamic = await resolveRun(worker.agent);
    const queuedDirect = await resolveRun(direct.agent);
    subagentControl.set(true);
    expect((await queuedDynamic(9)).isError).not.toBe(true);
    expect((await queuedDirect(8)).isError).not.toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(4);
    expect(runBrowserAutomation).toHaveBeenNthCalledWith(3,
      expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id,
      expect.objectContaining({ run: { agentId: 'worker', generation: workerContext.generation, turnId: 9 }, profile: 'coder', description: 'Inspect docs' }),
    );
    expect(runBrowserAutomation).toHaveBeenNthCalledWith(4,
      expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id,
      expect.objectContaining({ run: { agentId: 'direct', generation: directContext.generation, turnId: 8 } }),
    );

    const workerRun = { agentId: 'worker', generation: workerContext.generation, turnId: 9 };
    subagentControl.set(false);
    expect(browserControlOwnership.isBlocked(session.id, workerRun)).toBe(true);
    const subagentDisabled = await call(worker.agent, 9, 'browser.get_device_profiles');
    expect(subagentDisabled.isError).toBe(true);
    expect(outputText(subagentDisabled)).toContain('not currently running with built-in browser control enabled');
    expect(outputText(subagentDisabled)).toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    expect(outputText(subagentDisabled)).not.toContain('workaround');
    expect(runBrowserAutomation).toHaveBeenCalledTimes(4);
    subagentControl.set(true);
    expect(browserControlOwnership.isBlocked(session.id, workerRun)).toBe(false);
    expect((await (await resolveRun(worker.agent))(9)).isError).not.toBe(true);
    control.set(false);
    expect(browserControlOwnership.isBlocked(session.id, workerRun)).toBe(true);
    subagentControl.set(false);
    control.set(true);
    expect(browserControlOwnership.isBlocked(session.id, workerRun)).toBe(true);
    subagentControl.set(true);
    expect(browserControlOwnership.isBlocked(session.id, workerRun)).toBe(false);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(5);
    await lifecycle.fork(mainContext, { agentId: 'btw', labels: { btw: 'true' } });
    const btw = await prepare('btw', false, 10, undefined, false);
    expect((await call(btw.agent, 10)).isError).toBe(true);
    await lifecycle.create({ agentId: 'explorer' });
    const explorer = await prepare('explorer', false, 11, 'explore');
    expect((await call(explorer.agent, 11)).isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(5);
  } finally {
    await harness.dispose();
  }
}, 30000);
