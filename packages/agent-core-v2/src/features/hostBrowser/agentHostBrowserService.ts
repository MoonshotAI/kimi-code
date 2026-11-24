import { IInstantiationService } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { environmentTempTarget, IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { legacyDidExecuteContext, legacyRejectedResult, type LegacyAfterContext } from '#/agent/toolExecutor/legacyHooks';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionContext } from '#/features/reminder/types';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableTool } from '#/tool/toolContract';

import { ISessionHostBrowserService, type IAgentHostBrowserService, type IHostBrowser } from './hostBrowser';

export const HOST_BROWSER_REMINDER_VARIANT = 'desktop_browser';
export const HOST_BROWSER_DIALOGS_REMINDER_VARIANT = 'desktop-browser-dialogs';

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
  ) {
    super();
    const host = session.host;
    if (host === undefined) return;
    const sessionId = sessionContext.sessionId;
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
          const result = await host.run({
            sessionId,
            args,
            signal: context.signal,
            ...(subagent ? { run: { agentId, generation, turnId: context.turnId } } : {}),
          });
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
