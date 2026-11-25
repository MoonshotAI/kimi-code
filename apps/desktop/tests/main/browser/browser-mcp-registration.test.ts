import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  DESKTOP_BROWSER_DIRECT_REMINDER,
  DESKTOP_BROWSER_DISABLED_REMINDER,
  DESKTOP_BROWSER_ENABLED_REMINDER,
  DESKTOP_BROWSER_REMINDER_VARIANT,
  createDesktopBrowserAccess,
  registerDesktopBrowserMcp,
} from '../../../src/main/browser/browser-mcp-registration';
import { runBrowserAutomation } from '../../../src/main/browser/browser-automation';
import { DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE, DESKTOP_BROWSER_BLOCKED_GUIDANCE, DESKTOP_BROWSER_DISABLED_ERROR, DESKTOP_BROWSER_RESTRICTED_GUIDANCE, startDesktopBrowserMcp, type DesktopBrowserAgentControl } from '../../../src/main/browser/browser-mcp';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { browserControlOwnership } from '../../../src/main/browser/browser-control-ownership';

vi.mock('../../../src/main/browser/browser-automation', () => ({
  isAgentLocalFileAddress: () => false,
  runBrowserAutomation: vi.fn(async (request) => ({
    ok: true,
    operation: request.operation,
    browser: { available: true, panelVisible: false, activeTabId: null, visibleTabId: null, tabs: [] },
  })),
}));

