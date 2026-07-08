/**
 * AskUserQuestionTool unit tests — ported from v1
 * `packages/agent-core/test/tools/ask-user.test.ts` and adapted to the v2 DI
 * constructor (`ISessionQuestionService` / `IAgentTaskService` /
 * `ITelemetryService` stubs instead of a fake `Agent`).
 */

import { describe, expect, it, vi } from 'vitest';

import { CoreErrors } from '#/_base/errors/codes';
import { KimiError } from '#/_base/errors/errors';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTask, AgentTaskInfoBase, AgentTaskSink, AgentTaskStatus } from '#/agent/task/types';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionTool,
  type AskUserQuestionInput,
} from '#/agent/questionTools/tools/ask-user';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  ISessionQuestionService,
  QuestionRequest,
  QuestionResult,
} from '#/session/question/question';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function input(
  overrides: Partial<AskUserQuestionInput['questions'][number]> = {},
): AskUserQuestionInput {
  return {
    questions: [
      {
        question: 'Which database?',
        header: 'Storage',
        options: [
          { label: 'Postgres', description: 'Relational storage' },
          { label: 'SQLite', description: 'Embedded storage' },
        ],
        multi_select: false,
        ...overrides,
      },
    ],
  };
}

interface FakeTaskEntry {
  readonly task: AgentTask;
  readonly controller: AbortController;
  output: string;
  status: AgentTaskStatus;
  stopReason?: string;
  readonly settled: Promise<void>;
}

/**
 * Minimal in-memory stand-in for `IAgentTaskService`: runs a registered task
 * immediately with a real sink so the QuestionTask wiring (including the
 * task-signal passthrough) is exercised end to end.
 */
function createFakeTaskService(): {
  readonly tasks: IAgentTaskService;
  readonly registerTask: ReturnType<typeof vi.fn>;
  entry(taskId: string): FakeTaskEntry;
  kill(taskId: string): void;
  wait(taskId: string): Promise<void>;
} {
  const entries = new Map<string, FakeTaskEntry>();
  let counter = 0;
  const registerTask = vi.fn((task: AgentTask): string => {
    counter += 1;
    const taskId = `${task.idPrefix}-${String(counter).padStart(8, '0')}`;
    const controller = new AbortController();
    let settleResolve!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleResolve = resolve;
    });
    const entry: FakeTaskEntry = { task, controller, output: '', status: 'running', settled };
    const sink: AgentTaskSink = {
      signal: controller.signal,
      appendOutput: (chunk) => {
        entry.output += chunk;
      },
      settle: (settlement) => {
        entry.status = settlement.status;
        entry.stopReason = settlement.stopReason;
        settleResolve();
        return Promise.resolve(true);
      },
    };
    entries.set(taskId, entry);
    void Promise.resolve(task.start(sink)).catch(() => {});
    return taskId;
  });
  const tasks = {
    registerTask,
    getTask: (taskId: string) => {
      const entry = entries.get(taskId);
      if (entry === undefined) return undefined;
      const base: AgentTaskInfoBase = {
        taskId,
        description: entry.task.description,
        status: entry.status,
        startedAt: 0,
        endedAt: null,
        stopReason: entry.stopReason,
      };
      return entry.task.toInfo(base);
    },
  } as unknown as IAgentTaskService;
  return {
    tasks,
    registerTask,
    entry: (taskId) => {
      const entry = entries.get(taskId);
      if (entry === undefined) throw new Error(`unknown task ${taskId}`);
      return entry;
    },
    kill: (taskId) => {
      entries.get(taskId)?.controller.abort();
    },
    wait: async (taskId) => entries.get(taskId)?.settled,
  };
}

function makeTool(
  options: {
    readonly request?: (
      req: QuestionRequest,
      requestOptions?: { readonly signal?: AbortSignal },
    ) => Promise<QuestionResult>;
  } = {},
): {
  readonly tool: AskUserQuestionTool;
  readonly request: ReturnType<typeof vi.fn>;
  readonly telemetryTrack: ReturnType<typeof vi.fn>;
  readonly taskService: ReturnType<typeof createFakeTaskService>;
} {
  const request = vi.fn(options.request ?? (async () => ({ Postgres: true }) as QuestionResult));
  const telemetryTrack = vi.fn();
  const taskService = createFakeTaskService();
  const question = { request } as unknown as ISessionQuestionService;
  const telemetry = { track: telemetryTrack } as unknown as ITelemetryService;
  const tool = new AskUserQuestionTool(question, taskService.tasks, telemetry);
  return { tool, request, telemetryTrack, taskService };
}

