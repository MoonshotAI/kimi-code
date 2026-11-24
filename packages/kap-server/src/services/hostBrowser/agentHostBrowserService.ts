import { IInstantiationService } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import type { IDisposable } from '@moonshot-ai/agent-core-v2/_base/di/lifecycle';
import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { environmentTempTarget, IAgentEnvironmentService } from '@moonshot-ai/agent-core-v2/agent/environmentBinding/agentEnvironment';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { ISessionMediaStore } from '@moonshot-ai/agent-core-v2/agent/media/sessionMediaStore';
import { mcpResultToExecutableOutput } from '@moonshot-ai/agent-core-v2/agent/mcp/output';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentScopeContext } from '@moonshot-ai/agent-core-v2/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutor';
import { legacyDidExecuteContext, legacyRejectedResult, type LegacyAfterContext } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/legacyHooks';
import type { ToolDidExecuteContext } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '@moonshot-ai/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '@moonshot-ai/agent-core-v2/agent/toolSelect/toolSelect';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { MCP_SECTION, type McpSection } from '@moonshot-ai/agent-core-v2/app/mcpConfig/configSection';
import { ITelemetryService } from '@moonshot-ai/agent-core-v2/app/telemetry/telemetry';
import { IAgentReminderService } from '@moonshot-ai/agent-core-v2/features/reminder/reminderService';
import type { ContextInjectionContext } from '@moonshot-ai/agent-core-v2/features/reminder/types';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '@moonshot-ai/agent-core-v2/session/sessionContext/sessionContext';
import type { ExecutableTool } from '@moonshot-ai/agent-core-v2/tool/toolContract';

import { ISessionHostBrowserService, type IAgentHostBrowserService, type IHostBrowser } from './hostBrowser';

export const HOST_BROWSER_REMINDER_VARIANT = 'desktop_browser';
export const HOST_BROWSER_DIALOGS_REMINDER_VARIANT = 'desktop-browser-dialogs';

export const HOST_BROWSER_DEFAULT_TIMEOUT_MS = 60_000;

async function withDeadline<T>(timeoutMs: number, parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => deadline.abort(new Error('MCP error -32001: Request timed out')), timeoutMs);
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([run(signal), stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

interface HostBrowserDisclosure {
  readonly enabled: boolean;
}

export function blockedHostBrowserReason(
  host: Pick<IHostBrowser, 'tool' | 'messages'>,
  context: ToolDidExecuteContext,
  allowed: boolean,
): string | undefined {
  const name = context.toolCall.name;
  const output = context.result.output;
  if (name !== host.tool.name || typeof output !== 'string') return undefined;
  if (output.includes(host.messages.unavailableNotice)) return undefined;
  if (!allowed && output.startsWith(`Tool "${name}" not found`)) return host.messages.controlOffReason;
  if (output.startsWith(`Tool "${name}" is disabled by the active tool policy`)) {
    return `The tool policy of this agent does not allow \`${name}\`, so the built-in browser is unavailable here.`;
  }
  if (context.outcome === 'vetoed' && output.startsWith(`Tool "${name}" was not run because the`)) return output;
  return undefined;
}

export class AgentHostBrowserService extends Service implements IAgentHostBrowserService {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionHostBrowserService private readonly session: ISessionHostBrowserService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentReminderService reminders: IAgentReminderService,
    @IAgentToolExecutorService executor: IAgentToolExecutorService,
    @IEventBus eventBus: IEventBus,
    @ISessionMediaStore private readonly attachmentStore: ISessionMediaStore,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly configService: IConfigService,
  ) {
    super();
    const host = session.host;
    const sessionId = sessionContext.sessionId;
    this._register(registry.reserve(host.tool.name));
    this._register(reminders.register(HOST_BROWSER_REMINDER_VARIANT, (context: ContextInjectionContext<HostBrowserDisclosure>) => {
      const enabled = session.available();
      if (context.lastInjection !== undefined && context.lastDisclosure?.enabled === enabled) return undefined;
      const enabledReminder = this.loadsToolsOnDemand() ? host.messages.enabledReminder : host.messages.directReminder;
      return { content: enabled ? enabledReminder : host.messages.disabledReminder, disclosure: { enabled } };
    }));
    this._register(executor.registerHook({
      afterExecute: (context: LegacyAfterContext) => {
        const reason = blockedHostBrowserReason(host, legacyDidExecuteContext(context), session.available());
        return reason === undefined ? undefined : legacyRejectedResult(context, host.messages.describeBlocked(reason));
      },
    }));
    if (scope.agentId === MAIN_AGENT_ID) {
      this._register(reminders.register(HOST_BROWSER_DIALOGS_REMINDER_VARIANT, async (context: ContextInjectionContext) => {
        if (!context.isNewTurn) return undefined;
        return host.dialogReminder(sessionId);
      }));
    }
    if (this.isSubagent()) {
      const { agentId, generation } = scope.agentContext;
      host.attachSubagent(sessionId, {
        agentId,
        generation,
        state: () => {
          try {
            const snapshot = this.loop.snapshot();
            const profile = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentProfileService)).data().profileName;
            return { running: snapshot.state === 'running', turnId: snapshot.activeTurnId, profile, eligible: profile !== 'explore' };
          } catch {
            return { running: false, eligible: false };
          }
        },
      });
      this._register(eventBus.subscribe(TurnEnded, (event) => {
        host.finishSubagentTurn(sessionId, { agentId, generation, turnId: event.turnId });
      }));
      this._register({ dispose: () => host.closeSubagent(sessionId, agentId, generation) });
    }
    this._register(session.onDidChangeAvailability(() => this.syncTool(host)));
    this._register({ dispose: () => this.registration?.dispose() });
    this.syncTool(host);
  }

  private isSubagent(): boolean {
    const meta = this.scope.meta;
    return this.scope.agentId !== MAIN_AGENT_ID && meta?.type === 'sub' && meta.labels?.['btw'] !== 'true';
  }

  private loadsToolsOnDemand(): boolean {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IAgentToolSelectService)).enabled();
    } catch {
      return true;
    }
  }

  private syncTool(host: IHostBrowser): void {
    if (!this.session.available()) {
      this.registration?.dispose();
      this.registration = undefined;
      return;
    }
    if (this.registration !== undefined || this.registry.resolve(host.tool.name) !== undefined) return;
    this.registration = this.registry.register(this.createTool(host), { source: 'mcp', disclosure: 'deferred' });
  }

  private toolTimeoutMs(): number {
    return this.configService.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs ?? HOST_BROWSER_DEFAULT_TIMEOUT_MS;
  }

  private createTool(host: IHostBrowser): ExecutableTool {
    const { name, description, parameters } = host.tool;
    const sessionId = this.sessionContext.sessionId;
    const { agentId, generation } = this.scope.agentContext;
    const subagent = this.isSubagent();
    return {
      name,
      description,
      parameters,
      resolveExecution: (args) => ({
        approvalRule: name,
        execute: async (context) => {
          const result = await withDeadline(this.toolTimeoutMs(), context.signal, (signal) => host.run({
            sessionId,
            args,
            signal,
            ...(subagent ? { run: { agentId, generation, turnId: context.turnId } } : {}),
          }));
          return mcpResultToExecutableOutput(result, name, {
            signal: context.signal,
            attachmentStore: this.attachmentStore,
            originals: environmentTempTarget(this.environment, 'original-images'),
            telemetry: this.telemetry,
            providerType: this.loop.getModelProviderType(),
          });
        },
      }),
    };
  }
}
