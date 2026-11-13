import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import {
  AskUserQuestionInputSchema,
  IAskUserQuestionTool,
  type AskUserQuestionInput,
} from '#/agent/tools/ask-user-question/ask-user-question';
import { AskUserQuestionTool } from '#/agent/tools/ask-user-question/askUserQuestionTool';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type {
  QuestionRequest,
  QuestionResult,
} from '#/agent/interaction/question';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TURN_ID,
} from '#/human/interaction/interaction';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { executeTool } from '../../../tools/fixtures/execute-tool';
import {
  LegacyExecutableToolAdapter,
  memoryOutputStore,
  ToolExecutor as HandlerToolExecutor,
  type LegacyToolAgentContext,
  type ToolExecutionResponse,
} from '#/tool/executor';

const signal = new AbortController().signal;
const TASK_TOOLS = new Set(['TaskList', 'TaskOutput', 'TaskStop']);
const TEST_SESSION_ID = 'ask-user-test';

let disposables: DisposableStore;

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
    readonly activeTaskTools?: ReadonlySet<string>;
    readonly nonInteractive?: boolean;
    readonly request?: (
      req: QuestionRequest,
      requestOptions?: { readonly agentId?: string; readonly detached?: boolean },
    ) => Promise<QuestionResult>;
  } = {},
) {
  const request = vi.fn(options.request ?? (async () => ({ Postgres: true }) as QuestionResult));
  const telemetryTrack = vi.fn();
  const activeTaskTools = options.activeTaskTools ?? TASK_TOOLS;
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.definePartialInstance(ISessionContext, { sessionId: TEST_SESSION_ID });
      reg.definePartialInstance(ITelemetryService, { track2: telemetryTrack });
      reg.definePartialInstance(IAgentScopeContext, { agentId: 'main' });
      reg.definePartialInstance(IAgentToolPolicyService, {
        isToolActive: (name: string) => activeTaskTools.has(name),
      });
      reg.definePartialInstance(IBootstrapService, {
        args: { requestHeaders: {}, nonInteractive: options.nonInteractive },
      });
      reg.define(IAskUserQuestionTool, AskUserQuestionTool);
    },
    strict: true,
  });
  const seen = new Set<string>();
  const answerNewPending = (): void => {
    for (const pending of interactions.findAll({
      kind: 'question',
      resolved: false,
      tags: { sessionId: TEST_SESSION_ID },
    })) {
      if (seen.has(pending.id)) continue;
      seen.add(pending.id);
      const agentId = pending.tags[INTERACTION_TAG_AGENT_ID];
      void request(pending.payload as QuestionRequest, {
        agentId: typeof agentId === 'string' ? agentId : 'main',
        detached: pending.tags[INTERACTION_TAG_TURN_ID] === undefined,
      }).then((result) => {
        interactions.respond(pending.id, result);
      });
    }
  };
  disposables.add(toDisposable(interactions.onDidChangePending(answerNewPending)));
  const tool = ix.get(IAskUserQuestionTool);
  const outputStore = memoryOutputStore();
  const executor = new HandlerToolExecutor<LegacyToolAgentContext>([], { outputStore });
  executor.addExecute(new LegacyExecutableToolAdapter(tool));
  return { tool, request, telemetryTrack, executor, outputStore };
}

