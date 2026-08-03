import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { GITHUB_READONLY_TOOL_NAMES } from '../../../tools/builtin/github/github-tools';

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AskUserQuestion',
  'Skill',
  // Goal control tools have no side effects on the world: GetGoal reads, and
  // mutation tools only record the goal's own runtime state.
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  // Loading a tool definition into context has no side effects on the world;
  // executing the loaded tool still goes through its own approval.
  'select_tools',
  // Read-only GitHub tools (no remote side effects). Mutating GitHub tools are
  // intentionally excluded so they still require approval.
  ...GITHUB_READONLY_TOOL_NAMES,
]);

export class DefaultToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!DEFAULT_APPROVE_TOOLS.has(context.toolCall.name)) return;
    return {
      kind: 'approve',
    };
  }
}
