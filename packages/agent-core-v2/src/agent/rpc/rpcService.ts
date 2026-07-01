import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBackgroundService } from '#/agent/background';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentFileToolsService } from '#/agent/fileTools';
import { IAgentFullCompactionService } from '#/agent/fullCompaction';
import { IAgentGoalService } from '#/agent/goal';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { ErrorCodes, KimiError } from '#/errors';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentPermissionGate } from '#/agent/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/agent/plan';
import { expandCommandArguments, IPluginService } from '#/app/plugin';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentQuestionToolsService } from '#/agent/questionTools';
import { ISessionMetadata, type SessionMetaPatch } from '#/session/session-metadata';
import { BashTool, IAgentShellToolsService } from '#/agent/shellTools';
import { IAgentSkillService } from '#/agent/skill';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { IExecContext } from '#/session/execContext';
import { ISessionProcessRunner } from '#/session/process';
import { IAgentToolService } from '#/agent/agentTool';
import { IAgentSwarmService } from '#/agent/swarm';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { ToolUpdate } from '#/agent/tool';
import { IAgentTurnService } from '#/agent/turn';
import { IAgentUsageService } from '#/agent/usage';
import { IAgentUserToolService } from '#/agent/userTool';
import { IAgentWebService } from '#/agent/web';
import type {
  ActivatePluginCommandPayload,
  ActivateSkillPayload,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CreateGoalPayload,
  DetachBackgroundPayload,
  EmptyPayload,
  EnterSwarmPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
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
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
} from './core-api';
import { IAgentRPCService } from './rpc';
import {
  promptMetadataTextFromPluginCommand,
  titleFromPromptMetadataText,
} from './prompt-metadata';

const SHELL_FOREGROUND_TIMEOUT_S = 2 * 60;

export class AgentRPCService implements IAgentRPCService {
  declare readonly _serviceBrand: undefined;
  private readonly shellCommandControllers = new Map<string, AbortController>();

  constructor(
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IAgentPermissionGate private readonly permission: IAgentPermissionGate,
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentUserToolService private readonly userTools: IAgentUserToolService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentFileToolsService private readonly fileTools: IAgentFileToolsService,
    @IAgentShellToolsService private readonly shellTools: IAgentShellToolsService,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IExecContext private readonly ctx: IExecContext,
    @IAgentBackgroundService private readonly background: IAgentBackgroundService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @IAgentToolService private readonly agentTool: IAgentToolService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentEventSinkService private readonly events: IAgentEventSinkService,
    @IAgentQuestionToolsService private readonly questionTools: IAgentQuestionToolsService,
    @IAgentWebService private readonly web: IAgentWebService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) { }