describe('AskUserQuestionTool', () => {
  it('exposes current metadata and schema', () => {
    const { tool } = makeTool();

    expect(tool.name).toBe('AskUserQuestion');
    expect(tool.description).toContain('structured options');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { questions: { type: 'array' } },
    });
    expect(AskUserQuestionInputSchema.safeParse(input()).success).toBe(true);
    expect(AskUserQuestionInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(
      AskUserQuestionInputSchema.safeParse(
        input({
          options: [{ label: 'Only one', description: 'Not enough choices' }],
        }),
      ).success,
    ).toBe(false);
  });

  it('documents the answers shape and the uniqueness requirement to the model', () => {
    const { tool } = makeTool();

    expect(tool.description).toContain('must be unique across the call');
    expect(tool.description).toContain('keyed by question text');
  });

  it('tells the model not to poll a pending background question', () => {
    const { tool } = makeTool();
    const paramsJson = JSON.stringify(tool.parameters);

    expect(paramsJson).toContain('do not poll with TaskOutput');
    expect(paramsJson).not.toContain('Use TaskOutput to read the answer later');
  });

  it('rejects empty question text and empty option labels at the schema layer', () => {
    expect(
      AskUserQuestionInputSchema.safeParse(input({ question: '' })).success,
    ).toBe(false);
    expect(
      AskUserQuestionInputSchema.safeParse(
        input({
          options: [
            { label: '', description: 'Empty label' },
            { label: 'B', description: '' },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects duplicate question texts across questions (schema + execution)', async () => {
    const duplicated: AskUserQuestionInput = {
      questions: [input().questions[0]!, input().questions[0]!],
    };
    expect(AskUserQuestionInputSchema.safeParse(duplicated).success).toBe(false);

    const { tool, request } = makeTool();
    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_dup_question',
      args: duplicated,
      signal,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('unique');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects duplicate option labels within one question (schema + execution)', async () => {
    const duplicated = input({
      options: [
        { label: 'Postgres', description: 'Relational storage' },
        { label: 'Postgres', description: 'Same label again' },
      ],
    });
    expect(AskUserQuestionInputSchema.safeParse(duplicated).success).toBe(false);

    const { tool, request } = makeTool();
    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_dup_label',
      args: duplicated,
      signal,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('unique');
    expect(request).not.toHaveBeenCalled();
  });

  it('allows the same option label to appear in different questions', async () => {
    const args: AskUserQuestionInput = {
      questions: [
        input().questions[0]!,
        input({ question: 'Which cache?' }).questions[0]!,
      ],
    };
    expect(AskUserQuestionInputSchema.safeParse(args).success).toBe(true);

    const { tool, request } = makeTool();
    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_cross_label',
      args,
      signal,
    });
    expect(result.isError).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects duplicate questions on the background path before starting a task', async () => {
    const { tool, request, taskService } = makeTool();

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_bg_dup',
      args: {
        questions: [input().questions[0]!, input().questions[0]!],
        background: true,
      },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('unique');
    expect(result.output).not.toContain('task_id:');
    expect(request).not.toHaveBeenCalled();
    expect(taskService.registerTask).not.toHaveBeenCalled();
  });

  it('describes the no-Other rule on options and the Recommended hint on label', () => {
    const { tool } = makeTool();
    const params = tool.parameters as {
      properties: {
        questions: {
          items: {
            properties: {
              options: {
                description?: string;
                items: { properties: { label: { description?: string } } };
              };
            };
          };
        };
      };
    };

    const optionsSchema = params.properties.questions.items.properties.options;
    expect(optionsSchema.description).toContain("Do NOT include an 'Other' option");
    expect(optionsSchema.description).toContain('the system adds one automatically');

    const labelSchema = optionsSchema.items.properties.label;
    expect(labelSchema.description).toContain("append '(Recommended)'");
  });

  it('always builds the background-question schema', () => {
    const { tool } = makeTool();

    expect(tool.description).toContain('Set background=true');
    expect(JSON.stringify(tool.parameters)).toContain('background');
  });

  it('dispatches questions through the session question service', async () => {
    const { tool, request, telemetryTrack } = makeTool();

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input({ multi_select: true }),
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe(JSON.stringify({ answers: { Postgres: true } }));
    expect(request).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_question',
        questions: [
          {
            question: 'Which database?',
            header: 'Storage',
            options: [
              { label: 'Postgres', description: 'Relational storage' },
              { label: 'SQLite', description: 'Embedded storage' },
            ],
            multiSelect: true,
          },
        ],
      },
      { signal },
    );
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
    });
  });

  it('passes empty headers and option descriptions through verbatim (v1 wire parity)', async () => {
    const { tool, request } = makeTool();

    await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_empty_fields',
      args: input({
        header: '',
        options: [
          { label: 'Postgres', description: '' },
          { label: 'SQLite', description: '' },
        ],
      }),
      signal,
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            header: '',
            options: [
              { label: 'Postgres', description: '' },
              { label: 'SQLite', description: '' },
            ],
          }),
        ],
      }),
      { signal },
    );
  });

  it('tracks the structured question answer method without leaking it into output', async () => {
    const { tool, telemetryTrack } = makeTool({
      request: async () => ({
        answers: { 'Which database?': 'SQLite' },
        method: 'number_key',
      }),
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input(),
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toBe(JSON.stringify({ answers: { 'Which database?': 'SQLite' } }));
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      method: 'number_key',
    });
  });

  it('starts a background question task and stores the eventual answer in task output', async () => {
    let resolveQuestion!: (result: QuestionResult) => void;
    const questionResult = new Promise<QuestionResult>((resolve) => {
      resolveQuestion = resolve;
    });
    const { tool, taskService, telemetryTrack } = makeTool({
      request: async () => questionResult,
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_background_question',
      args: { ...input(), background: true },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('task_id: question-');
    const outputText = typeof result.output === 'string' ? result.output : '';
    const taskId = /task_id: (?<taskId>question-[0-9a-z]{8})/.exec(outputText)?.groups?.['taskId'];
    expect(taskId).toBeDefined();
    expect(taskService.tasks.getTask(taskId!)).toMatchObject({
      kind: 'question',
      status: 'running',
      questionCount: 1,
      toolCallId: 'call_background_question',
    });

    resolveQuestion({ answers: { 'Which database?': 'SQLite' }, method: 'enter' });
    await taskService.wait(taskId!);

    expect(taskService.tasks.getTask(taskId!)).toMatchObject({ status: 'completed' });
    expect(taskService.entry(taskId!).output).toBe(
      JSON.stringify({ answers: { 'Which database?': 'SQLite' } }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      method: 'enter',
    });
  });

  it('dismisses the underlying question when a background task is killed (v1 broker semantics)', async () => {
    const { tool, request, taskService, telemetryTrack } = makeTool({
      // Emulates the real question service: an abort dismisses the parked
      // entry and resolves with `null` instead of rejecting.
      request: async (_req, requestOptions) =>
        new Promise<QuestionResult>((resolve) => {
          requestOptions?.signal?.addEventListener('abort', () => resolve(null), {
            once: true,
          });
        }),
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_bg_kill',
      args: { ...input(), background: true },
      signal,
    });
    const outputText = typeof result.output === 'string' ? result.output : '';
    const taskId = /task_id: (?<taskId>question-[0-9a-z]{8})/.exec(outputText)?.groups?.['taskId'];
    expect(taskId).toBeDefined();

    // The task signal must reach the question service so a TaskStop actually
    // cancels the pending question instead of leaking it.
    const requestOptions = request.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(requestOptions?.signal).toBeDefined();

    taskService.kill(taskId!);
    await taskService.wait(taskId!);
    // The dismissal resolves the question thunk with the dismissed answers
    // payload, so the task itself completes — matching the v1 runtime.
    expect(taskService.entry(taskId!).status).toBe('completed');
    expect(taskService.entry(taskId!).output).toBe(
      JSON.stringify({ answers: {}, note: 'User dismissed the question without answering.' }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith('question_dismissed');
  });

  it('returns a dismissed message when every question is dismissed', async () => {
    const { tool, telemetryTrack } = makeTool({ request: async () => null });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: {
        questions: [input().questions[0]!, input({ question: 'Which cache?' }).questions[0]!],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('dismissed');
    expect(result.output).toContain('answers');
    expect(telemetryTrack).toHaveBeenCalledWith('question_dismissed');
  });

  it('resolves question service error responses as dismissed answers', async () => {
    const { tool } = makeTool({
      request: async () => {
        throw new KimiError(CoreErrors.codes.INTERNAL, 'question broker error');
      },
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input(),
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('dismissed');
    expect(typeof result.output).toBe('string');
    const output = typeof result.output === 'string' ? result.output : '';
    expect(JSON.parse(output)).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    expect(result.output).not.toContain('Do NOT call this tool again');
  });

  it('propagates aborts while waiting for the question service', async () => {
    const controller = new AbortController();
    const { tool } = makeTool({
      request: async (_req, requestOptions) =>
        new Promise<QuestionResult>((_resolve, reject) => {
          requestOptions?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    });

    const result = executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).rejects.toHaveProperty('name', 'AbortError');
  });

  it('returns a distinct hard error when the host signals unsupported', async () => {
    const { tool } = makeTool({
      request: async () => {
        throw new KimiError(
          CoreErrors.codes.NOT_IMPLEMENTED,
          'Client does not support questions',
        );
      },
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'tc-ask-unsupported',
      args: input(),
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('connected client');
    expect(result.output).toContain('does not support interactive questions');
    expect(result.output).toContain('Do NOT call this tool again');
    expect(result.output).toContain('Ask the user directly in your text response instead');
  });
});
