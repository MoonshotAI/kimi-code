/**
 * TaskListTool — list background tasks.
 */

import { z } from 'zod';

import type { BackgroundManager, BackgroundTaskInfo } from '../../agent/background';
import type { BuiltinTool } from '../../agent/tool';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import { formatPlainObject } from './format';
import TASK_LIST_DESCRIPTION from './task-list.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const TaskListInputSchema = z.object({
  active_only: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to list only non-terminal background tasks.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of tasks to return.')
    .optional(),
});

export type TaskListInput = z.Infer<typeof TaskListInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export function formatTaskList(tasks: BackgroundTaskInfo[], activeOnly: boolean): string {
  // `active_only=false` mixes in terminal/lost tasks, so the count is no
  // longer purely "active" — use a neutral label to avoid mislabeling them.
  const label = activeOnly ? 'active_background_tasks' : 'background_tasks';
  const header = `${label}: ${String(tasks.length)}`;
  if (tasks.length === 0) return `${header}\nNo background tasks found.`;
  return `${header}\n${tasks.map((task) => formatPlainObject(task)).join('\n---\n')}`;
}

export class TaskListTool implements BuiltinTool<TaskListInput> {
  readonly name = 'TaskList' as const;
  readonly description = TASK_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskListInputSchema);

  constructor(private readonly manager: BackgroundManager) {}

  resolveExecution(args: TaskListInput): ToolExecution {
    const listScope = (args.active_only ?? true) ? 'active' : 'all';
    return {
      description: 'Listing background tasks',
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, listScope),
      execute: async () => {
        const activeOnly = args.active_only ?? true;
        const tasks = this.manager.list(activeOnly, args.limit ?? 20);
        return {
          output: formatTaskList(tasks, activeOnly),
          isError: false,
        };
      },
    };
  }
}
