import { isWithinWorkspace } from '#/features/os/path-access';

import { findGitWorkTree } from '../analyzers/git';

import type { PermissionPolicy } from './chain';
import { writeFileAccesses } from './file-access';

const DEFAULT_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'WaitFor',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'NotifyUser',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'select_tools',
]);

export const defaultToolApprove: PermissionPolicy = {
  name: 'default-tool-approve',
  evaluate(context) {
    return DEFAULT_APPROVE_TOOLS.has(context.toolCall.name) ? { kind: 'approve' } : undefined;
  },
};

export const gitCwdWriteApprove: PermissionPolicy = {
  name: 'git-cwd-write-approve',
  async evaluate(context) {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    if (context.pathClass !== 'posix') return undefined;

    const cwd = context.workDir ?? '';
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: context.additionalDirs },
          'posix',
        ),
      )
    ) {
      return undefined;
    }

    if (context.fs === undefined) return undefined;
    return (await findGitWorkTree(context.fs, cwd)) === null ? undefined : { kind: 'approve' };
  },
};

export const fallbackAsk: PermissionPolicy = {
  name: 'fallback-ask',
  evaluate() {
    return { kind: 'ask' };
  },
};
