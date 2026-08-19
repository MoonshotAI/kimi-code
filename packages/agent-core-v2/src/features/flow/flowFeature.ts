import { ScopeActivation } from '#/_base/di/instantiation';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { FiberHandle } from '#/_base/di/fiber';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import {
  FLOW_ABORT_TOOL_NAME,
  FLOW_ADVANCE_TOOL_NAME,
  FLOW_FLAG_ID,
  FLOW_JUMP_TOOL_NAME,
  FLOW_START_TOOL_NAME,
} from './flow';
import { FlowInjection, IFlowInjection } from './injection/flowInjection';
import { FLOW_REVIEWER_PROFILE_DEF } from './reviewerProfile';
import { FlowAbortTool } from './tools/abort/abortTool';
import { IFlowAbortTool } from './tools/abort/abort';
import { FlowAdvanceTool } from './tools/advance/advanceTool';
import { IFlowAdvanceTool } from './tools/advance/advance';
import { FlowJumpTool } from './tools/jump/jumpTool';
import { IFlowJumpTool } from './tools/jump/jump';
import { FlowStartTool } from './tools/start/startTool';
import { IFlowStartTool } from './tools/start/start';

const supervisorOnly = (accessor: ServicesAccessor): boolean =>
  accessor.get(IAgentScopeContext).agentId === 'main';

export class FlowFeature extends Feature {
  static override readonly name = 'flow';

  private handles: FiberHandle[] | undefined;

  constructor(
    @IFlagService flags: IFlagService,
    @IConfigService config: IConfigService,
  ) {
    super();
    this.reconcile(flags.enabled(FLOW_FLAG_ID));
    this._register(
      config.onDidChangeConfiguration(() => {
        this.reconcile(flags.enabled(FLOW_FLAG_ID));
      }),
    );
  }

  private reconcile(enabled: boolean): void {
    if (enabled === (this.handles !== undefined)) return;
    if (!enabled) {
      for (const handle of this.handles ?? []) void handle.dispose();
      this.handles = undefined;
      return;
    }
    this.handles = [
      ...this.contributeAgentService(IFlowInjection, FlowInjection, {
        activation: ScopeActivation.OnScopeCreated,
      }),
      ...this.contributeTool(IFlowStartTool, FlowStartTool, {
        name: FLOW_START_TOOL_NAME,
        domain: 'flow',
        when: supervisorOnly,
        requiredRuntimeCapabilities: ['fs'],
      }),
      ...this.contributeTool(IFlowAdvanceTool, FlowAdvanceTool, {
        name: FLOW_ADVANCE_TOOL_NAME,
        domain: 'flow',
        when: supervisorOnly,
      }),
      ...this.contributeTool(IFlowAbortTool, FlowAbortTool, {
        name: FLOW_ABORT_TOOL_NAME,
        domain: 'flow',
        when: supervisorOnly,
      }),
      ...this.contributeTool(IFlowJumpTool, FlowJumpTool, {
        name: FLOW_JUMP_TOOL_NAME,
        domain: 'flow',
        when: supervisorOnly,
      }),
      this.contributeProfiles([FLOW_REVIEWER_PROFILE_DEF]),
    ];
  }
}

registerFeature(FlowFeature);
