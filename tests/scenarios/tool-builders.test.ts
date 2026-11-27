import {
  agent,
  askUserQuestion,
  bash,
  callProblems,
  createGoal,
  edit,
  exitPlanMode,
  FAKE_PROVIDER_DEFAULTS,
  glob,
  grep,
  read,
  say,
  skill,
  taskOutput,
  taskStop,
  todoList,
  updateGoal,
  waitFor,
  write,
  type AgentArgs,
  type AskUserQuestionArgs,
  type BashArgs,
  type CreateGoalArgs,
  type EditArgs,
  type GlobArgs,
  type GrepArgs,
  type ReadArgs,
  type ReplyStep,
  type SkillArgs,
  type TaskStopArgs,
  type WaitForArgs,
  type WriteArgs,
} from '@moonshot-ai/testkit/model';
import { test as base, expect } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const SECOND_MODEL = 'testkit-second';

const test = base.extend<ScenarioFixtures>(
  scenarioFixtures({
    config: {
      models: { [SECOND_MODEL]: { provider: FAKE_PROVIDER_DEFAULTS.alias, model: 'testkit-model-2', maxContextSize: FAKE_PROVIDER_DEFAULTS.maxContextSize } },
      extra: {
        experimental: {
          cli: {
            wait_for: true,
          },
        },
        secondary_model: {
          default_model: FAKE_PROVIDER_DEFAULTS.alias,
          models: { [FAKE_PROVIDER_DEFAULTS.alias]: 'the default model', [SECOND_MODEL]: 'a second model' },
        },
      },
    },
  }),
);

const EVERY_ARGUMENT: readonly ReplyStep[] = [
  bash({ command: 'ls', cwd: '.', timeout: 30, description: 'list', run_in_background: true, disable_timeout: true } satisfies Required<BashArgs>),
  read({ path: 'a.txt', line_offset: 1, column_offset: 0, n_lines: 10, max_chars: 100 } satisfies Required<ReadArgs>),
  write({ path: 'a.txt', content: 'x', mode: 'append' } satisfies Required<WriteArgs>),
  edit({ path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true } satisfies Required<EditArgs>),
  glob({ pattern: '*.ts', path: '.', head_limit: 5, offset: 0, include_ignored: true, include_dirs: true } satisfies Required<GlobArgs>),
  grep({
    pattern: 'x',
    path: '.',
    glob: '*.ts',
    type: 'ts',
    output_mode: 'content',
    '-i': true,
    '-n': true,
    '-A': 1,
    '-B': 1,
    '-C': 1,
    head_limit: 5,
    offset: 0,
    multiline: true,
    include_ignored: true,
  } satisfies Required<GrepArgs>),
  agent({
    prompt: 'p',
    description: 'd',
    subagent_type: 'coder',
    resume: 'agent-1',
    run_in_background: true,
    model: SECOND_MODEL,
  } satisfies Required<AgentArgs>),
  waitFor({ timeout: 5, task_id: 'task-1' } satisfies Required<WaitForArgs>),
  taskOutput('task-1'),
  taskStop({ task_id: 'task-1', reason: 'done' } satisfies Required<TaskStopArgs>),
  todoList([{ title: 't', status: 'in_progress' }]),
  askUserQuestion({
    questions: [{ question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }, { label: 'b' }], multi_select: true }],
    background: true,
  } satisfies Required<AskUserQuestionArgs>),
  exitPlanMode([{ label: 'go', description: 'd' }]),
  createGoal({ objective: 'o', completionCriterion: 'c', replace: true } satisfies Required<CreateGoalArgs>),
  updateGoal('complete'),
  skill({ skill: 's', path: 'p', args: 'a' } satisfies Required<SkillArgs>),
];

test('every tool builder matches the schema the engine offers to the model', async ({ kap, model }) => {
  model.script(say('ok'));
  const session = await kap.createSession();
  await kap.prompt(session.id, 'hello');
  await kap.waitIdle(session.id);

  const offered = model.request(0).view.tools;
  expect(EVERY_ARGUMENT.flatMap((step) => callProblems(step, offered))).toEqual([]);
});
