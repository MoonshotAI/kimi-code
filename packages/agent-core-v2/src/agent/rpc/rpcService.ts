import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentGoalService } from '#/agent/goal/goal';
import type { PluginCommandActivatedEvent } from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { expandCommandArguments } from '#/app/plugin/commands';
import { IPluginService } from '#/app/plugin/plugin';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentShellCommandService } from '#/agent/shellCommand/shellCommand';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionBtwService } from '#/session/btw/btw';
import { IAgentSkillService } from '#/agent/skill/skill';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type {
  ActivatePluginCommandPayload,
  ActivateSkillPayload,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CreateGoalPayload,
  DetachTaskPayload,
  EmptyPayload,
  EnterSwarmPayload,
  GetTaskOutputPayload,
  GetTasksPayload,
  PromptLaunchResult,
  PromptPayload,
  RegisterToolPayload,
  RunShellCommandPayload,
  ShellCommandResult,
  CancelShellCommandPayload,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SteerPayload,
  StopTaskPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
} from './core-api';
import { IAgentRPCService } from './rpc';
import {
  applyPromptMetadataUpdate,
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
} from './prompt-metadata';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'plugin_command.activated': PluginCommandActivatedEvent;
  }
}

export class AgentRPCService implements IAgentRPCService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IAgentShellCommandService private readonly shellCommand: IAgentShellCommandService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IAgentPermissionGate private readonly permission: IAgentPermissionGate,
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentUserToolService private readonly userTools: IAgentUserToolService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IEventBus private readonly eventBus: IEventBus,
    @IEventService private readonly eventService: IEventService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionBtwService private readonly btw: ISessionBtwService,
  ) { }

  async prompt(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
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

  async runShellCommand(payload: RunShellCommandPayload): Promise<ShellCommandResult> {
    return this.shellCommand.run(payload);
  }

  cancelShellCommand(payload: CancelShellCommandPayload): void {
    this.shellCommand.cancel(payload.commandId);
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
      this.telemetry.track2('cancel', { from: 'streaming' });
    }
    this.loop.cancel(turnId);
  }

  undoHistory(payload: UndoHistoryPayload): number {
    const undone = this.promptService.undo(payload.count);
    this.telemetry.track2('conversation_undo', { count: payload.count });
    return undone;
  }

  setThinking(payload: SetThinkingPayload): void {
    this.profile.setThinking(payload.level);
  }

  setPermission(payload: SetPermissionPayload): void {
    const wasYolo = this.permissionMode.mode === 'yolo';
    const wasAuto = this.permissionMode.mode === 'auto';
    this.permissionMode.setMode(payload.mode);
    const enabled = this.permissionMode.mode === 'yolo';
    if (enabled !== wasYolo) {
      this.telemetry.track2('yolo_toggle', { enabled });
    }
    const afkEnabled = this.permissionMode.mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry.track2('afk_toggle', { enabled: afkEnabled });
    }
  }

  setModel(payload: SetModelPayload) {
    return this.profile.setModel(payload.model);
  }

  getModel(_payload: EmptyPayload): string {
    return this.profile.getModel();
  }

  enterPlan(_payload: EmptyPayload): Promise<void> {
    return this.planMode.enter();
  }

  cancelPlan(payload: CancelPlanPayload): void {
    this.planMode.cancel(payload.id);
  }

  clearPlan(_payload: EmptyPayload): Promise<void> {
    return this.planMode.clear();
  }

  enterSwarm(payload: EnterSwarmPayload): void {
    this.swarmMode.enter(payload.trigger);
  }

  exitSwarm(_payload: EmptyPayload): void {
    this.swarmMode.exit();
  }

  getSwarmMode(_payload: EmptyPayload): boolean {
    return this.swarmMode.isActive;
  }

  startBtw(_payload: EmptyPayload): Promise<string> {
    return this.btw.start();
  }

  beginCompaction(payload: BeginCompactionPayload): void {
    this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
  }

  cancelCompaction(_payload: EmptyPayload): void {
    const active = this.fullCompaction.compacting;
    if (active !== null) {
      this.telemetry.track2('cancel', { from: 'compacting' });
    }
    active?.abortController.abort();
  }

  registerTool(payload: RegisterToolPayload): void {
    this.userTools.register(payload);
  }

  unregisterTool(payload: UnregisterToolPayload): void {
    this.userTools.unregister(payload.name);
  }

  setActiveTools(payload: SetActiveToolsPayload): void {
    this.profile.update({ activeToolNames: payload.names });
  }

  stopTask(payload: StopTaskPayload): void {
    void this.tasks.stop(payload.taskId, payload.reason);
  }

  detachTask(payload: DetachTaskPayload) {
    return this.tasks.detach(payload.taskId);
  }

  clearContext(_payload: EmptyPayload): void {
    this.promptService.clear();
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

  createGoal(payload: CreateGoalPayload) {
    return this.goal.createGoal(payload);
  }

  getGoal(_payload: EmptyPayload) {
    return this.goal.getGoal();
  }

  pauseGoal(_payload: EmptyPayload) {
    return this.goal.pauseGoal();
  }

  resumeGoal(_payload: EmptyPayload) {
    return this.goal.resumeGoal();
  }

  cancelGoal(_payload: EmptyPayload) {
    return this.goal.cancelGoal();
  }

  getTaskOutput(payload: GetTaskOutputPayload): Promise<string> {
    return this.tasks.readOutput(payload.taskId, payload.tail);
  }

  getContext(_payload: EmptyPayload) {
    return {
      history: this.context.get(),
      tokenCount: this.contextSize.get().measured,
    };
  }

  getConfig(_payload: EmptyPayload) {
    return this.profile.data();
  }

  getPermission(_payload: EmptyPayload) {
    return this.permission.data();
  }

  getPlan(_payload: EmptyPayload) {
    return this.planMode.status();
  }

  getUsage(_payload: EmptyPayload) {
    return this.usage.status();
  }

  getTools(_payload: EmptyPayload) {
    return this.toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      active: this.profile.isToolActive(tool.name, tool.source),
      source: tool.source,
    }));
  }

  getTasks(payload: GetTasksPayload) {
    return this.tasks.list(payload.activeOnly ?? false, payload.limit);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRPCService,
  AgentRPCService,
  InstantiationType.Delayed,
  'rpc',
);
