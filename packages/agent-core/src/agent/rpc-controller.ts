import type { AgentAPI } from '#/rpc';
import { ErrorCodes, KimiError } from '#/errors';

import type { ModelProvider } from '../session/provider-manager';
import type { ISubagentHostService } from '../session/subagent-host';
import type { TelemetryClient } from '../telemetry';
import type { PromisableMethods } from '#/_utils/types';
import type { IBackgroundService } from './background';
import type { ICompactionService } from './compaction';
import type { IAgentConfigService } from './config';
import type { IContextService } from './context';
import type { IGoalService } from './goal';
import type { IPermissionService } from './permission';
import type { IPlanService } from './plan';
import type { IAgentSkillService } from './skill';
import type { ISwarmService } from './swarm';
import type { IAgentToolService } from './tool/index';
import type { ITurnService } from './turn';
import type { IUsageService } from './usage';

/**
 * Narrow read-only view of the agent that {@link AgentRpcController} needs in
 * order to build the `rpcMethods` map. `Agent` satisfies this structurally,
 * but the controller depends only on this interface — never on the concrete
 * `Agent` class — so tests can drive it with a plain stub.
 *
 * The controller reads these fields lazily inside each RPC handler (after the
 * agent has finished constructing), which is why this host can be handed to the
 * controller before the underlying services have been resolved, and why no DI
 * cycle is introduced: the controller is not injected back into any of the
 * services it delegates to.
 */
export interface AgentRpcHost {
  readonly turn: ITurnService;
  readonly telemetry: TelemetryClient;
  readonly context: IContextService;
  readonly config: IAgentConfigService;
  readonly permission: IPermissionService;
  readonly modelProvider?: ModelProvider;
  readonly planMode: IPlanService;
  readonly swarmMode: ISwarmService;
  readonly fullCompaction: ICompactionService;
  readonly tools: IAgentToolService;
  readonly background: IBackgroundService;
  readonly skills: IAgentSkillService | null;
  readonly subagentHost?: ISubagentHostService;
  readonly goal: IGoalService;
  readonly usage: IUsageService;
}

/**
 * Owns the agent's `rpcMethods` map: a pure delegation layer over the agent's
 * services plus the telemetry side-effects that fire alongside some handlers.
 */
export interface IAgentRpcController {
  /**
   * The map of RPC method handlers exposed by the agent. Each access returns a
   * fresh method map whose handlers delegate to the agent's services and emit
   * the same telemetry events as the former `Agent.rpcMethods` getter.
   */
  readonly rpcMethods: PromisableMethods<AgentAPI>;
}

export class AgentRpcController implements IAgentRpcController {
  constructor(private readonly host: AgentRpcHost) {}

  get rpcMethods(): PromisableMethods<AgentAPI> {
    return {
      prompt: (payload) => {
        this.host.turn.prompt(payload.input);
      },
      steer: (payload) => {
        this.host.telemetry.track('input_steer', { parts: payload.input.length });
        this.host.turn.steer(payload.input);
      },
      cancel: (payload) => {
        if (this.host.turn.hasActiveTurn) {
          this.host.telemetry.track('cancel', { from: 'streaming' });
        }
        this.host.turn.cancel(payload.turnId);
      },
      undoHistory: (payload) => {
        this.host.context.undo(payload.count);
      },
      setThinking: (payload) => {
        const wasEnabled = this.host.config.thinkingLevel !== 'off';
        this.host.config.update({ thinkingLevel: payload.level });
        const enabled = this.host.config.thinkingLevel !== 'off';
        if (enabled !== wasEnabled) {
          this.host.telemetry.track('thinking_toggle', { enabled });
        }
      },
      setPermission: (payload) => {
        const wasYolo = this.host.permission.mode === 'yolo';
        const wasAuto = this.host.permission.mode === 'auto';
        this.host.permission.setMode(payload.mode);
        const enabled = this.host.permission.mode === 'yolo';
        if (enabled !== wasYolo) {
          this.host.telemetry.track('yolo_toggle', { enabled });
        }
        const afkEnabled = this.host.permission.mode === 'auto';
        if (afkEnabled !== wasAuto) {
          this.host.telemetry.track('afk_toggle', { enabled: afkEnabled });
        }
      },
      setModel: (payload) => {
        // Validate the alias resolves before recording it so resume / runtime
        // callers fail fast on missing aliases instead of deferring to the
        // next prompt.
        const resolved = this.host.modelProvider?.resolveProviderConfig(payload.model);
        if (this.host.config.modelAlias !== payload.model) {
          this.host.config.update({ modelAlias: payload.model });
          this.host.telemetry.track('model_switch', { model: payload.model });
        }
        return {
          model: payload.model,
          providerName: resolved?.providerName,
        };
      },
      getModel: () => {
        return this.host.config.modelAlias ?? '';
      },
      enterPlan: async () => {
        await this.host.planMode.enter();
      },
      cancelPlan: (payload) => {
        this.host.planMode.cancel(payload.id);
      },
      clearPlan: () => this.host.planMode.clear(),
      enterSwarm: (payload) => {
        this.host.swarmMode.enter(payload.trigger);
      },
      exitSwarm: () => {
        this.host.swarmMode.exit();
      },
      getSwarmMode: () => {
        return this.host.swarmMode.isActive;
      },
      beginCompaction: (payload) => {
        this.host.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
      },
      cancelCompaction: () => {
        if (this.host.fullCompaction.isCompacting) {
          this.host.telemetry.track('cancel', { from: 'compacting' });
        }
        this.host.fullCompaction.cancel();
      },
      registerTool: (payload) => {
        this.host.tools.registerUserTool(payload);
      },
      unregisterTool: (payload) => {
        this.host.tools.unregisterUserTool(payload.name);
      },
      setActiveTools: (payload) => {
        this.host.tools.setActiveTools(payload.names);
      },
      stopBackground: (payload) => {
        void this.host.background.stop(payload.taskId, payload.reason);
      },
      clearContext: () => {
        this.host.context.clear();
      },
      activateSkill: (payload) => {
        if (this.host.skills === null) {
          throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.host.skills.activate(payload);
      },
      startBtw: () => this.host.subagentHost!.startBtw(),
      createGoal: (payload) => this.host.goal.createGoal(payload),
      getGoal: () => this.host.goal.getGoal(),
      pauseGoal: () => this.host.goal.pauseGoal(),
      resumeGoal: () => this.host.goal.resumeGoal(),
      cancelGoal: () => this.host.goal.cancelGoal(),
      getBackgroundOutput: (payload) => this.host.background.readOutput(payload.taskId, payload.tail),
      getContext: () => this.host.context.data(),
      getConfig: () => this.host.config.data(),
      getPermission: () => this.host.permission.data(),
      getPlan: () => this.host.planMode.data(),
      getUsage: () => this.host.usage.data(),
      getTools: () => this.host.tools.data(),
      getBackground: (payload) => this.host.background.list(payload.activeOnly ?? false, payload.limit),
    };
  }
}
