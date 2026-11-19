import { call, type CallOptions } from '#/model/steps';
import type { ReplyStep } from '#/model/types';

export interface BashArgs {
  readonly command: string;
  readonly cwd?: string;
  readonly timeout?: number;
  readonly description?: string;
  readonly run_in_background?: boolean;
  readonly disable_timeout?: boolean;
}

export interface ReadArgs {
  readonly path: string;
  readonly line_offset?: number;
  readonly column_offset?: number;
  readonly n_lines?: number;
  readonly max_chars?: number;
}

export interface WriteArgs {
  readonly path: string;
  readonly content: string;
  readonly mode?: 'overwrite' | 'append';
}

export interface EditArgs {
  readonly path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

export interface GlobArgs {
  readonly pattern: string;
  readonly path?: string;
  readonly head_limit?: number;
  readonly offset?: number;
  readonly include_ignored?: boolean;
  readonly include_dirs?: boolean;
}

export interface GrepArgs {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly type?: string;
  readonly output_mode?: 'content' | 'files_with_matches' | 'count_matches';
  readonly '-i'?: boolean;
  readonly '-n'?: boolean;
  readonly '-A'?: number;
  readonly '-B'?: number;
  readonly '-C'?: number;
  readonly head_limit?: number;
  readonly offset?: number;
  readonly multiline?: boolean;
  readonly include_ignored?: boolean;
}

export interface AgentArgs {
  readonly prompt: string;
  readonly description: string;
  readonly subagent_type?: string;
  readonly resume?: string;
  readonly run_in_background?: boolean;
  readonly model?: string;
}

export interface WaitForArgs {
  readonly timeout: number;
  readonly task_id?: string;
}

export interface TaskStopArgs {
  readonly task_id: string;
  readonly reason?: string;
}

export interface TodoItem {
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface Question {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionOption[];
  readonly multi_select?: boolean;
}

export interface AskUserQuestionArgs {
  readonly questions: readonly Question[];
  readonly background?: boolean;
}

export interface CreateGoalArgs {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}

export type GoalStatus = 'active' | 'complete' | 'blocked';

export interface SkillArgs {
  readonly skill: string;
  readonly path?: string;
  readonly args?: string;
}

export function bash(args: string | BashArgs, options?: CallOptions): ReplyStep {
  return call('Bash', typeof args === 'string' ? { command: args } : { ...args }, options);
}

export function read(args: string | ReadArgs, options?: CallOptions): ReplyStep {
  return call('Read', typeof args === 'string' ? { path: args } : { ...args }, options);
}

export function write(args: WriteArgs, options?: CallOptions): ReplyStep {
  return call('Write', { ...args }, options);
}

export function edit(args: EditArgs, options?: CallOptions): ReplyStep {
  return call('Edit', { ...args }, options);
}

export function glob(args: string | GlobArgs, options?: CallOptions): ReplyStep {
  return call('Glob', typeof args === 'string' ? { pattern: args } : { ...args }, options);
}

export function grep(args: string | GrepArgs, options?: CallOptions): ReplyStep {
  return call('Grep', typeof args === 'string' ? { pattern: args } : { ...args }, options);
}

export function agent(args: AgentArgs, options?: CallOptions): ReplyStep {
  return call('Agent', { ...args }, options);
}

export function waitFor(args: WaitForArgs, options?: CallOptions): ReplyStep {
  return call('WaitFor', { ...args }, options);
}

export function taskOutput(taskId: string, options?: CallOptions): ReplyStep {
  return call('TaskOutput', { task_id: taskId }, options);
}

export function taskStop(args: string | TaskStopArgs, options?: CallOptions): ReplyStep {
  return call('TaskStop', typeof args === 'string' ? { task_id: args } : { ...args }, options);
}

export function todoList(todos?: readonly TodoItem[], options?: CallOptions): ReplyStep {
  return call('TodoList', todos === undefined ? {} : { todos }, options);
}

export function askUserQuestion(args: AskUserQuestionArgs, options?: CallOptions): ReplyStep {
  return call('AskUserQuestion', { ...args }, options);
}

export function exitPlanMode(choices?: readonly QuestionOption[], options?: CallOptions): ReplyStep {
  return call('ExitPlanMode', choices === undefined ? {} : { options: choices }, options);
}

export function createGoal(args: string | CreateGoalArgs, options?: CallOptions): ReplyStep {
  return call('CreateGoal', typeof args === 'string' ? { objective: args } : { ...args }, options);
}

export function updateGoal(status: GoalStatus, options?: CallOptions): ReplyStep {
  return call('UpdateGoal', { status }, options);
}

export function skill(args: string | SkillArgs, options?: CallOptions): ReplyStep {
  return call('Skill', typeof args === 'string' ? { skill: args } : { ...args }, options);
}
