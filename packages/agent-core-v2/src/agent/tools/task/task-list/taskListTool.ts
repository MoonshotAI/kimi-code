import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/task';
import { formatPlainObject } from '#/agent/task/tools/format';
import { ITaskListTool, TaskListInputSchema, type TaskListInput } from './task-list';
import TASK_LIST_DESCRIPTION from './task-list.md?raw';

export function formatTaskList(tasks: readonly AgentTaskInfo[], activeOnly: boolean): string {
  const label = activeOnly ? 'active_background_tasks' : 'background_tasks';
  const header = `${label}: ${String(tasks.length)}`;
  if (tasks.length === 0) return `${header}\nNo background tasks found.`;
  return `${header}\n${tasks.map((task) => formatPlainObject(task)).join('\n---\n')}`;
}

export class TaskListTool implements ITaskListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskList' as const;
  readonly description = TASK_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskListInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskListInput): ToolExecution {
    const listScope = (args.active_only ?? true) ? 'active' : 'all';
    return {
      description: 'Listing background tasks',
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, listScope),
      execute: async () => {
        const activeOnly = args.active_only ?? true;
        const tasks = this.tasks.list(activeOnly, args.limit ?? 20);
        return {
          output: formatTaskList(tasks, activeOnly),
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(ITaskListTool, TaskListTool, { name: 'TaskList', domain: 'agentTask' });
