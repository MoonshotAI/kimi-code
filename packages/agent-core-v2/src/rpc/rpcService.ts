import { registerSingleton, SyncDescriptor } from "#/_base/di";
import type {
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
  PromptPayload,
  RegisterToolPayload,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
} from '../../../rpc/core-api';
import { IBackgroundService } from '../background/background';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextSizeService } from '../contextSize/contextSize';
import { IFullCompaction } from '../fullCompaction/fullCompaction';
import { IGoalService } from '../goal/goal';
import { IPermissionService } from '../permission/permission';
import { IPermissionModeService } from '../permissionMode/permissionMode';
import { IPlanService } from '../plan/planMode';
import { IProfileService } from '../profile/profile';
import { IPromptService } from '../prompt/prompt';
import { IAgentSkillService } from '../skill/skill';
import { ISubagentHost } from '../subagentHost/subagentHost';
import { ISwarmService } from '../swarm/swarmMode';
import { ITelemetryService } from '../telemetry/telemetry';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { ITurnRunner } from '../turnRunner/turnRunner';
import { IUsageService } from '../usage/usage';
import { IUserToolService } from '../userTool/userTool';
import { IAgentRPCService } from './rpc';

export class AgentRPCService implements IAgentRPCService {
  constructor(
    @IPromptService private readonly promptService: IPromptService,
    @ITurnRunner private readonly turnRunner: ITurnRunner,
    @IProfileService private readonly profile: IProfileService,
    @IPermissionModeService private readonly permissionMode: IPermissionModeService,
    @IPermissionService private readonly permission: IPermissionService,
    @IPlanService private readonly planMode: IPlanService,
    @ISwarmService private readonly swarmMode: ISwarmService,
    @IFullCompaction private readonly fullCompaction: IFullCompaction,
    @IUserToolService private readonly userTools: IUserToolService,
    @IToolRegistry private readonly toolRegistry: IToolRegistry,
    @IBackgroundService private readonly background: IBackgroundService,
    @IContextMemory private readonly context: IContextMemory,
    @IContextSizeService private readonly contextSize: IContextSizeService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @ISubagentHost private readonly subagentHost: ISubagentHost,
    @IUsageService private readonly usage: IUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IGoalService private readonly goal: IGoalService,
  ) {}

  prompt(payload: PromptPayload): void {
    this.promptService.prompt({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
  }

  steer(payload: SteerPayload): void {
    this.telemetry.track('input_steer', { parts: payload.input.length });
    this.promptService.steer({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
  }

  cancel(payload: CancelPayload): void {
    if (this.turnRunner.getActiveTurn() !== undefined) {
      this.telemetry.track('cancel', { from: 'streaming' });
    }
    this.turnRunner.cancel(payload.turnId);
  }

  undoHistory(payload: UndoHistoryPayload): void {
    this.promptService.undo(payload.count);
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
    const history = this.context.getHistory();
    if (history.length === 0) return;
    this.context.spliceHistory(0, history.length, []);
  }

  activateSkill(payload: ActivateSkillPayload): void {
    this.skills.activate(payload);
  }

  startBtw(_payload: EmptyPayload): Promise<string> {
    return this.subagentHost.startBtw();
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
      history: this.context.getHistory(),
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
    return this.planMode.data();
  }

  getUsage(_payload: EmptyPayload) {
    return this.usage.data();
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

registerSingleton(
  IAgentRPCService,
  new SyncDescriptor(AgentRPCService, [], true),
);
