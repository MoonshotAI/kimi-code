import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, KimiError } from '../../../src/errors';
import { IQuestionService, type QuestionResult } from '../../../src/services';
import { testAgent } from './harness';

describe('Agent question', () => {
  it('roundtrips a question request through wire rpc', async () => {
    const ctx = testAgent();

    const resultPromise = ctx.service(IQuestionService).request({
      sessionId: 'session-1',
      agentId: 'agent-1',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    });

    expect(await ctx.untilQuestion({ Yes: true })).toMatchInlineSnapshot(
      `[emit] requestQuestion   { "questions": [ { "question": "Pick one", "options": [ { "label": "Yes" }, { "label": "No" } ] } ] }`,
    );

    await expect(resultPromise).resolves.toEqual({ Yes: true });
    await ctx.expectResumeMatches();
  });

  it('sends multiple questions in one request', async () => {
    const ctx = testAgent();

    const resultPromise = ctx.service(IQuestionService).request({
      sessionId: 'session-1',
      agentId: 'agent-1',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
        {
          question: 'Pick storage',
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        },
      ],
    });

    expect(
      await ctx.untilQuestion({ Yes: true, 'Pick storage': 'Postgres' }),
    ).toMatchInlineSnapshot(
      `[emit] requestQuestion   { "questions": [ { "question": "Pick one", "options": [ { "label": "Yes" }, { "label": "No" } ] }, { "question": "Pick storage", "options": [ { "label": "Postgres" }, { "label": "SQLite" } ] } ] }`,
    );

    await expect(resultPromise).resolves.toEqual({ Yes: true, 'Pick storage': 'Postgres' });
    await ctx.expectResumeMatches();
  });

  it('registers AskUserQuestion and routes model calls through question service', async () => {
    const telemetry = { track: vi.fn() };
    const ctx = testAgent({
      telemetry,
    });
    ctx.configure({ tools: ['AskUserQuestion'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'AskUserQuestion')).toMatchObject({
      active: true,
      name: 'AskUserQuestion',
      source: 'builtin',
    });

    ctx.mockNextResponse(
      { type: 'text', text: 'I need one choice.' },
      askQuestionCall('call_question'),
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Ask me.' }] });
    await ctx.untilQuestion({
      answers: { 'Pick one': 'Yes' },
      method: 'number_key',
    });

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: AskUserQuestion
      messages:
        user: text "Ask me."
    `);
    expect(requestQuestionArgs(ctx, 'call_question')).toEqual({
      turnId: 0,
      toolCallId: 'call_question',
      questions: [
        {
          question: 'Pick one',
          header: '',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
          multiSelect: false,
        },
      ],
    });

    ctx.mockNextResponse({ type: 'text', text: 'Thanks for answering.' });
    await ctx.untilTurnEnd();

    expect(toolResultArgs(ctx, 'call_question')).toMatchObject({
      output: JSON.stringify({ answers: { 'Pick one': 'Yes' } }),
    });
    expect(telemetry.track).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      method: 'number_key',
    });
    expect(String(toolResultArgs(ctx, 'call_question').output)).not.toContain('number_key');
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I need one choice."  calls call_question:AskUserQuestion { "questions": [ { "question": "Pick one", "options": [ { "label": "Yes" }, { "label": "No" } ] } ] }
        tool[call_question]: text "{\\"answers\\":{\\"Pick one\\":\\"Yes\\"}}"
    `);
    await ctx.expectResumeMatches();
  });

  it('returns a dismissed answer when the user dismisses AskUserQuestion', async () => {
    const telemetry = { track: vi.fn() };
    const ctx = testAgent({ telemetry });
    ctx.configure({ tools: ['AskUserQuestion'] });

    ctx.mockNextResponse(
      { type: 'text', text: 'I need one choice.' },
      askQuestionCall('call_dismissed'),
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Ask me.' }] });
    await ctx.untilQuestion(null);

    ctx.mockNextResponse({ type: 'text', text: 'No answer was provided.' });
    await ctx.untilTurnEnd();

    expect(JSON.parse(String(toolResultArgs(ctx, 'call_dismissed').output))).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    expect(telemetry.track).toHaveBeenCalledWith('question_dismissed', undefined);
  });

  it('returns a hard error when the question service reports unsupported questions', async () => {
    const ctx = testAgent({
      questionService: unsupportedQuestionService(),
    });
    ctx.configure({ tools: ['AskUserQuestion'] });

    ctx.mockNextResponse(
      { type: 'text', text: 'I need one choice.' },
      askQuestionCall('call_unsupported'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'I will ask directly instead.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Ask me.' }] });
    await ctx.untilTurnEnd();

    expect(toolResultArgs(ctx, 'call_unsupported')).toMatchObject({
      isError: true,
      output: expect.stringContaining('does not support interactive questions'),
    });
    expect(String(toolResultArgs(ctx, 'call_unsupported').output)).toContain(
      'Do NOT call this tool again',
    );
    expect(requestQuestionArgs(ctx, 'call_unsupported')).toBeUndefined();
  });
});

function askQuestionCall(id: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'AskUserQuestion',
    arguments: JSON.stringify({
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    }),
  };
}

function requestQuestionArgs(
  ctx: ReturnType<typeof testAgent>,
  toolCallId: string,
): unknown {
  return rpcArgs(ctx, 'requestQuestion', toolCallId);
}

function toolResultArgs(
  ctx: ReturnType<typeof testAgent>,
  toolCallId: string,
): { readonly output?: unknown; readonly isError?: boolean } {
  const args = rpcArgs(ctx, 'tool.result', toolCallId);
  expect(args).toBeDefined();
  return args as { readonly output?: unknown; readonly isError?: boolean };
}

function rpcArgs(
  ctx: ReturnType<typeof testAgent>,
  event: string,
  toolCallId: string,
): unknown {
  return ctx.allEvents.find((entry) => {
    if (entry.type !== '[rpc]' || entry.event !== event) return false;
    const args = entry.args as { readonly toolCallId?: string };
    return args.toolCallId === toolCallId;
  })?.args;
}

function unsupportedQuestionService(): IQuestionService {
  return {
    _serviceBrand: undefined,
    request: async (): Promise<QuestionResult> => {
      throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, 'Client does not support questions');
    },
    resolve: () => {},
    dismiss: () => {},
    listPending: () => [],
  };
}
