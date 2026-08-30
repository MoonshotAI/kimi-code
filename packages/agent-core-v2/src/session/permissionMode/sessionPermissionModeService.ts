import type { AgentContext } from '#/agent/agentContext/agentContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { toContractMode, toWireMode } from '#/actor/permissionMode/internal/modeMapping';
import {
  AgentPermissionMode,
  type PermissionModeRuntime,
} from '#/actor/permissionMode/permissionModeAgentRuntime';
import type { WirePermissionMode } from '#/actor/permissionMode/permissionModeOps';
import { IAgentHostService } from '#/agent/host/agentHost';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';

import { ISessionPermissionModeService } from './sessionPermissionMode';

export class SessionPermissionModeService implements ISessionPermissionModeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IAgentHostService private readonly hosts: IAgentHostService,
  ) {}

  mode(agent: AgentContext): WirePermissionMode {
    return toWireMode(this.runtime(agent).mode());
  }

  configured(agent: AgentContext): boolean {
    return this.runtime(agent).configured();
  }

  setMode(agent: AgentContext, mode: WirePermissionMode): void {
    void this.runtime(agent).changeMode(toContractMode(mode));
  }

  setModeAndBroadcast(agent: AgentContext, mode: WirePermissionMode): void {
    const wasYolo = this.mode(agent) === 'yolo';
    const wasAuto = this.mode(agent) === 'auto';
    this.setMode(agent, mode);
    if (agent.agentId === MAIN_AGENT_ID) {
      this.agentLifecycle.broadcastPermissionMode(mode);
    }
    const yoloEnabled = mode === 'yolo';
    if (yoloEnabled !== wasYolo) {
      this.telemetry(agent).track2('yolo_toggle', { enabled: yoloEnabled });
    }
    const afkEnabled = mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry(agent).track2('afk_toggle', { enabled: afkEnabled });
    }
  }

  private telemetry(agent: AgentContext): ITelemetryService {
    return this.hosts.of(agent).telemetry;
  }

  private runtime(agent: AgentContext): PermissionModeRuntime {
    return this.agentLifecycle.resolve(agent, AgentPermissionMode);
  }
}
