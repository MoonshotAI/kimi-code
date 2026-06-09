import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { PermissionMode } from '../../src/agent/permission';
import { ErrorCodes, KimiError } from '../../src/errors';
import type { QuestionRequest, QuestionResult } from '../../src/rpc';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionTool,
  type AskUserQuestionInput,
} from '../../src/tools/builtin/collaboration/ask-user';
import { executeTool } from './fixtures/execute-tool';
import { createBackgroundManager } from '../agent/background/helpers';

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
    readonly mode?: PermissionMode;
    readonly requestQuestion?: (
      request: QuestionRequest,
      options: { readonly signal?: AbortSignal },
    ) => Promise<QuestionResult>;
  } = {},
): {
  readonly tool: AskUserQuestionTool;
  readonly requestQuestion: ReturnType<typeof vi.fn>;
  readonly telemetryTrack: ReturnType<typeof vi.fn>;
} {
  const requestQuestion = vi.fn(
    options.requestQuestion ??
      (async () => ({
        Postgres: true,
      })),
  );
  const telemetryTrack = vi.fn();
  const agent = {
    permission: { mode: options.mode ?? 'manual' },
    rpc: { requestQuestion },
    telemetry: { track: telemetryTrack },
  } as unknown as Agent;
  return { tool: new AskUserQuestionTool(agent), requestQuestion, telemetryTrack };
}

describe('AskUserQuestionTool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    const agent = {
      rpc: { requestQuestion: vi.fn() },
      telemetry: { track: vi.fn() },
      background: createBackgroundManager().manager,
    } as unknown as Agent;

    const tool = new AskUserQuestionTool(agent);

    expect(tool.description).toContain('Set background=true');
    expect(JSON.stringify(tool.parameters)).toContain('background');
  });

  it.each(['manual', 'yolo'] as const)(
    'dispatches questions through the agent rpc in %s mode',
    async (mode) => {
      const { tool, requestQuestion, telemetryTrack } = makeTool({ mode });

      const result = await executeTool(tool, {
        turnId: '0',
        toolCallId: 'call_question',
        args: input({ multi_select: true }),
        signal,
      });

      expect(result.isError).toBe(false);
      expect(result.output).toBe(JSON.stringify({ answers: { Postgres: true } }));
      expect(requestQuestion).toHaveBeenCalledWith(
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
    },
  );

  it('tracks the structured question answer method without leaking it into output', async () => {
    const { tool, telemetryTrack } = makeTool({
      requestQuestion: async () => ({
        answers: { 'Which database?': 'SQLite' },
        method: 'number_key',
      }),
    });

    const result = await executeTool(tool, {
      turnId: '0',
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
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');

    let resolveQuestion!: (result: QuestionResult) => void;
    const questionResult = new Promise<QuestionResult>((resolve) => {
      resolveQuestion = resolve;
    });
    const { manager } = createBackgroundManager();
    const requestQuestion = vi.fn(async () => questionResult);
    const telemetryTrack = vi.fn();
    const agent = {
      rpc: { requestQuestion },
      telemetry: { track: telemetryTrack },
      background: manager,
    } as unknown as Agent;
    const tool = new AskUserQuestionTool(agent);
    expect(tool.description).toContain('Set background=true');

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_background_question',
      args: { ...input(), background: true },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('task_id: question-');
    const outputText = typeof result.output === 'string' ? result.output : '';
    const taskId = /task_id: (?<taskId>question-[0-9a-z]{8})/.exec(outputText)?.groups?.['taskId'];
    expect(taskId).toBeDefined();
    expect(manager.getTask(taskId!)).toMatchObject({
      kind: 'question',
      status: 'running',
      questionCount: 1,
      toolCallId: 'call_background_question',
    });

    resolveQuestion({ answers: { 'Which database?': 'SQLite' }, method: 'enter' });
    await manager.wait(taskId!);

    expect(manager.getTask(taskId!)).toMatchObject({ status: 'completed' });
    expect(await manager.readOutput(taskId!)).toBe(
      JSON.stringify({ answers: { 'Which database?': 'SQLite' } }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      method: 'enter',
    });
  });

  it('starts background questions without an experimental flag', async () => {
    let resolveQuestion!: (result: QuestionResult) => void;
    const questionResult = new Promise<QuestionResult>((resolve) => {
      resolveQuestion = resolve;
    });
    const { manager } = createBackgroundManager();
    const requestQuestion = vi.fn(async () => questionResult);
    const agent = {
      rpc: { requestQuestion },
      telemetry: { track: vi.fn() },
      background: manager,
    } as unknown as Agent;
    const tool = new AskUserQuestionTool(agent);
    expect(tool.description).toContain('Set background=true');

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_bg_enabled',
      args: { ...input(), background: true },
      signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('task_id: question-');
    const outputText = typeof result.output === 'string' ? result.output : '';
    const taskId = /task_id: (?<taskId>question-[0-9a-z]{8})/.exec(outputText)?.groups?.['taskId'];
    expect(taskId).toBeDefined();
    expect(manager.getTask(taskId!)).toMatchObject({ status: 'running' });

    resolveQuestion({ answers: { Postgres: true } });
    await manager.wait(taskId!);
  });

  it('returns a dismissed message when every question is dismissed', async () => {
    const { tool, telemetryTrack } = makeTool({ requestQuestion: async () => null });

    const result = await executeTool(tool, {
      turnId: '0',
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

  it('resolves question rpc error responses as dismissed answers', async () => {
    const { tool } = makeTool({
      requestQuestion: async () => {
        throw new KimiError(ErrorCodes.INTERNAL, 'JSON-RPC question error response');
      },
    });

    const result = await executeTool(tool, {
      turnId: '0',
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

  it('propagates aborts while waiting for question rpc', async () => {
    const controller = new AbortController();
    const { tool } = makeTool({
      requestQuestion: async (_request, options) =>
        new Promise<QuestionResult>((_resolve, reject) => {
          options.signal?.addEventListener(
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
      turnId: '0',
      toolCallId: 'call_question',
      args: input(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).rejects.toHaveProperty('name', 'AbortError');
  });

  // Migrated from PR #107:
  // py: tests/tools/test_ask_user.py::test_ask_user_client_unsupported.
  it('returns a distinct hard error when the client signals unsupported', async () => {
    const { tool } = makeTool({
      requestQuestion: async () => {
        throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, 'Client does not support questions');
      },
    });

    const result = await executeTool(tool, {
      turnId: '0',
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