function createControl(initial = true): DesktopBrowserAgentControl & { set(enabled: boolean): void } {
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

async function runReminderStep(loop: IAgentLoopService): Promise<void> {
  await loop.start();
  const entries = Reflect.get(loop.hooks.onWillBeginStep, 'entries') as readonly {
    readonly id: string;
    readonly handler: (
      context: { turnId: number; step: number; firstStepOfTurn: boolean; signal: AbortSignal },
      next: () => Promise<void>,
    ) => void | Promise<void>;
  }[];
  const injector = entries.find((entry) => entry.id === 'context-injector');
  if (injector === undefined) throw new Error('expected context-injector hook');
  await injector.handler({
    turnId: 0,
    step: 0,
    firstStepOfTurn: false,
    signal: new AbortController().signal,
  }, async () => {});
  loop.flushReminders();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('describes task-based routing, browser availability, and approval rejection separately', () => {
  expect(DESKTOP_BROWSER_ENABLED_REMINDER).toContain('select_tools');
  expect(DESKTOP_BROWSER_DIRECT_REMINDER).not.toContain('select_tools');
  for (const reminder of [DESKTOP_BROWSER_ENABLED_REMINDER, DESKTOP_BROWSER_DIRECT_REMINDER]) {
    expect(reminder).toContain("Follow the user's requested browser, profile, or tool");
    expect(reminder).toContain('For a one-off lookup of public information, prefer WebSearch or FetchURL');
    expect(reminder).toContain('Default to the built-in browser when neither option has a clear advantage');
    expect(reminder).toContain('WebBridge is ready only when its skill is available and both its daemon and browser extension are connected');
    expect(reminder).toContain('the target profile is known to be logged in');
    expect(reminder).toContain('do not repeat the submission');
    expect(reminder).toContain("verify that CU's browser path is available");
    expect(reminder).toContain('get user consent before using CU');
    expect(reminder).toContain('Subagents must follow their own browser permissions');
  }
  expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain('Do not load or call `mcp__desktop_browser__run`');
  expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain('To view or operate a page, use WebBridge');
  expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain("verify that CU's browser extension and local service are connected");
  expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain('get user consent before using a real browser');
  expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain('do not repeat the submission or switch tools');
  expect(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE).toContain('The user rejected this built-in browser operation');
  expect(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE).toContain("Without the user's explicit consent");
  expect(DESKTOP_BROWSER_RESTRICTED_GUIDANCE).toContain('permitted by the active agent restrictions');
  expect(DESKTOP_BROWSER_RESTRICTED_GUIDANCE).not.toContain('To view or operate a page, use WebBridge');
  expect(DESKTOP_BROWSER_RESTRICTED_GUIDANCE).not.toContain('then tell the user and use CU');
  expect(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE).not.toContain('then tell the user and use CU');
  expect(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE).not.toContain('WebSearch or FetchURL');
});

it('loads the browser through upstream MCP selection and restores it with session-scoped credentials', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-mcp-registration-'));
  const browser = await startDesktopBrowserMcp();
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const registration = registerDesktopBrowserMcp(server.core, browser.config, createDesktopBrowserAccess(createControl()));
  try {
    const sessions = server.core.accessor.get(ISessionManager);
    const session = await sessions.create({
      workDir: home,
      mcpServers: { other_browser: browser.config },
    });
    const mcp = session.accessor.get(ISessionMcpHandle);
    await mcp.ready;
    expect(mcp.connectionManager.list().map((entry) => entry.name).sort())
      .toEqual(['desktop_browser', 'other_browser']);
    expect(mcp.isBaselineServer('desktop_browser')).toBe(true);

    const lifecycle = session.accessor.get(IAgentLifecycleService);
    if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
    const agent = lifecycle.handleOf('main')!;
    const profile = agent.accessor.get(IAgentProfileService);
    vi.spyOn(profile, 'getModelCapabilities').mockReturnValue({
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
      dynamically_loaded_tools: true,
    });
    const agentMcp = agent.accessor.get(IAgentMcpService);
    await agentMcp.waitForInitialLoad();
    const registry = agent.accessor.get(IAgentToolRegistryService);
    const selection = agent.accessor.get(IAgentToolSelectService);
    await selection.prepareForRequest();
    const name = 'mcp__desktop_browser__run';
    expect(selection.enabled()).toBe(true);
    expect(registry.resolve('select_tools')).toBeDefined();
    expect(registry.resolve(name)).toBeDefined();
    await selection.prepareForRequest();
    expect(selection.shapeTools(registry.list()).map((tool) => tool.name)).not.toContain(name);
    expect(selection.loadableToolsAnnouncement()?.content[0]).toMatchObject({
      text: expect.stringContaining(name),
    });
    const loaded = selection.load([name]);
    expect(loaded.toLoad).toEqual([name]);
    expect(loaded.schemas.map((tool) => tool.name)).toEqual([name]);

    const result = await agentMcp.resolved('desktop_browser')!.client.callTool('run', {
      protocol: 'kimi.browser/1.0.0',
      operation: 'browser.get_state',
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('browser.get_state');
    expect(runBrowserAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id);

    await sessions.close(session.id);
    const restored = await sessions.resume(session.id, {
      mcpServers: { other_browser: browser.config },
    });
    expect(restored).toBeDefined();
    const restoredMcp = restored!.accessor.get(ISessionMcpHandle);
    await restoredMcp.ready;
    expect(restoredMcp.connectionManager.get('desktop_browser')?.status).toBe('connected');
    expect(restoredMcp.connectionManager.get('other_browser')?.status).toBe('connected');
    expect(await readdir(home)).not.toContain('mcp.json');

    registration.dispose();
    await sessions.close(session.id);
    const withoutBrowser = await sessions.resume(session.id);
    const plainMcp = withoutBrowser!.accessor.get(ISessionMcpHandle);
    await plainMcp.ready;
    expect(plainMcp.connectionManager.get('desktop_browser')).toBeUndefined();
  } finally {
    registration.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);

it('reminds agents about the built-in browser and follows the agent control switch live', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-mcp-control-'));
  const control = createControl();
  const access = createDesktopBrowserAccess(control);
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const sessions = server.core.accessor.get(ISessionManager);
  const existing = await sessions.create({ workDir: home });
  const registration = registerDesktopBrowserMcp(server.core, browser.config, access);
  try {
    const createdDir = join(home, 'created');
    await mkdir(createdDir);
    const created = await sessions.create({ workDir: createdDir });
    const name = 'mcp__desktop_browser__run';
    const agents = await Promise.all([existing, created].map(async (session) => {
      await session.accessor.get(ISessionMcpHandle).ready;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
      const agent = lifecycle.handleOf('main')!;
      vi.spyOn(agent.accessor.get(IAgentProfileService), 'getModelCapabilities').mockReturnValue({
        image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
        max_context_tokens: 128000, dynamically_loaded_tools: true,
      });
      await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
      return agent;
    }));
    const reminders = (agent: (typeof agents)[number]) => agent.accessor.get(IAgentLoopService).history()
      .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === DESKTOP_BROWSER_REMINDER_VARIANT)
      .map((message) => JSON.stringify(message.content));
    const reconcile = (agent: (typeof agents)[number]) =>
      runReminderStep(agent.accessor.get(IAgentLoopService));

    for (const agent of agents) {
      await reconcile(agent);
      await reconcile(agent);
      expect(reminders(agent)).toHaveLength(1);
      expect(reminders(agent)[0]).toContain('select_tools');
    }
    expect(DESKTOP_BROWSER_ENABLED_REMINDER).toContain(name);

    const agent = agents[1];
    expect(agent!.accessor.get(IAgentLoopService).replaceHistory([], 'clear')).toBe(true);
    await reconcile(agent!);
    expect(reminders(agent!)).toHaveLength(1);

    const registry = agent!.accessor.get(IAgentToolRegistryService);
    const selection = agent!.accessor.get(IAgentToolSelectService);
    const loop = agent!.accessor.get(IAgentLoopService);
    const requestView = () => {
      const base = loop.baselineTools();
      const disclosure = selection.enabled();
      const tools = selection.requestTools(base, disclosure);
      const deferred = base.filter((tool) => tool.deferred === true);
      const messages = selection.shapeHistory(loop.history(), disclosure, tools, deferred);
      const announcements = messages
        .map((message) => JSON.stringify(message.content))
        .filter((text) => text.includes('<tools_added>') || text.includes('<tools_removed>'))
        .join('\n');
      return { toolNames: tools.map((tool) => tool.name), announcements };
    };
    await selection.prepareForRequest();
    expect(registry.resolve(name)).toBeDefined();
    const enabledView = requestView();
    expect(enabledView.toolNames).not.toContain(name);
    expect(enabledView.announcements).toContain(name);
    control.set(false);
    await vi.waitFor(() => expect(registry.resolve(name)).toBeUndefined());
    await selection.prepareForRequest();
    const disabledView = requestView();
    expect(disabledView.toolNames).not.toContain(name);
    await reconcile(agent!);
    const disabledAfterStep = requestView();
    expect(disabledAfterStep.announcements).toContain('<tools_removed>');
    expect(disabledAfterStep.announcements).toContain(name);
    const denied = await agent!.accessor.get(IAgentMcpService).resolved('desktop_browser')!.client.callTool('run', { protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain(DESKTOP_BROWSER_DISABLED_ERROR.replaceAll('\n', '\\n'));
    await reconcile(agent!);
    await reconcile(agent!);
    expect(reminders(agent!)).toHaveLength(2);
    expect(reminders(agent!)[1]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));

    expect(agent!.accessor.get(IAgentLoopService).replaceHistory([], 'clear')).toBe(true);
    await reconcile(agent!);
    expect(reminders(agent!)).toHaveLength(1);
    expect(reminders(agent!)[0]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));

    control.set(true);
    await vi.waitFor(() => expect(registry.resolve(name)).toBeDefined());
    await selection.prepareForRequest();
    const reenabledView = requestView();
    expect(reenabledView.toolNames).not.toContain(name);
    expect(reenabledView.announcements).toContain(name);
    await reconcile(agent!);
    expect(reminders(agent!)).toHaveLength(2);
    expect(reminders(agent!)[1]).toContain('select_tools');
    expect(selection.load([name]).toLoad).toEqual([name]);
  } finally {
    registration.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);

it('keeps the built-in browser for chats that already used it when agent control turns off', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-mcp-keep-'));
  const connects = vi.spyOn(Server.prototype, 'connect');
  const closes = vi.spyOn(Server.prototype, 'close');
  const control = createControl();
  const access = createDesktopBrowserAccess(control);
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const sessions = server.core.accessor.get(ISessionManager);
  const registration = registerDesktopBrowserMcp(server.core, browser.config, access);
  const name = 'mcp__desktop_browser__run';
  const prepare = async (session: Awaited<ReturnType<typeof sessions.create>>) => {
    await session.accessor.get(ISessionMcpHandle).ready;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
    const agent = lifecycle.handleOf('main')!;
    vi.spyOn(agent.accessor.get(IAgentProfileService), 'getModelCapabilities').mockReturnValue({
      image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
      max_context_tokens: 128000, dynamically_loaded_tools: true,
    });
    await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
    return agent;
  };
  type Agent = Awaited<ReturnType<typeof prepare>>;
  const reminders = (agent: Agent) => agent.accessor.get(IAgentLoopService).history()
    .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === DESKTOP_BROWSER_REMINDER_VARIANT)
    .map((message) => JSON.stringify(message.content));
  const reconcile = (agent: Agent) =>
    runReminderStep(agent.accessor.get(IAgentLoopService));
  const tool = (agent: Agent) => agent.accessor.get(IAgentToolRegistryService).resolve(name);
  const callBrowser = (agent: Agent) => agent.accessor.get(IAgentMcpService).resolved('desktop_browser')!.client
    .callTool('run', { protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
  const useTool = (agent: Agent, toolName: string, args: string) => {
    const loop = agent.accessor.get(IAgentLoopService);
    loop.remind(historyEntryFromContext(
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: `call-${toolName}`, name: toolName, arguments: args }] },
    ));
    loop.flushReminders();
  };
  try {
    const dirs = await Promise.all(['used', 'fresh', 'past', 'schema'].map(async (dir) => {
      await mkdir(join(home, dir));
      return join(home, dir);
    }));
    const [usedSession, freshSession, pastSession, schemaSession] = await Promise.all(dirs.map((workDir) => sessions.create({ workDir })));
    const [used, fresh, past, schema] = await Promise.all([usedSession!, freshSession!, pastSession!, schemaSession!].map(prepare));
    for (const agent of [used!, fresh!, past!, schema!]) await reconcile(agent);
    useTool(used!, name, '{}');
    useTool(past!, 'select_tools', JSON.stringify({ names: [name] }));
    const schemaLoop = schema!.accessor.get(IAgentLoopService);
    schemaLoop.remind(historyEntryFromContext({
      role: 'system',
      content: [],
      tools: [{ name, description: 'Built-in browser', parameters: {} }],
      origin: { kind: 'injection', variant: 'dynamic_tool_schema' },
    }));
    schemaLoop.flushReminders();
    await sessions.close(pastSession!.id);

    control.set(false);
    await vi.waitFor(() => expect(tool(fresh!)).toBeUndefined());
    await reconcile(fresh!);
    expect(reminders(fresh!)).toHaveLength(2);
    expect(reminders(fresh!)[1]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));
    const denied = await callBrowser(fresh!);
    expect(JSON.stringify(denied.content)).toContain(DESKTOP_BROWSER_DISABLED_ERROR.replaceAll('\n', '\\n'));

    expect(tool(used!)).toBeDefined();
    expect(tool(schema!)).toBeDefined();
    await reconcile(used!);
    expect(reminders(used!)).toHaveLength(1);
    expect((await callBrowser(used!)).isError).not.toBe(true);

    const resumed = await prepare((await sessions.resume(pastSession!.id))!);
    await vi.waitFor(() => expect(tool(resumed)).toBeDefined());
    await reconcile(resumed);
    expect(reminders(resumed).join()).not.toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 40));
    expect((await callBrowser(resumed)).isError).not.toBe(true);

    control.set(true);
    await vi.waitFor(() => expect(tool(fresh!)).toBeDefined());
    expect(tool(used!)).toBeDefined();
    expect(tool(schema!)).toBeDefined();
    expect(tool(resumed)).toBeDefined();
    await reconcile(fresh!);
    expect(reminders(fresh!)).toHaveLength(3);
    expect(reminders(fresh!)[2]).toContain('select_tools');

    control.set(false);
    await vi.waitFor(() => expect(tool(fresh!)).toBeUndefined());
    control.set(true);
    await vi.waitFor(() => expect(tool(fresh!)).toBeDefined());
    await vi.waitFor(() => expect(new Set(connects.mock.contexts).size - new Set(closes.mock.contexts).size).toBe(4));
  } finally {
    registration.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);

it('does not keep the built-in browser for chats whose only browser attempts were refused', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-mcp-refused-'));
  const control = createControl();
  const access = createDesktopBrowserAccess(control);
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const sessions = server.core.accessor.get(ISessionManager);
  const registration = registerDesktopBrowserMcp(server.core, browser.config, access);
  const name = 'mcp__desktop_browser__run';
  const prepare = async (session: Awaited<ReturnType<typeof sessions.create>>, dynamic = true) => {
    await session.accessor.get(ISessionMcpHandle).ready;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
    const agent = lifecycle.handleOf('main')!;
    vi.spyOn(agent.accessor.get(IAgentProfileService), 'getModelCapabilities').mockReturnValue({
      image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
      max_context_tokens: 128000, dynamically_loaded_tools: dynamic,
    });
    await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
    return agent;
  };
  type Agent = Awaited<ReturnType<typeof prepare>>;
  const tool = (agent: Agent) => agent.accessor.get(IAgentToolRegistryService).resolve(name);
  const callBrowser = (agent: Agent) => agent.accessor.get(IAgentMcpService).resolved('desktop_browser')!.client
    .callTool('run', { protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
  const reminders = (agent: Agent) => agent.accessor.get(IAgentLoopService).history()
    .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === DESKTOP_BROWSER_REMINDER_VARIANT)
    .map((message) => JSON.stringify(message.content));
  const settle = async (agent: Agent, toolName: string, args: string, output: string) => {
    const loop = agent.accessor.get(IAgentLoopService);
    await loop.start();
    const id = `call-${toolName}`;
    loop.remind(
      historyEntryFromContext({ role: 'assistant', content: [], toolCalls: [{ type: 'function', id, name: toolName, arguments: args }] }),
      historyEntryFromContext({ role: 'tool', content: [{ type: 'text', text: output }], toolCallId: id, isError: true }),
    );
    loop.flushReminders();
  };
  type Kind = 'call' | 'rewritten' | 'select' | 'erred';
  const histories: Record<Kind, (agent: Agent) => Promise<void>> = {
    call: (agent) => settle(agent, name, '{}', `Tool "${name}" not found`),
    rewritten: (agent) => settle(
      agent,
      name,
      '{}',
      'Agent control of the built-in browser is turned off in Kimi Code Settings > Browser, so `mcp__desktop_browser__run` is unavailable. The user can turn it back on there. For read-only web lookups, use WebSearch or FetchURL instead. Otherwise, stop and tell the user (or your parent agent) that the built-in browser is unavailable and why.',
    ),
    select: (agent) => settle(
      agent,
      'select_tools',
      JSON.stringify({ names: [name] }),
      `Unknown tool: ${name}. No tools can be loaded in this session — use the tools you already have.`,
    ),
    erred: (agent) => settle(agent, name, '{}', 'TAB_NOT_ACTIVE: the tab is not the active tab'),
  };
  try {
    const live: Partial<Record<Kind, Agent>> = {};
    const closed: Partial<Record<Kind, string>> = {};
    for (const kind of ['call', 'rewritten', 'select', 'erred'] as const) {
      for (const phase of ['live', 'closed']) {
        const workDir = join(home, `${kind}-${phase}`);
        await mkdir(workDir);
        const session = await sessions.create({ workDir });
        const agent = await prepare(session);
        await histories[kind](agent);
        if (phase === 'live') live[kind] = agent;
        else {
          closed[kind] = session.id;
          await sessions.close(session.id);
        }
      }
    }
    const directDir = join(home, 'direct');
    await mkdir(directDir);
    const direct = await prepare(await sessions.create({ workDir: directDir }), false);
    await runReminderStep(direct.accessor.get(IAgentLoopService));
    expect(reminders(direct)).toHaveLength(1);
    expect(reminders(direct)[0]).toContain(DESKTOP_BROWSER_DIRECT_REMINDER.slice(0, 80));
    expect(reminders(direct)[0]).not.toContain('select_tools');
    expect(DESKTOP_BROWSER_DIRECT_REMINDER).toContain(name);
    expect(DESKTOP_BROWSER_DIRECT_REMINDER).not.toContain('select_tools');

    control.set(false);
    await vi.waitFor(() => expect(tool(live.call!)).toBeUndefined());
    await vi.waitFor(() => expect(tool(live.rewritten!)).toBeUndefined());
    await vi.waitFor(() => expect(tool(live.select!)).toBeUndefined());
    expect(tool(live.erred!)).toBeDefined();
    expect(JSON.stringify((await callBrowser(live.call!)).content)).toContain(DESKTOP_BROWSER_DISABLED_ERROR.replaceAll('\n', '\\n'));
    expect(JSON.stringify((await callBrowser(live.rewritten!)).content)).toContain(DESKTOP_BROWSER_DISABLED_ERROR.replaceAll('\n', '\\n'));
    expect(JSON.stringify((await callBrowser(live.select!)).content)).toContain(DESKTOP_BROWSER_DISABLED_ERROR.replaceAll('\n', '\\n'));
    expect((await callBrowser(live.erred!)).isError).not.toBe(true);

    for (const kind of ['call', 'rewritten', 'select'] as const) {
      const resumed = await prepare((await sessions.resume(closed[kind]!))!);
      expect(access.kept.has(closed[kind]!)).toBe(false);
      expect(tool(resumed)).toBeUndefined();
      expect(JSON.stringify((await callBrowser(resumed)).content)).toContain(DESKTOP_BROWSER_DISABLED_ERROR.replaceAll('\n', '\\n'));
    }
    const resumed = await prepare((await sessions.resume(closed.erred!))!);
    expect(access.kept.has(closed.erred!)).toBe(true);
    await vi.waitFor(() => expect(tool(resumed)).toBeDefined());
    expect((await callBrowser(resumed)).isError).not.toBe(true);
  } finally {
    registration.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);

it('tells every agent why the built-in browser is blocked and allows other available tools', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-mcp-blocked-'));
  const control = createControl(false);
  const subagentControl = createControl(false);
  const access = createDesktopBrowserAccess(control, subagentControl);
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const sessions = server.core.accessor.get(ISessionManager);
  const registration = registerDesktopBrowserMcp(server.core, browser.config, access);
  const name = 'mcp__desktop_browser__run';
  try {
    const session = await sessions.create({ workDir: home });
    await session.accessor.get(ISessionMcpHandle).ready;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
    for (const agentId of ['worker', 'explorer', 'approver', 'runner']) await lifecycle.create({ agentId });
    const prepare = async (agentId: string) => {
      const agent = lifecycle.handleOf(agentId)!;
      vi.spyOn(agent.accessor.get(IAgentProfileService), 'getModelCapabilities').mockReturnValue({
        image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
        max_context_tokens: 128000, dynamically_loaded_tools: false,
      });
      await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
      return agent;
    };
    const [main, worker, explorer, approver, runner] = await Promise.all(['main', 'worker', 'explorer', 'approver', 'runner'].map(prepare));
    vi.spyOn(explorer!.accessor.get(IAgentToolPolicyService), 'isToolActive').mockImplementation((toolName) => !toolName.startsWith('mcp__'));
    type Agent = NonNullable<typeof main>;
    const reminders = (agent: Agent) => agent.accessor.get(IAgentLoopService).history()
      .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === DESKTOP_BROWSER_REMINDER_VARIANT)
      .map((message) => JSON.stringify(message.content));
    let turnId = 0;
    const call = async (agent: Agent) => {
      turnId += 1;
      const executor = agent.accessor.get(IAgentToolExecutorService);
      const toolCall = { type: 'function' as const, id: `call-${turnId}`, name, arguments: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' }) };
      const result = await executor.executor.execute(toolCall, { origin: 'loop', turnId });
      if ('detached' in result) throw new Error('unexpected detached tool result');
      return {
        output: result.content.every((part) => part.type === 'text') ? result.content.map((part) => part.type === 'text' ? part.text : '').join('') : result.content,
        isError: result.outcome.type === 'success' ? undefined : true,
      };
    };
    const expectUnavailableGuidance = (result: Awaited<ReturnType<typeof call>>, reason: string) => {
      expect(result.isError).toBe(true);
      const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      expect(output).toContain(reason);
      expect(output).toContain('For a one-off lookup of public information, prefer WebSearch or FetchURL');
      expect(output).toContain('To view or operate a page, use WebBridge');
      expect(output).toContain("verify that CU's browser extension and local service are connected");
      expect(output).toContain('tell the user (or your parent agent) that the built-in browser is unavailable and why.');
      expect(output).not.toContain(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE);
    };
    const expectRestrictedGuidance = (result: Awaited<ReturnType<typeof call>>, reason: string) => {
      expect(result.isError).toBe(true);
      const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      expect(output).toContain(reason);
      expect(output).toContain(DESKTOP_BROWSER_RESTRICTED_GUIDANCE);
      expect(output).not.toContain('To view or operate a page, use WebBridge');
      expect(output).not.toContain('then tell the user and use CU');
      expect(output).not.toContain(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE);
    };

    for (const agent of [main!, worker!]) {
      await runReminderStep(agent.accessor.get(IAgentLoopService));
      expect(reminders(agent)).toHaveLength(1);
      expect(reminders(agent)[0]).toContain(DESKTOP_BROWSER_DISABLED_REMINDER.slice(0, 120));
      expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
      expect(DESKTOP_BROWSER_DISABLED_REMINDER).not.toContain('workaround');
      expect(DESKTOP_BROWSER_DISABLED_REMINDER).toContain("verify that CU's browser extension and local service are connected");
      expect(agent.accessor.get(IAgentToolRegistryService).resolve(name)).toBeUndefined();
      expectUnavailableGuidance(await call(agent), 'turned off in Kimi Code Settings > Browser');
    }
    expect(DESKTOP_BROWSER_DISABLED_ERROR).toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    expect(DESKTOP_BROWSER_DISABLED_ERROR).not.toContain('workaround');

    control.set(true);
    subagentControl.set(true);
    for (const agent of [explorer!, approver!, runner!]) {
      await vi.waitFor(() => expect(agent.accessor.get(IAgentToolRegistryService).resolve(name)).toBeDefined());
    }
    expectRestrictedGuidance(await call(explorer!), 'tool policy of this agent does not allow');

    const approval = approver!.accessor.get(IAgentToolApprovalService);
    approver!.accessor.get(IAgentToolExecutorService).registerLegacyStarting((event) => {
      event.veto({ output: approval.formatApprovalRejectionMessage(name, { decision: 'rejected' }), isError: true });
    });
    const rejected = await call(approver!);
    expect(rejected.isError).toBe(true);
    expect(rejected.output).toContain('was not run because the user rejected the approval request');
    expect(rejected.output).toContain(DESKTOP_BROWSER_APPROVAL_REJECTED_GUIDANCE);
    expect(rejected.output).not.toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);

    runner!.accessor.get(IAgentPermissionModeService).setMode('yolo');
    const runnerLoop = runner!.accessor.get(IAgentLoopService);
    const runnerBase = runnerLoop.snapshot();
    vi.spyOn(runnerLoop, 'snapshot').mockImplementation(() => ({ ...runnerBase, state: 'running', activeTurnId: turnId }));
    const allowed = await call(runner!);
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed.output)).toContain('browser.get_state');
    expect(JSON.stringify(allowed.output)).not.toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    await runReminderStep(worker!.accessor.get(IAgentLoopService));
    expect(reminders(worker!)).toHaveLength(2);
    expect(reminders(worker!)[1]).not.toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    await runReminderStep(runner!.accessor.get(IAgentLoopService));
    expect(reminders(runner!)).toEqual([expect.stringContaining('Kimi Code Desktop built-in browser')]);
  } finally {
    registration.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);

it('injects trusted subagent runs through dynamic and direct tools without weakening restrictions', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  vi.mocked(runBrowserAutomation).mockClear();
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-subagent-runs-'));
  const control = createControl();
  const subagentControl = createControl();
  const access = createDesktopBrowserAccess(control, subagentControl);
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  const sessions = server.core.accessor.get(ISessionManager);
  const registration = registerDesktopBrowserMcp(server.core, browser.config, access);
  const name = 'mcp__desktop_browser__run';
  try {
    const session = await sessions.create({ workDir: home });
    await session.accessor.get(ISessionMcpHandle).ready;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const mainContext = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    type Agent = NonNullable<ReturnType<typeof lifecycle.handleOf>>;
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
      if (dynamic) expect(agent.accessor.get(IAgentToolSelectService).load([name]).toLoad).toEqual([name]);
      return { agent, activity };
    };
    let callSequence = 0;
    const call = async (agent: Agent, turnId: number, operation = 'browser.get_state') => {
      const toolCall = { type: 'function' as const, id: `call-${++callSequence}`, name, arguments: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation }) };
      const executor = agent.accessor.get(IAgentToolExecutorService);
      const result = await executor.executor.execute(toolCall, { origin: 'loop', turnId });
      if ('detached' in result) throw new Error('unexpected detached tool result');
      return {
        output: result.content.every((part) => part.type === 'text') ? result.content.map((part) => part.type === 'text' ? part.text : '').join('') : result.content,
        isError: result.outcome.type === 'success' ? undefined : true,
      };
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
    access.runs.onDidRevoke(revoked);
    worker.agent.accessor.get(IEventBus).publish(new TurnEnded({ agentId: 'worker', turnId: 7, reason: 'completed' }), workerContext);
    expect(revoked).toHaveBeenCalledWith(session.id, { agentId: 'worker', generation: workerContext.generation, turnId: 7 });
    worker.activity.running = false;
    const finished = await call(worker.agent, 7, 'browser.get_downloads');
    expect(finished.isError, JSON.stringify({ finished, calls: vi.mocked(runBrowserAutomation).mock.calls.length })).toBe(true);
    worker.activity.running = true;
    worker.activity.turnId = 9;
    expect((await call(worker.agent, 7, 'browser.get_history')).isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(2);

    const queued = await worker.agent.accessor.get(IAgentToolRegistryService).resolve(name)!.resolveExecution({ protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
    if (!('execute' in queued)) throw new Error('browser execution was not resolved');
    subagentControl.set(false);
    expect((await queued.execute({ turnId: 9, toolCallId: 'queued', signal: new AbortController().signal })).isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledTimes(2);

    const queuedDynamic = await worker.agent.accessor.get(IAgentToolRegistryService).resolve(name)!.resolveExecution({ protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
    const queuedDirect = await direct.agent.accessor.get(IAgentToolRegistryService).resolve(name)!.resolveExecution({ protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
    if (!('execute' in queuedDynamic) || !('execute' in queuedDirect)) throw new Error('queued browser execution was not resolved');
    subagentControl.set(true);
    expect((await queuedDynamic.execute({ turnId: 9, toolCallId: 'queued-dynamic', signal: new AbortController().signal })).isError).not.toBe(true);
    expect((await queuedDirect.execute({ turnId: 8, toolCallId: 'queued-direct', signal: new AbortController().signal })).isError).not.toBe(true);
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
    expect(JSON.stringify(subagentDisabled.output)).toContain('not currently running with built-in browser control enabled');
    expect(JSON.stringify(subagentDisabled.output)).toContain(DESKTOP_BROWSER_RESTRICTED_GUIDANCE);
    expect(JSON.stringify(subagentDisabled.output)).not.toContain(DESKTOP_BROWSER_BLOCKED_GUIDANCE);
    expect(JSON.stringify(subagentDisabled.output)).not.toContain('To view or operate a page, use WebBridge');
    expect(JSON.stringify(subagentDisabled.output)).not.toContain('then tell the user and use CU');
    expect(JSON.stringify(subagentDisabled.output)).not.toContain('workaround');
    expect(runBrowserAutomation).toHaveBeenCalledTimes(4);
    subagentControl.set(true);
    expect(browserControlOwnership.isBlocked(session.id, workerRun)).toBe(false);
    const resumed = await worker.agent.accessor.get(IAgentToolRegistryService).resolve(name)!.resolveExecution({ protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
    if (!('execute' in resumed)) throw new Error('browser execution was not resolved');
    expect((await resumed.execute({ turnId: 9, toolCallId: 'resumed', signal: new AbortController().signal })).isError).not.toBe(true);
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
    registration.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);

it('attaches trusted identity to an eligible subagent scope that already exists', async () => {
  vi.stubEnv('KIMI_CODE_PERSISTENCE_MINIDB_READMODEL', 'false');
  vi.stubEnv('KIMI_CODE_SEARCH_WORKER', 'false');
  vi.mocked(runBrowserAutomation).mockClear();
  const home = await mkdtemp(join(tmpdir(), 'desktop-browser-existing-subagent-'));
  const access = createDesktopBrowserAccess(createControl(), createControl());
  const browser = await startDesktopBrowserMcp({ access });
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env },
  });
  let registration: ReturnType<typeof registerDesktopBrowserMcp> | undefined;
  try {
    const sessions = server.core.accessor.get(ISessionManager);
    const session = await sessions.create({
      sessionId: 'existing-session',
      workDir: home,
      mcpServers: { desktop_browser: { ...browser.config, headers: { ...browser.config.headers, 'X-Kimi-Session-Id': 'existing-session' } } },
    });
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const context = await lifecycle.create({ agentId: 'existing' });
    const agent = lifecycle.handleOf('existing')!;
    const profile = agent.accessor.get(IAgentProfileService);
    const data = profile.data();
    vi.spyOn(profile, 'data').mockReturnValue({ ...data, profileName: 'coder' });
    vi.spyOn(profile, 'getModelCapabilities').mockReturnValue({
      image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
      max_context_tokens: 128000, dynamically_loaded_tools: false,
    });
    const loop = agent.accessor.get(IAgentLoopService);
    const base = loop.snapshot();
    vi.spyOn(loop, 'snapshot').mockReturnValue({ ...base, state: 'running', activeTurnId: 12 });
    await agent.accessor.get(IAgentMcpService).waitForInitialLoad();
    await vi.waitFor(() => expect(agent.accessor.get(IAgentToolRegistryService).resolve('mcp__desktop_browser__run')).toBeDefined());
    registration = registerDesktopBrowserMcp(server.core, browser.config, access);
    const run = { agentId: 'existing', generation: context.generation, turnId: 12 };
    await vi.waitFor(() => expect(access.runs.resolve(session.id, run)).not.toBeNull());
    const tool = agent.accessor.get(IAgentToolRegistryService).resolve('mcp__desktop_browser__run')!;
    const execution = await tool.resolveExecution({ protocol: 'kimi.browser/1.0.0', operation: 'browser.get_state' });
    if (!('execute' in execution)) throw new Error('browser execution was not resolved');
    expect((await execution.execute({ turnId: 12, toolCallId: 'existing-call', signal: new AbortController().signal })).isError).not.toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operation: 'browser.get_state' }), expect.any(AbortSignal), session.id,
      expect.objectContaining({ run, profile: 'coder' }),
    );
  } finally {
    registration?.dispose();
    await server.close();
    await browser.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30000);
