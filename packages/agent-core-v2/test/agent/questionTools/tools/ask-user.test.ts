/**
 * AskUserQuestionTool unit tests — ported from v1
 * `packages/agent-core/test/tools/ask-user.test.ts` and adapted to the v2 DI
 * constructor (`ISessionQuestionService` / `ITelemetryService` stubs instead
 * of a fake `Agent`).
 */

import { describe, expect, it, vi } from 'vitest';

import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionTool,
  type AskUserQuestionInput,
} from '#/agent/questionTools/tools/ask-user';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTaskService } from '#/agent/task/task';
import type {
  ISessionQuestionService,
  QuestionRequest,
  QuestionResult,
} from '#/session/question/question';
import type { QuestionBackgroundTask } from '#/agent/questionTools/tools/question-background-task';
import { executeTool } from '../../../tools/fixtures/execute-tool';

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
  readonly registerTask: ReturnType<typeof vi.fn>;
  readonly getTask: ReturnType<typeof vi.fn>;
  readonly lastRegisteredTask: () => QuestionBackgroundTask | undefined;
} {
  const request = vi.fn(options.request ?? (async () => ({ Postgres: true }) as QuestionResult));
  const telemetryTrack = vi.fn();
  const question = { request } as unknown as ISessionQuestionService;
  const telemetry = { track2: telemetryTrack } as unknown as ITelemetryService;
  let lastTask: QuestionBackgroundTask | undefined;
  const registerTask = vi.fn((task: QuestionBackgroundTask) => {
    lastTask = task;
    return 'q_test_task_id';
  });
  const getTask = vi.fn((id: string) =>
    id === 'q_test_task_id' ? { status: 'running' } : undefined,
  );
  const tasks = { registerTask, getTask } as unknown as IAgentTaskService;
  const tool = new AskUserQuestionTool(question, telemetry, tasks);
  return { tool, request, telemetryTrack, registerTask, getTask, lastRegisteredTask: () => lastTask };
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

  it('exposes background question controls (v1-aligned)', () => {
    const { tool } = makeTool();
    const paramsJson = JSON.stringify(tool.parameters);

    expect(tool.description).toContain('Set background=true');
    expect(tool.description).toContain('task_id');
    expect(paramsJson).toContain('background');
    expect(paramsJson).toContain('TaskOutput');
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

  it('builds the v1-aligned schema including an optional background flag', () => {
    const { tool } = makeTool();
    const params = tool.parameters as {
      properties: { background?: { type?: string; default?: boolean; description?: string } };
    };

    expect(tool.description).toContain('Set background=true');
    expect(params.properties.background?.type).toBe('boolean');
    expect(params.properties.background?.default).toBe(false);
    expect(params.properties.background?.description).toContain('task_id');
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
        throw new Error2(CoreErrors.codes.INTERNAL, 'question broker error');
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
        throw new Error2(
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

  describe('background mode', () => {
    function makeSink(abortSignal?: AbortSignal) {
      const outputs: string[] = [];
      const settlements: Array<{ status: string; stopReason?: string }> = [];
      const sink = {
        signal: abortSignal ?? new AbortController().signal,
        appendOutput: (chunk: string) => {
          outputs.push(chunk);
        },
        settle: async (settlement: { status: string; stopReason?: string }) => {
          settlements.push(settlement);
          return true;
        },
      };
      return { sink, outputs, settlements };
    }

    it('returns a task_id immediately without awaiting the answer', async () => {
      const { tool, request, registerTask, getTask } = makeTool();
      const result = await executeTool(tool, {
        turnId: 0,
        toolCallId: 'call_bg',
        args: { ...input(), background: true },
        signal,
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain('task_id: q_test_task_id');
      expect(result.output).toContain('automatic_notification: true');
      expect(result.output).toContain('/tasks');
      expect(result.message).toBe('Started q_test_task_id');
      expect(registerTask).toHaveBeenCalledOnce();
      expect(registerTask.mock.calls[0]![1]).toMatchObject({ detached: true });
      expect(getTask).toHaveBeenCalledWith('q_test_task_id');
      expect(request).not.toHaveBeenCalled();
    });

    it('runs the question in the background task and settles completed with the answer', async () => {
      const { tool, lastRegisteredTask } = makeTool();
      await executeTool(tool, {
        turnId: 0,
        toolCallId: 'call_bg_run',
        args: { ...input(), background: true },
        signal,
      });

      const task = lastRegisteredTask();
      expect(task).toBeDefined();
      const { sink, outputs, settlements } = makeSink();
      await task!.start(sink);

      expect(outputs).toEqual([JSON.stringify({ answers: { Postgres: true } })]);
      expect(settlements).toEqual([{ status: 'completed' }]);
    });

    it('settles killed when the background task is aborted', async () => {
      const controller = new AbortController();
      const { tool, lastRegisteredTask } = makeTool({
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
      await executeTool(tool, {
        turnId: 0,
        toolCallId: 'call_bg_abort',
        args: { ...input(), background: true },
        signal,
      });

      const task = lastRegisteredTask();
      const { sink, settlements } = makeSink(controller.signal);
      const run = task!.start(sink);
      controller.abort();
      await run;

      expect(settlements).toEqual([{ status: 'killed' }]);
    });
  });
});
