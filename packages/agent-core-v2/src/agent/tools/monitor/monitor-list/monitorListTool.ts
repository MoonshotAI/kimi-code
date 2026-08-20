import { toInputJsonSchema } from '#/tool/input-schema';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IFlagService } from '#/app/flag/flag';
import { IAgentMonitorService } from '#/agent/monitor/monitor';
import { MONITOR_FLAG_ID } from '#/agent/monitor/flag';
import { formatPlainObject } from '#/agent/task/tools/format';
import { IMonitorListTool, MonitorListInputSchema, type MonitorListInput } from './monitor-list';
import MONITOR_LIST_DESCRIPTION from './monitor-list.md?raw';

export class MonitorListTool implements IMonitorListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MonitorList' as const;
  readonly description: string = MONITOR_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorListInputSchema);

  constructor(@IAgentMonitorService private readonly monitors: IAgentMonitorService) {}

  resolveExecution(_args: MonitorListInput): ToolExecution {
    return {
      description: 'Listing monitors',
      approvalRule: this.name,
      execute: () => this.execute(),
    };
  }

  private execute(): Promise<ExecutableToolResult> {
    const infos = this.monitors.listMonitors();
    if (infos.length === 0) {
      return Promise.resolve({
        isError: false,
        output: 'No monitors registered. Use MonitorCreate to register one.',
      });
    }
    return Promise.resolve({
      isError: false,
      output: infos.map((info) => formatPlainObject(info)).join('\n---\n'),
    });
  }
}

registerAgentToolService(IMonitorListTool, MonitorListTool, {
  name: 'MonitorList',
  domain: 'agentMonitor',
  when: (accessor) => accessor.get(IFlagService).enabled(MONITOR_FLAG_ID),
});
