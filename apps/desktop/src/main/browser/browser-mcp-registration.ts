import type { AgentContext, ContextInjectionContext, ContextMessage, ExecutableTool, IAgentScopeHandle, IDisposable, ISessionScopeHandle, Scope, ToolDidExecuteContext } from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentProfileService,
  IAgentReminderService,
  IAgentToolExecutorService,
  IAgentToolRegistryService,
  IAgentToolSelectService,
  IEventBus,
  ISessionMcpHandle,
  MAIN_AGENT_ID,
  SELECT_TOOLS_TOOL_NAME,
  SubagentSpawned,
} from '@moonshot-ai/agent-core-v2';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { ISessionEphemeralMcpServers } from '@moonshot-ai/agent-core-v2/session/mcp/ephemeralMcpServers';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { legacyDidExecuteContext, legacyRejectedResult, type LegacyAfterContext, type LegacyDecisionContext } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/legacyHooks';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { ISessionMetadata, type AgentMeta } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import type { DesktopBrowserAccess, DesktopBrowserAgentControl, DesktopBrowserMcpHandle } from './browser-mcp';
import { DESKTOP_BROWSER_CONTROL_OFF_REASON, DESKTOP_BROWSER_UNAVAILABLE_NOTICE, describeBlockedDesktopBrowser } from './browser-mcp';
import { BrowserSubagentRunRegistry, DESKTOP_BROWSER_SUBAGENT_RUN, type DesktopBrowserSubagentRun } from './browser-subagent-control';
import { restoreBrowserSubagentRuns, revokeBrowserSubagentRun } from './browser-control';
import type { BrowserControlTrigger, BrowserMcpReconnectEvent } from '../diagnostics/telemetry-events';
import { trySendDesktopEvent } from '../diagnostics/track';

export const DESKTOP_BROWSER_MCP_SERVER = 'desktop_browser';
export const DESKTOP_BROWSER_REMINDER_VARIANT = 'desktop_browser';
const DESKTOP_BROWSER_TOOL_PREFIX = `mcp__${DESKTOP_BROWSER_MCP_SERVER}__`;
const DESKTOP_BROWSER_RUN_TOOL = `${DESKTOP_BROWSER_TOOL_PREFIX}run`;

export const DESKTOP_BROWSER_ENABLED_REMINDER = 'For web and browser tasks, use the built-in browser of Kimi Code Desktop: call select_tools with `mcp__desktop_browser__run` to load it. Use the kimi-webbridge skill only when the user explicitly asks to use their own Chrome or Edge browser, or sessions they are logged into there.';
export const DESKTOP_BROWSER_DIRECT_REMINDER = 'For web and browser tasks, use the built-in browser of Kimi Code Desktop: call `mcp__desktop_browser__run`. Use the kimi-webbridge skill only when the user explicitly asks to use their own Chrome or Edge browser, or sessions they are logged into there.';
export const DESKTOP_BROWSER_DISABLED_REMINDER = describeBlockedDesktopBrowser('The user turned off agent control of the built-in browser in Kimi Code Settings > Browser, so `mcp__desktop_browser__run` is unavailable. Do not try to load or call it.');

const SUBAGENT_CONTROL_DISABLED: DesktopBrowserAgentControl = { enabled: () => false, onDidChange: () => () => {} };

export interface DesktopBrowserSessionAccess extends DesktopBrowserAccess {
  readonly control: DesktopBrowserAgentControl;
  readonly subagentControl: DesktopBrowserAgentControl;
  readonly kept: Set<string>;
  readonly runs: BrowserSubagentRunRegistry;
  resolveRun(sessionId: string | undefined, run: BrowserSubagentRun): DesktopBrowserSubagentRun | null;
}

export function createDesktopBrowserAccess(
  control: DesktopBrowserAgentControl,
  subagentControl: DesktopBrowserAgentControl = SUBAGENT_CONTROL_DISABLED,
): DesktopBrowserSessionAccess {
  const kept = new Set<string>();
  const runs = new BrowserSubagentRunRegistry(() => control.enabled() && subagentControl.enabled());
  return {
    control,
    subagentControl,
    kept,
    runs,
    allows: (sessionId) => control.enabled() || (sessionId !== undefined && kept.has(sessionId)),
    resolveRun: (sessionId, run) => sessionId === undefined ? null : runs.resolve(sessionId, run),
  };
}

interface BrowserReminderDisclosure {
  readonly enabled: boolean;
}

