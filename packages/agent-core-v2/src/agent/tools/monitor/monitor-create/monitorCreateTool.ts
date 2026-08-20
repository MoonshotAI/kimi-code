import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IFlagService } from '#/app/flag/flag';
import { toErrorMessage } from '#/errors';
import {
  IAgentMonitorService,
  MONITOR_MAX_ACTIVE,
  type MonitorSpec,
} from '#/agent/monitor/monitor';
import { MONITOR_FLAG_ID } from '#/agent/monitor/flag';
import { formatPlainObject } from '#/agent/task/tools/format';
import {
  IMonitorCreateTool,
  MONITOR_DEFAULT_TIMEOUT_S,
  MonitorCreateInputSchema,
  type MonitorCreateInput,
} from './monitor-create';
import MONITOR_CREATE_DESCRIPTION from './monitor-create.md?raw';

function toSpec(args: MonitorCreateInput): MonitorSpec {
  const timeoutMs = (args.timeout ?? MONITOR_DEFAULT_TIMEOUT_S) * 1000;
  const description = args.description;
  switch (args.type) {
    case 'task_output':
      return {
        type: 'task_output',
        taskId: args.task_id,
        pattern: args.pattern,
        timeoutMs,
        description,
      };
    case 'command':
      return {
        type: 'command',
        command: args.command,
        pattern: args.pattern,
        timeoutMs,
        description,
      };
    case 'file':
      return { type: 'file', path: args.path, events: args.events, timeoutMs, description };
  }
}

function ruleSubject(args: MonitorCreateInput): string {
  switch (args.type) {
    case 'task_output':
      return args.task_id;
    case 'command':
      return args.command;
    case 'file':
      return args.path;
  }
}

export class MonitorCreateTool implements IMonitorCreateTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'MonitorCreate' as const;
  readonly description: string = MONITOR_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorCreateInputSchema);

  constructor(
    @IAgentMonitorService private readonly monitors: IAgentMonitorService,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  resolveExecution(args: MonitorCreateInput): ToolExecution {
    return {
      description: `Creating ${args.type} monitor`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, ruleSubject(args)),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: MonitorCreateInput): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(MONITOR_FLAG_ID)) {
      return {
        isError: true,
        output: 'MonitorCreate is disabled: the monitor experimental flag is off.',
      };
    }
    const activeCount = this.monitors
      .listMonitors()
      .filter((info) => info.status === 'active').length;
    if (activeCount >= MONITOR_MAX_ACTIVE) {
      return {
        isError: true,
        output: `Too many active monitors (max ${String(MONITOR_MAX_ACTIVE)}). Cancel one with MonitorCancel before creating another.`,
      };
    }
    try {
      const info = await this.monitors.createMonitor(toSpec(args));
      return {
        isError: false,
        output: [
          formatPlainObject(info),
          '',
          info.status === 'active'
            ? 'Monitor registered. It is one-shot: you will be notified when it fires, times out, or (for command monitors) the command exits. Use MonitorList to inspect it and MonitorCancel to stop it early.'
            : 'The monitor ended immediately because the target task is already finished.',
        ].join('\n'),
      };
    } catch (error) {
      return { isError: true, output: toErrorMessage(error) };
    }
  }
}

registerAgentToolService(IMonitorCreateTool, MonitorCreateTool, {
  name: 'MonitorCreate',
  domain: 'agentMonitor',
  when: (accessor) => accessor.get(IFlagService).enabled(MONITOR_FLAG_ID),
});