  prompt(payload: PromptPayload): PromptLaunchResult | undefined {
    const turn = this.promptService.prompt({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
    return turn === undefined ? undefined : { turn_id: turn.id };
  }

  private ensureBashTool() {
    const existing = this.toolRegistry.resolve('Bash');
    if (existing !== undefined) return existing;
    const bash = new BashTool(this.processRunner, this.env, this.ctx, this.background);
    this.toolRegistry.register(bash);
    return bash;
  }

  async runShellCommand(payload: RunShellCommandPayload): Promise<ShellCommandResult> {
    const bash = this.ensureBashTool();

    const controller = new AbortController();
    if (payload.commandId !== undefined) {
      this.shellCommandControllers.set(payload.commandId, controller);
    }

    let stdout = '';
    let stderr = '';
    try {
      const execution = await bash.resolveExecution({
        command: payload.command,
        timeout: SHELL_FOREGROUND_TIMEOUT_S,
      });
      if (execution.isError === true) {
        const output = typeof execution.output === 'string' ? execution.output : 'Command failed.';
        return { stdout: '', stderr: output, isError: true };
      }

      const result = await execution.execute({
        turnId: '',
        toolCallId: 'shell-command',
        signal: controller.signal,
        onUpdate: (update: ToolUpdate) => {
          if (update.kind === 'stdout') stdout += update.text ?? '';
          else if (update.kind === 'stderr') stderr += update.text ?? '';
          else return;
          if (payload.commandId !== undefined) {
            this.events.emit({ type: 'shell.output', commandId: payload.commandId, update });
          }
        },
        onForegroundTaskStart: (taskId: string) => {
          if (payload.commandId !== undefined) {
            this.events.emit({ type: 'shell.started', commandId: payload.commandId, taskId });
          }
        },
      });

      const isError = result.isError === true;
      if (typeof result.output === 'string' && result.output.startsWith('task_id: ')) {
        return { stdout: result.output, stderr: '', isError: false, backgrounded: true };
      }
      if (!isError && stdout.length === 0 && typeof result.output === 'string') {
        stdout = result.output;
      }
      if (isError && stdout.length === 0 && stderr.length === 0) {
        stderr = typeof result.output === 'string' ? result.output : 'Command failed.';
      }
      return { stdout, stderr, isError };
    } finally {
      if (payload.commandId !== undefined) {
        this.shellCommandControllers.delete(payload.commandId);
      }
    }
  }

  cancelShellCommand(payload: CancelShellCommandPayload): void {
    this.shellCommandControllers.get(payload.commandId)?.abort(userCancellationReason());
  }

  steer(payload: SteerPayload): PromptLaunchResult | undefined {
    this.telemetry.track('input_steer', { parts: payload.input.length });
    const turn = this.promptService.steer({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
    const id = turn?.id ?? this.turnService.getActiveTurn()?.id;
    return id === undefined ? undefined : { turn_id: id };
  }

  cancel({ turnId }: CancelPayload): void {
    if (this.turnService.getActiveTurn() !== undefined) {
      this.telemetry.track('cancel', { from: 'streaming' });
    }
    const turn = this.turnService.getActiveTurn();
    if (turn === undefined) return;
    if (turnId !== undefined && turn.id !== turnId) return;
    turn.abortController.abort(userCancellationReason());
  }

  undoHistory(payload: UndoHistoryPayload): number {
    return this.promptService.undo(payload.count);
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
      this.telemetry.track('yolo_toggle', { enabled });
    }
    const afkEnabled = this.permissionMode.mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry.track('afk_toggle', { enabled: afkEnabled });
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

  beginCompaction(payload: BeginCompactionPayload): void {
    this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
  }

  cancelCompaction(_payload: EmptyPayload): void {
    if (this.fullCompaction.isCompacting) {
      this.telemetry.track('cancel', { from: 'compacting' });
    }
    this.fullCompaction.cancel();
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

  stopBackground(payload: StopBackgroundPayload): void {
    void this.background.stop(payload.taskId, payload.reason);
  }

  detachBackground(payload: DetachBackgroundPayload) {
    return this.background.detach(payload.taskId);
  }

  clearContext(_payload: EmptyPayload): void {
    this.promptService.clear();
  }

  activateSkill(payload: ActivateSkillPayload): void {
    this.skills.activate(payload);
  }

  async activatePluginCommand(payload: ActivatePluginCommandPayload): Promise<void> {
    const commands = await this.plugins.listPluginCommands();
    const def = commands.find(
      (command) => command.pluginId === payload.pluginId && command.name === payload.commandName,
    );
    if (def === undefined) {
      throw new KimiError(
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
    this.events.emit({
      type: 'plugin_command.activated',
      activationId: origin.activationId,
      pluginId: origin.pluginId,
      commandName: origin.commandName,
      commandArgs: origin.commandArgs,
      trigger: origin.trigger,
    });
    this.promptService.prompt({
      role: 'user',
      content: [{ type: 'text', text: expanded }],
      toolCalls: [],
      origin,
    });
    await this.updatePluginCommandPromptMetadata(payload);
  }

  private async updatePluginCommandPromptMetadata(
    payload: ActivatePluginCommandPayload,
  ): Promise<void> {
    const text = promptMetadataTextFromPluginCommand(payload);
    if (text === undefined) return;
    const current = await this.metadata.read();
    const patch: { lastPrompt: string; title?: string; isCustomTitle?: boolean } = {
      lastPrompt: text,
    };
    if (!current.isCustomTitle && isUntitled(current.title)) {
      patch.title = titleFromPromptMetadataText(text);
      patch.isCustomTitle = false;
    }
    await this.metadata.update(patch satisfies SessionMetaPatch);
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

  getBackgroundOutput(payload: GetBackgroundOutputPayload): Promise<string> {
    return this.background.readOutput(payload.taskId, payload.tail);
  }

  getContext(_payload: EmptyPayload) {
    return {
      history: this.context.get(),
      tokenCount: this.contextSize.getStatus().contextTokens,
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

  getBackground(payload: GetBackgroundPayload) {
    return this.background.list(payload.activeOnly ?? false, payload.limit);
  }
}

function isUntitled(title: string | undefined): boolean {
  return typeof title !== 'string' || title.trim().length === 0 || title === 'New Session';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRPCService,
  AgentRPCService,
  InstantiationType.Delayed,
  'rpc',
);