function browserReminder(access: DesktopBrowserAccess, sessionId: string, loadsTools: () => boolean) {
  const enabledReminder = () => (loadsTools() ? DESKTOP_BROWSER_ENABLED_REMINDER : DESKTOP_BROWSER_DIRECT_REMINDER);
  return (context: ContextInjectionContext<BrowserReminderDisclosure>) => {
    const enabled = access.allows(sessionId);
    if (context.lastInjection !== undefined && context.lastDisclosure?.enabled === enabled) return undefined;
    return {
      content: enabled ? enabledReminder() : DESKTOP_BROWSER_DISABLED_REMINDER,
      disclosure: { enabled },
    };
  };
}

function blockedBrowserReason(context: ToolDidExecuteContext, allowed: boolean): string | undefined {
  const name = context.toolCall.name;
  const output = context.result.output;
  if (!name.startsWith(DESKTOP_BROWSER_TOOL_PREFIX) || typeof output !== 'string') return undefined;
  if (output.includes(DESKTOP_BROWSER_UNAVAILABLE_NOTICE)) return undefined;
  if (!allowed && output.startsWith(`Tool "${name}" not found`)) return DESKTOP_BROWSER_CONTROL_OFF_REASON;
  if (output.startsWith(`Tool "${name}" is disabled by the active tool policy`)) {
    return `The tool policy of this agent does not allow \`${name}\`, so the built-in browser is unavailable here.`;
  }
  if (context.outcome === 'vetoed' && output.startsWith(`Tool "${name}" was not run because the`)) return output;
  return undefined;
}

function guideBlockedBrowserCalls(access: DesktopBrowserAccess, sessionId: string) {
  return (context: LegacyAfterContext) => {
    const reason = blockedBrowserReason(legacyDidExecuteContext(context), access.allows(sessionId));
    return reason === undefined ? undefined : legacyRejectedResult(context, describeBlockedDesktopBrowser(reason));
  };
}

function loadsToolsOnDemand(handle: IAgentScopeHandle): boolean {
  try {
    return handle.accessor.get(IAgentToolSelectService).enabled();
  } catch {
    return true;
  }
}

function decorateSubagentBrowserTool(
  handle: IAgentScopeHandle,
  context: AgentContext,
): IDisposable {
  const registry = handle.accessor.get(IAgentToolRegistryService);
  const originalResolve = registry.resolve.bind(registry);
  const hook = handle.accessor.get(IAgentToolExecutorService).registerHook({
    starting: async (executionContext: LegacyDecisionContext) => {
      if (executionContext.call.name !== DESKTOP_BROWSER_RUN_TOOL || executionContext.prepared.kind !== 'execute') return;
      const args = executionContext.args;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
      const tool = originalResolve(DESKTOP_BROWSER_RUN_TOOL);
      if (tool === undefined) return;
      const run: BrowserSubagentRun = { agentId: context.agentId, generation: context.generation, turnId: executionContext.context.turnId };
      const execution = await tool.resolveExecution({ ...args, [DESKTOP_BROWSER_SUBAGENT_RUN]: run });
      if (!('execute' in execution)) return;
      Object.assign(executionContext.prepared, {
        execution,
        accesses: execution.accesses,
        display: execution.display,
        description: execution.description,
        approvalRule: execution.approvalRule,
        matchesRule: execution.matchesRule,
      });
    },
  });
  const cache = new WeakMap<ExecutableTool, ExecutableTool>();
  const decorate = (tool: ExecutableTool): ExecutableTool => {
    const cached = cache.get(tool);
    if (cached !== undefined) return cached;
    const decorated: ExecutableTool = {
      ...tool,
      resolveExecution: async (args) => {
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          return tool.resolveExecution(args);
        }
        const run: BrowserSubagentRun = { agentId: context.agentId, generation: context.generation, turnId: 0 };
        const execution = await tool.resolveExecution({ ...args, [DESKTOP_BROWSER_SUBAGENT_RUN]: run });
        if (!('execute' in execution)) return execution;
        return {
          ...execution,
          execute: (executionContext) => {
            run.turnId = executionContext.turnId;
            return execution.execute(executionContext);
          },
        };
      },
    };
    cache.set(tool, decorated);
    return decorated;
  };
  const resolve: typeof registry.resolve = (name) => {
    const tool = originalResolve(name);
    return name === DESKTOP_BROWSER_RUN_TOOL && tool !== undefined ? decorate(tool) : tool;
  };
  registry.resolve = resolve;
  return { dispose: () => { hook.dispose(); if (registry.resolve === resolve) registry.resolve = originalResolve; } };
}

function mentionsBrowserTool(text: string | null): boolean {
  return text !== null && text.includes(DESKTOP_BROWSER_TOOL_PREFIX);
}

