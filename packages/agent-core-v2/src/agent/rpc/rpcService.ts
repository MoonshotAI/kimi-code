import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { expandCommandArguments } from '#/app/plugin/commands';
import { IPluginService } from '#/app/plugin/plugin';
import { ProfileError } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentSkillService } from '#/agent/skill/skill';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import type {
  ActivatePluginCommandPayload,
  ActivateSkillPayload,
  CancelPayload,
  EmptyPayload,
  PromptLaunchResult,
  PromptPayload,
  SetPermissionPayload,
  SteerPayload,
  UndoHistoryPayload,
} from './core-api';
import { IAgentRPCService } from './rpc';
import {
  applyPromptMetadataUpdate,
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
} from './prompt-metadata';

export interface PluginCommandActivatedEvent {
  readonly type: 'plugin_command.activated';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'plugin_command.activated': PluginCommandActivatedEvent;
  }
}

export class AgentRPCService implements IAgentRPCService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IEventService private readonly eventService: IEventService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) { }

  async prompt(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    if (payload.disabledTools !== undefined) {
      try {
        await this.toolPolicy.setSessionDisabledTools(payload.disabledTools);
      } catch (error) {
        if (error instanceof ProfileError) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
        }
        throw error;
      }
    }
    await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    const handle = await this.promptService.enqueue({ message: {
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
      origin: { kind: 'user' },
    } });
    if (handle.state === 'pending') return undefined;
    const turn = await handle.launched;
    return turn === undefined ? undefined : { turn_id: turn.id };
  }

  async steer(payload: SteerPayload): Promise<PromptLaunchResult | undefined> {
    this.telemetry.track2('input_steer', { parts: payload.input.length });
    const queued = await this.promptService.enqueue({ message: {
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    } });
    const [steered] = await this.promptService.steer([queued.id]);
    const turn = await steered?.launched;
    return turn === undefined ? undefined : { turn_id: turn.id };
  }

  cancel({ turnId }: CancelPayload): void {
    if (this.loop.status().state === 'running') {
      this.telemetry.track2('cancel', {
        from: 'streaming',
        trace_id: this.loop.status().activeTraceId,
      });
    }
    this.loop.cancel(turnId);
  }

  undoHistory(payload: UndoHistoryPayload): number {
    const undone = this.promptService.undo(payload.count);
    this.telemetry.track2('conversation_undo', { count: payload.count });
    return undone;
  }

  setPermission(payload: SetPermissionPayload): void {
    const wasYolo = this.permissionMode.mode === 'yolo';
    const wasAuto = this.permissionMode.mode === 'auto';
    this.permissionMode.setMode(payload.mode);
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      this.agentLifecycle.broadcastPermissionMode(payload.mode);
    }
    const enabled = this.permissionMode.mode === 'yolo';
    if (enabled !== wasYolo) {
      this.telemetry.track2('yolo_toggle', { enabled });
    }
    const afkEnabled = this.permissionMode.mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry.track2('afk_toggle', { enabled: afkEnabled });
    }
  }

  cancelCompaction(_payload: EmptyPayload): void {
    const active = this.fullCompaction.compacting;
    if (active !== null) {
      this.telemetry.track2('cancel', {
        from: 'compacting',
        trace_id: active.traceId,
      });
    }
    active?.abortController.abort();
  }

  async activateSkill(payload: ActivateSkillPayload): Promise<void> {
    void this.skills.activate(payload);
    await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
  }

  async activatePluginCommand(payload: ActivatePluginCommandPayload): Promise<void> {
    const commands = await this.plugins.listPluginCommands();
    const def = commands.find(
      (command) => command.pluginId === payload.pluginId && command.name === payload.commandName,
    );
    if (def === undefined) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Plugin command "${payload.pluginId}:${payload.commandName}" was not found`,
      );
    }
    const commandArgs = payload.args ?? '';
    const expanded = expandCommandArguments(def.body, commandArgs);
    const origin = {
      kind: 'plugin_command' as const,
      activationId: randomUUID(),
      pluginId: payload.pluginId,
      commandName: payload.commandName,
      commandArgs: payload.args,
      trigger: 'user-slash' as const,
    };
    this.eventBus.publish({
      type: 'plugin_command.activated',
      activationId: origin.activationId,
      pluginId: origin.pluginId,
      commandName: origin.commandName,
      commandArgs: origin.commandArgs,
      trigger: origin.trigger,
    });
    await this.promptService.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: expanded }],
      toolCalls: [],
      origin,
    } });
    await this.updatePromptMetadata(promptMetadataTextFromPluginCommand(payload));
  }

  private async updatePromptMetadata(text: string | undefined): Promise<void> {
    await applyPromptMetadataUpdate(
      {
        metadata: this.metadata,
        eventService: this.eventService,
        sessionId: this.sessionContext.sessionId,
      },
      text,
    );
  }

  getContext(_payload: EmptyPayload) {
    return {
      history: this.context.get(),
      tokenCount: this.contextSize.get().measured,
    };
  }

  getTools(_payload: EmptyPayload) {
    return this.toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      active: this.toolPolicy.isToolActive(tool.name, tool.source),
      source: tool.source,
    }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRPCService,
  AgentRPCService,
  InstantiationType.Eager,
  'rpc',
);
