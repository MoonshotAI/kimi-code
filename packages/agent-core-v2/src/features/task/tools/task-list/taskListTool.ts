import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AgentTask, type TaskRuntime } from '#/features/task/taskAgentRuntime';
import { formatTaskList } from '#/features/task/internal/format';
import { type ITaskListTool, TaskListInputSchema, type TaskListInput } from './task-list';
import TASK_LIST_DESCRIPTION from './task-list.md?raw';

export class TaskListTool implements ITaskListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskList' as const;
  readonly description = TASK_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskListInputSchema);

  constructor(private readonly tasks: TaskRuntime) {}

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

registerAgentToolService({
  name: 'TaskList',
  domain: 'agentTask',
  create: (context) =>
    new TaskListTool(context.get(IAgentLifecycleService).resolve(context.agent, AgentTask)),
});