function toolResults(history: readonly ContextMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of history) {
    if (message.role !== 'tool' || message.toolCallId === undefined) continue;
    results.set(message.toolCallId, message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
  }
  return results;
}

function browserCallRefused(name: string, result: string): boolean {
  return result.startsWith(`Tool "${name}" not found`)
    || result.startsWith(`Tool "${name}" is available but not loaded`)
    || result.includes(DESKTOP_BROWSER_UNAVAILABLE_NOTICE);
}

function selectionReachedBrowser(result: string): boolean {
  return result.split('\n').some((line) => !line.startsWith('Unknown tool: ') && mentionsBrowserTool(line));
}

function hasBrowserToolSchema(history: readonly ContextMessage[]): boolean {
  return history.some((message) => message.role === 'system'
    && (message.tools ?? []).some((tool) => tool.name.startsWith(DESKTOP_BROWSER_TOOL_PREFIX)));
}

function sessionUsedBrowser(session: ISessionScopeHandle): boolean {
  try {
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    for (const agent of lifecycle.list()) {
      const history = lifecycle.handleOf(agent.agentId)?.accessor.get(IAgentLoopService).history() ?? [];
      if (hasBrowserToolSchema(history)) return true;
      const results = toolResults(history);
      for (const message of history) {
        if (message.role !== 'assistant') continue;
        for (const call of message.toolCalls) {
          const result = results.get(call.id);
          if (call.name.startsWith(DESKTOP_BROWSER_TOOL_PREFIX)) {
            if (result === undefined || !browserCallRefused(call.name, result)) return true;
          } else if (call.name === SELECT_TOOLS_TOOL_NAME && mentionsBrowserTool(call.arguments)) {
            if (result === undefined || selectionReachedBrowser(result)) return true;
          }
        }
      }
    }
  } catch {}
  return false;
}

function reconnectBrowser(session: ISessionScopeHandle, allowed: () => boolean, reason: BrowserMcpReconnectEvent['reason']): void {
  let retried = false;
  const report = (ok: boolean): void => {
    trySendDesktopEvent('browser_mcp_reconnect', { reason, retried, ok, session_id: session.id });
  };
  try {
    const manager = session.accessor.get(ISessionMcpHandle).connectionManager;
    const joined = manager.get(DESKTOP_BROWSER_MCP_SERVER)?.status === 'pending';
    void manager.reconnect(DESKTOP_BROWSER_MCP_SERVER).then(() => {
      if (!joined) return;
      const listed = (manager.resolved(DESKTOP_BROWSER_MCP_SERVER)?.tools.length ?? 0) > 0;
      if (listed === allowed()) return;
      retried = true;
      return manager.reconnect(DESKTOP_BROWSER_MCP_SERVER);
    }).then(
      () => report(manager.get(DESKTOP_BROWSER_MCP_SERVER)?.status === 'connected'),
      () => report(false),
    );
  } catch {
    report(false);
  }
}

