import type { PermissionFileAccess } from '../types';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
  type PermissionPathMatchOptions,
} from './subject-match';

export interface ToolRuleMatcher {
  readonly approvalRule?: (args: Record<string, unknown>) => string | undefined;
  readonly matchesRule?: (
    argPattern: string,
    args: Record<string, unknown>,
    options: PermissionPathMatchOptions,
  ) => boolean;
  readonly fileAccesses?: (args: Record<string, unknown>) => readonly PermissionFileAccess[];
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function globSubjectMatcher(toolName: string, key: string): ToolRuleMatcher {
  const subject = (args: Record<string, unknown>): string | undefined => stringField(args, key);
  return {
    approvalRule: (args) => {
      const value = subject(args);
      return value === undefined ? undefined : literalRulePattern(toolName, value);
    },
    matchesRule: (argPattern, args) => {
      const value = subject(args);
      return value === undefined ? false : matchesGlobRuleSubject(argPattern, value);
    },
  };
}

function pathSubjectMatcher(
  toolName: string,
  operation: PermissionFileAccess['operation'],
): ToolRuleMatcher {
  return {
    approvalRule: (args) => {
      const path = stringField(args, 'path');
      return path === undefined ? undefined : literalRulePattern(toolName, path);
    },
    matchesRule: (argPattern, args, options) => {
      const path = stringField(args, 'path');
      return path === undefined ? false : matchesPathRuleSubject(argPattern, path, options);
    },
    fileAccesses: (args) => {
      const path = stringField(args, 'path');
      return path === undefined
        ? []
        : [{ operation, path, recursive: operation === 'search' ? true : undefined }];
    },
  };
}

function searchAccessMatcher(toolName: string): ToolRuleMatcher {
  return {
    ...globSubjectMatcher(toolName, 'pattern'),
    fileAccesses: (args) => {
      const path = stringField(args, 'path');
      return path === undefined ? [] : [{ operation: 'search', path, recursive: true }];
    },
  };
}

function nameOnlyMatcher(toolName: string): ToolRuleMatcher {
  return {
    approvalRule: () => toolName,
  };
}

const TOOL_RULE_MATCHERS: Readonly<Record<string, ToolRuleMatcher>> = {
  Bash: globSubjectMatcher('Bash', 'command'),
  Glob: searchAccessMatcher('Glob'),
  Grep: searchAccessMatcher('Grep'),
  Read: pathSubjectMatcher('Read', 'read'),
  Write: pathSubjectMatcher('Write', 'write'),
  Edit: pathSubjectMatcher('Edit', 'readwrite'),
  ReadMediaFile: pathSubjectMatcher('ReadMediaFile', 'read'),
  FetchURL: globSubjectMatcher('FetchURL', 'url'),
  WebSearch: globSubjectMatcher('WebSearch', 'query'),
  Agent: {
    approvalRule: () => 'Agent',
    matchesRule: (argPattern, args) =>
      matchesGlobRuleSubject(argPattern, stringField(args, 'subagent_type') ?? 'coder'),
  },
  WaitFor: {
    approvalRule: () => 'WaitFor',
    matchesRule: (argPattern, args) =>
      matchesGlobRuleSubject(argPattern, stringField(args, 'task_id') ?? 'any'),
  },
  TaskList: {
    approvalRule: () => 'TaskList',
    matchesRule: (argPattern, args) =>
      matchesGlobRuleSubject(argPattern, args['active_only'] === false ? 'all' : 'active'),
  },
  TaskStop: {
    approvalRule: () => 'TaskStop',
    matchesRule: (argPattern, args) => {
      const taskId = stringField(args, 'task_id');
      return taskId === undefined ? false : matchesGlobRuleSubject(argPattern, taskId);
    },
  },
  TaskOutput: {
    approvalRule: () => 'TaskOutput',
    matchesRule: (argPattern, args) => {
      const taskId = stringField(args, 'task_id');
      return taskId === undefined ? false : matchesGlobRuleSubject(argPattern, taskId);
    },
  },
  Skill: {
    approvalRule: () => 'Skill',
    matchesRule: (argPattern, args) => {
      const skill = stringField(args, 'skill');
      return skill === undefined ? false : matchesGlobRuleSubject(argPattern, skill);
    },
  },
  CronDelete: nameOnlyMatcher('CronDelete'),
  CronList: nameOnlyMatcher('CronList'),
  TodoList: nameOnlyMatcher('TodoList'),
  NotifyUser: nameOnlyMatcher('NotifyUser'),
  AskUserQuestion: nameOnlyMatcher('AskUserQuestion'),
  select_tools: nameOnlyMatcher('select_tools'),
  EnterPlanMode: nameOnlyMatcher('EnterPlanMode'),
  ExitPlanMode: nameOnlyMatcher('ExitPlanMode'),
  CreateGoal: nameOnlyMatcher('CreateGoal'),
  GetGoal: nameOnlyMatcher('GetGoal'),
  SetGoalBudget: nameOnlyMatcher('SetGoalBudget'),
  UpdateGoal: nameOnlyMatcher('UpdateGoal'),
  AgentSwarm: nameOnlyMatcher('AgentSwarm'),
};

export function permissionRuleMatcher(toolName: string): ToolRuleMatcher | undefined {
  return TOOL_RULE_MATCHERS[toolName];
}