describe('AskUserQuestionTool', () => {
  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
    interactions.purgeSession(TEST_SESSION_ID);
  });

  it('exposes current metadata and schema', () => {
    const { tool } = makeTool();

    expect(tool.name).toBe('AskUserQuestion');
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

  it('exposes background mode when all task controls are active', () => {
    const { tool } = makeTool();
    const params = tool.parameters as {
      properties: { background?: { type?: string; default?: boolean } };
    };

    expect(params.properties.background?.type).toBe('boolean');
    expect(params.properties.background?.default).toBe(false);
    expect(tool.description).toContain('background=true');
    expect(tool.description).toContain('task_id');
  });

  it('hides and rejects background mode after a task control becomes inactive', async () => {
    const activeTaskTools = new Set(TASK_TOOLS);
    const { tool, request } = makeTool({
      activeTaskTools,
    });

    expect(tool.parameters).toHaveProperty('properties.background');
    activeTaskTools.delete('TaskStop');

    const params = tool.parameters as { properties: Record<string, unknown> };

    expect(params.properties).not.toHaveProperty('background');
    expect(tool.description.toLowerCase()).not.toContain('background');
    expect(tool.description).not.toContain('task_id');
    expect(tool.description).not.toContain('TaskOutput');

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_bg_disabled',
      args: { ...input(), background: true },
      signal,
    });

    expect(result).toEqual({
      isError: true,
      output:
        'Background questions are not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves foreground answers when background mode is unavailable', async () => {
    const { tool, request } = makeTool({ activeTaskTools: new Set() });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_fg_disabled',
      args: input(),
      signal,
    });

    expect(result).toEqual({
      isError: false,
      output: JSON.stringify({ answers: { Postgres: true } }),
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('preserves foreground dismissal when background mode is unavailable', async () => {
    const { tool } = makeTool({
      activeTaskTools: new Set(),
      request: async () => null,
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_fg_dismissed',
      args: input(),
      signal,
    });

    expect(result).toEqual({
      isError: false,
      output: JSON.stringify({
        answers: {},
        note: 'User dismissed the question without answering.',
      }),
    });
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
      { agentId: 'main', detached: false },
    );
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      request_id: undefined,
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
      { agentId: 'main', detached: false },
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
      request_id: undefined,
    });
  });

  it('merges the request trace id into question telemetry', async () => {
    const { tool, telemetryTrack } = makeTool();

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input(),
      signal,
      trace: { requestId: 'trace-q-1' },
    });

    expect(result).toMatchObject({ isError: false });
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      request_id: 'trace-q-1',
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
    expect(telemetryTrack).toHaveBeenCalledWith('question_dismissed', { request_id: undefined });
  });

  it('resolves dismissed when the waiting question is aborted', async () => {
    const controller = new AbortController();
    const { tool } = makeTool();
    const resolutions: unknown[] = [];
    disposables.add(toDisposable(interactions.onDidResolve((event) => resolutions.push(event.response))));

    const result = executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).resolves.toMatchObject({ isError: false });
    const settled = await result;
    const output = typeof settled.output === 'string' ? settled.output : '';
    expect(JSON.parse(output)).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    expect(resolutions).toEqual([{ cancelled: true, reason: 'turn_ended' }]);
  });

  it('answers at once without asking anyone when the host is non-interactive', async () => {
    const { tool, request } = makeTool({ nonInteractive: true });

    for (const background of [false, true]) {
      const result = await executeTool(tool, {
        turnId: 0,
        toolCallId: `call_non_interactive_${String(background)}`,
        args: { ...input(), background },
        signal,
      });
      expect(result).toMatchObject({
        isError: true,
        output: 'Nobody can answer questions in a non-interactive run.',
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  describe('background mode', () => {
    function startQuestion(
      executor: ReturnType<typeof makeTool>['executor'],
      toolCallId: string,
      turnId = 0,
    ) {
      return executor.execute({
        type: 'function',
        id: toolCallId,
        name: 'AskUserQuestion',
        arguments: JSON.stringify({ ...input(), background: true }),
      }, { turnId });
    }

    function text(response: ToolExecutionResponse): string {
      return response.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
    }

    it('returns a task_id immediately without awaiting the answer', async () => {
      let answer!: (result: QuestionResult) => void;
      const pending = new Promise<QuestionResult>((resolve) => {
        answer = resolve;
      });
      const { request, executor } = makeTool({ request: () => pending });
      const handler = startQuestion(executor, 'call_bg');
      const acknowledgement = await handler;

      expect(acknowledgement).toMatchObject({ detached: true, taskId: handler.taskId });
      expect(text(acknowledgement)).toBe(
        [
          `task_id: ${handler.taskId}`,
          'status: running',
          'next_step: Continue your work; the answer arrives automatically in a later message. Use TaskStop only to cancel the question.',
        ].join('\n'),
      );
      expect(handler.snapshot().fields).toMatchObject({
        task: { kind: 'question', questionCount: 1, toolCallId: 'call_bg' },
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      answer(null);
      await handler.wait();
    });

    it('runs the question in the background task and settles completed with the answer', async () => {
      const { executor, outputStore } = makeTool();
      const handler = startQuestion(executor, 'call_bg_run');
      await handler;
      const terminal = await handler.wait();

      const expected = JSON.stringify({ answers: { Postgres: true } });
      expect(text(terminal)).toBe(expected);
      expect(handler.output().preview).toBe(expected);
      expect(outputStore.open(handler.taskId).preview().preview).toBe(expected);
      expect(handler.snapshot()).toMatchObject({ status: 'success', detached: true });
    });

    it('detaches with the existing acknowledgement but resolves the Core tool only at the real terminal state', async () => {
      let answer!: (result: QuestionResult) => void;
      const answerPending = new Promise<QuestionResult>((resolve) => {
        answer = resolve;
      });
      const { request, executor } = makeTool({ request: () => answerPending });
      const handler = startQuestion(executor, 'call_bg_detached', 4);
      const acknowledgement = await handler;
      let settled = false;
      const running = handler.wait();
      void running.then(() => {
        settled = true;
      });

      expect(acknowledgement).toMatchObject({ detached: true, taskId: handler.taskId });
      expect(settled).toBe(false);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]![0]).toMatchObject({ turnId: 4, toolCallId: 'call_bg_detached' });
      expect(request.mock.calls[0]![1]).toMatchObject({ detached: true });
      answer({ Postgres: true });

      expect(text(await running)).toBe(JSON.stringify({ answers: { Postgres: true } }));
      expect(handler.output().preview).toBe(JSON.stringify({ answers: { Postgres: true } }));
    });

    it('settles completed with a dismissed result when the background task is aborted', async () => {
      let answer!: (result: QuestionResult) => void;
      const pending = new Promise<QuestionResult>((resolve) => {
        answer = resolve;
      });
      const { executor } = makeTool({ request: () => pending });
      const handler = startQuestion(executor, 'call_bg_abort');
      await handler;
      const terminal = await handler.stop('cancelled by test');

      expect(terminal.outcome.type).toBe('aborted');
      expect(handler.snapshot()).toMatchObject({
        status: 'aborted',
        stopReason: 'cancelled by test',
        fields: { task: { kind: 'question', questionCount: 1 } },
      });
      answer(null);
      await handler.wait();
    });
  });
});