export function registerDesktopBrowserMcp(
  core: Scope,
  config: DesktopBrowserMcpHandle['config'],
  access: DesktopBrowserSessionAccess,
): IDisposable {
  const { control, kept } = access;
  const sessions = core.accessor.get(ISessionManager);
  if (sessions.onWillCreateSession === undefined || sessions.onDidCreateSession === undefined) {
    throw new Error('Session creation hooks are unavailable');
  }
  const attached = new Map<string, () => void>();
  let disposed = false;

  const attachSession = (session: ISessionScopeHandle): void => {
    if (disposed || attached.has(session.id)) return;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const agents = new Map<string, IDisposable>();
    const spawned = session.accessor.get(ISessionEventBus).subscribe(SubagentSpawned, (event) => {
      const context = lifecycle.get(event.subagentId);
      if (context !== undefined) access.runs.describe(session.id, event.subagentId, context.generation, event.description);
    });
    const attachAgent = (context: AgentContext, handle: IAgentScopeHandle | undefined, meta?: AgentMeta): void => {
      const agentId = context.agentId;
      if (handle === undefined || agents.has(agentId)) return;
      const provider = browserReminder(access, session.id, () => loadsToolsOnDemand(handle));
      const reminder = handle.accessor.get(IAgentReminderService).register(DESKTOP_BROWSER_REMINDER_VARIANT, provider);
      const guidance = handle.accessor.get(IAgentToolExecutorService).registerHook({
        afterExecute: guideBlockedBrowserCalls(access, session.id),
      });
      let decoration: IDisposable | undefined;
      let ended: IDisposable | undefined;
      if (agentId !== MAIN_AGENT_ID && meta?.type === 'sub' && meta.labels?.['btw'] !== 'true') {
        access.runs.attach(session.id, {
          agentId,
          generation: context.generation,
          state: () => {
            try {
              const loop = handle.accessor.get(IAgentLoopService).snapshot();
              const profile = handle.accessor.get(IAgentProfileService).data().profileName;
              return { running: loop.state === 'running', turnId: loop.activeTurnId, profile, eligible: profile !== 'explore' };
            } catch {
              return { running: false, eligible: false };
            }
          },
        });
        decoration = decorateSubagentBrowserTool(handle, context);
        ended = handle.accessor.get(IEventBus).subscribe(TurnEnded, (event) => {
          access.runs.finish(session.id, { agentId, generation: context.generation, turnId: event.turnId });
        });
      }
      agents.set(agentId, { dispose: () => { ended?.dispose(); decoration?.dispose(); guidance.dispose(); reminder.dispose(); } });
    };
    const created = lifecycle.onDidCreateScope(({ context, handle, meta }) => attachAgent(context, handle, meta));
    const closed = lifecycle.onDidClose((context) => {
      agents.get(context.agentId)?.dispose();
      agents.delete(context.agentId);
      access.runs.closeAgent(session.id, context.agentId, context.generation);
    });
    attached.set(session.id, () => {
      spawned.dispose();
      created.dispose();
      closed.dispose();
      for (const registration of agents.values()) registration.dispose();
      agents.clear();
      access.runs.closeSession(session.id);
    });
    const existing = lifecycle.list();
    for (const agent of existing) {
      if (agent.agentId === MAIN_AGENT_ID) attachAgent(agent, lifecycle.handleOf(agent.agentId), { type: 'main' });
    }
    void session.accessor.get(ISessionMetadata).read().then((metadata) => {
      if (disposed || !attached.has(session.id)) return;
      for (const agent of existing) attachAgent(agent, lifecycle.handleOf(agent.agentId), metadata.agents?.[agent.agentId]);
    }, () => {
      if (disposed || !attached.has(session.id)) return;
      for (const agent of existing) attachAgent(agent, lifecycle.handleOf(agent.agentId));
    });
  };
  const detachSession = (sessionId: string): void => {
    attached.get(sessionId)?.();
    attached.delete(sessionId);
    kept.delete(sessionId);
  };
  const onDidCreateSession = (session: ISessionScopeHandle): void => {
    attachSession(session);
    if (disposed || control.enabled() || kept.has(session.id) || !sessionUsedBrowser(session)) return;
    kept.add(session.id);
    reconnectBrowser(session, () => access.allows(session.id), 'session_create');
  };
  let revokeTrigger: BrowserControlTrigger | undefined;
  const syncSubagentRuns = (): void => {
    if (control.enabled() && access.subagentControl.enabled()) {
      restoreBrowserSubagentRuns();
      return;
    }
    revokeTrigger = 'ipc';
    try {
      access.runs.revokeAll();
    } finally {
      revokeTrigger = undefined;
    }
  };
  const onDidChangeControl = (enabled: boolean): void => {
    syncSubagentRuns();
    for (const session of sessions.list()) {
      if (kept.has(session.id)) continue;
      if (!enabled && sessionUsedBrowser(session)) {
        kept.add(session.id);
        continue;
      }
      reconnectBrowser(session, () => access.allows(session.id), 'setting_change');
    }
    if (enabled) kept.clear();
  };

  const subscriptions: IDisposable[] = [
    sessions.onWillCreateSession((event) => {
      event.contributeSeed(ISessionEphemeralMcpServers, {
        ...event.readSeed(ISessionEphemeralMcpServers),
        [DESKTOP_BROWSER_MCP_SERVER]: { ...config, deferred: true, headers: { ...config.headers, 'X-Kimi-Session-Id': event.sessionId } },
      });
    }),
    sessions.onDidCreateSession((event) => onDidCreateSession(event.handle)),
    { dispose: control.onDidChange(onDidChangeControl) },
    { dispose: access.subagentControl.onDidChange(syncSubagentRuns) },
    { dispose: access.runs.onDidRevoke((sessionId, run) => revokeBrowserSubagentRun(sessionId, run, revokeTrigger)) },
  ];
  if (sessions.onDidCloseSession !== undefined) {
    subscriptions.push(sessions.onDidCloseSession(({ sessionId }) => detachSession(sessionId)));
  }
  for (const session of sessions.list()) attachSession(session);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      for (const sessionId of attached.keys()) detachSession(sessionId);
      kept.clear();
    },
  };
}
