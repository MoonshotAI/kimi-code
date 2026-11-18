import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTaskHistoryService } from '#/agent/task/taskService';
import { agentTaskInfo } from '#/agent/task/handler';
import type { AgentTaskInfo } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatTaskRecord } from '#/agent/task/tools/format';
import { ITaskListTool, TaskListInputSchema, type TaskListInput } from './task-list';
import TASK_LIST_DESCRIPTION from './task-list.md?raw';

export function formatTaskList(tasks: readonly AgentTaskInfo[], activeOnly: boolean): string {
  const label = activeOnly ? 'active_background_tasks' : 'background_tasks';
  const header = `${label}: ${String(tasks.length)}`;
  if (tasks.length === 0) return `${header}\nNo background tasks found.`;
  return `${header}\n${tasks.map((task) => formatTaskRecord(task)).join('\n---\n')}`;
}

export class TaskListTool implements ITaskListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskList' as const;
  readonly description = TASK_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskListInputSchema);

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentTaskHistoryService private readonly history: IAgentTaskHistoryService,
  ) {}

  resolveExecution(args: TaskListInput): ToolExecution {
    const listScope = (args.active_only ?? true) ? 'active' : 'all';
    return {
      description: 'Listing background tasks',
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, listScope),
      execute: async () => {
        const activeOnly = args.active_only ?? true;
        const tasks = this.toolExecutor.handlers().flatMap((handler) => {
          if (handler.snapshot().fields.task === undefined) return [];
          const info = agentTaskInfo(handler);
          return activeOnly && TERMINAL_STATUSES.has(info.status) ? [] : [info];
        });
        const ids = new Set(tasks.map((task) => task.taskId));
        for (const info of this.history.list(false)) {
          if (ids.has(info.taskId)) continue;
          if (activeOnly && TERMINAL_STATUSES.has(info.status)) continue;
          tasks.push(info);
        }
        const limited = tasks.slice(0, args.limit ?? 20);
        return {
          output: formatTaskList(limited, activeOnly),
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(ITaskListTool, TaskListTool, { name: 'TaskList', domain: 'agentTask' });
