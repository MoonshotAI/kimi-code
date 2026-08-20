import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IFlagService } from '#/app/flag/flag';
import { IAgentMonitorService } from '#/agent/monitor/monitor';
import { MONITOR_FLAG_ID } from '#/agent/monitor/flag';
import { formatPlainObject } from '#/agent/task/tools/format';
import {
  IMonitorCancelTool,
  MonitorCancelInputSchema,
  type MonitorCancelInput,
} from './monitor-cancel';
import MONITOR_CANCEL_DESCRIPTION from './monitor-cancel.md?raw';

export class MonitorCancelTool implements IMonitorCancelTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MonitorCancel' as const;
  readonly description: string = MONITOR_CANCEL_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorCancelInputSchema);

  constructor(@IAgentMonitorService private readonly monitors: IAgentMonitorService) {}

  resolveExecution(args: MonitorCancelInput): ToolExecution {
    return {
      description: `Cancelling monitor ${args.monitor_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.monitor_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: MonitorCancelInput): Promise<ExecutableToolResult> {
    const info = await this.monitors.cancelMonitor(args.monitor_id);
    if (info === undefined) {
      return { isError: true, output: `Monitor not found: ${args.monitor_id}` };
    }
    return {
      isError: false,
      output: formatPlainObject(info),
    };
  }
}

registerAgentToolService(IMonitorCancelTool, MonitorCancelTool, {
  name: 'MonitorCancel',
  domain: 'agentMonitor',
  when: (accessor) => accessor.get(IFlagService).enabled(MONITOR_FLAG_ID),
});
