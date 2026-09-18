import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentTowerService } from '#/features/tower/tower';

import { CHANGE_ENVIRONMENT_TOOL_NAME, CONNECT_ENVIRONMENT_TOOL_NAME } from './environmentTools';
import { AGENT_ENVIRONMENT_TOOLS_FLAG_ID } from './flag';
import { IChangeEnvironmentTool } from './tools/change-environment/changeEnvironment';
import { ChangeEnvironmentTool } from './tools/change-environment/changeEnvironmentTool';
import { IConnectEnvironmentTool } from './tools/connect/connect';
import { ConnectEnvironmentTool } from './tools/connect/connectTool';

function towerModeInactive(accessor: ServicesAccessor): boolean {
  return !accessor.get(IAgentTowerService).isActive;
}

export class AgentEnvironmentToolsFeature extends Feature {
  static override readonly name = 'agentEnvironmentTools';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(AGENT_ENVIRONMENT_TOOLS_FLAG_ID)) return;
    this.contributeTool(IChangeEnvironmentTool, ChangeEnvironmentTool, {
      name: CHANGE_ENVIRONMENT_TOOL_NAME,
      domain: 'environmentTools',
      when: towerModeInactive,
    });
    this.contributeTool(IConnectEnvironmentTool, ConnectEnvironmentTool, {
      name: CONNECT_ENVIRONMENT_TOOL_NAME,
      domain: 'environmentTools',
      when: towerModeInactive,
    });
  }
}

registerFeature(AgentEnvironmentToolsFeature);
