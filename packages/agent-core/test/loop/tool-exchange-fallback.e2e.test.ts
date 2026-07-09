/**
 * Post-rejection resend fallbacks in `executeLoopStep`.
 *
 * Strict resend: when a strict provider rejects a step with a
 * tool_use/tool_result adjacency 400, the same history would be re-sent every
 * turn and the session would stay stuck forever. `executeLoopStep` resends
 * ONCE with a strict, guaranteed wire-compliant rebuild
 * (`buildMessagesStrict`).
 *
 * Media-degraded resend: when the provider rejects the request BODY as too
 * large (HTTP 413, `APIRequestTooLargeError` — accumulated base64 media, not
 * tokens), the step resends ONCE with the media-degraded projection
 * (`buildMessagesMediaDegraded`), and later steps of the same turn keep using
 * it so each step does not pay a fresh 413.
 *
 * Any other error propagates unchanged and the builders are never consulted.
 */

import { APIRequestTooLargeError, APIStatusError, type Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  createLoopEventDispatcher,
  runTurn,
  type LoopMessageBuilder,
  type RunTurnInput,
} from '../../src/loop/index';
import { CollectingSink } from './fixtures/collecting-sink';
import { FakeLLM, makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { RecordingContext } from './fixtures/recording-context';
import { EchoTool } from './fixtures/tools';

const ADJACENCY_400 = new APIStatusError(
  400,
  'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: ' +
    'toolu_01MWFhDRqdbB4nzCJNuWYiun. Each `tool_use` block must have a corresponding ' +
    '`tool_result` block in the next message.',
);

// The OpenAI-compatible (Moonshot / Kimi) phrasing of the same tool-exchange
// structural rejection. Verbatim from the field, doubled space included.
const MOONSHOT_TOOL_CALL_ID_400 = new APIStatusError(400, '400 tool_call_id  is not found');

// The OpenAI / DeepSeek phrasing of an orphan `tool` result — a `tool` message
// with no preceding assistant `tool_calls`. This is what a DeepSeek / OpenAI-
// compatible provider returns for a history bricked by a stray tool result.
const OPENAI_ROLE_TOOL_400 = new APIStatusError(
  400,
  "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
);

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

interface Harness {
  readonly input: RunTurnInput;
  readonly llm: FakeLLM;
  readonly strictCalls: { count: number };
  readonly strictMessages: Message[];
}

function makeHarness(error: unknown): Harness {
  const llm = new FakeLLM({
    responses: [makeEndTurnResponse('unused'), makeEndTurnResponse('recovered')],
    throwOnIndex: { index: 0, error },
  });
  const context = new RecordingContext({ messages: [userMessage('normal projection')] });
  const sink = new CollectingSink({});
  const strictMessages: Message[] = [userMessage('strict projection')];
  const strictCalls = { count: 0 };
  const buildMessagesStrict: LoopMessageBuilder = () => {
    strictCalls.count += 1;
    return strictMessages;
  };
  const input: RunTurnInput = {
    turnId: 'turn-1',
    signal: new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    buildMessagesStrict,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: sink.emit,
    }),
  };
  return { input, llm, strictCalls, strictMessages };
}

describe('executeLoopStep — tool exchange adjacency fallback', () => {
  it('resends once with strict messages after an adjacency 400 and recovers', async () => {
    const { input, llm, strictCalls, strictMessages } = makeHarness(ADJACENCY_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the strict resend.
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    // The first attempt used the normal projection; the resend used the strict one.
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(strictMessages);
  });

  it('resends once and recovers after a Moonshot tool_call_id-not-found 400', async () => {
    const { input, llm, strictCalls, strictMessages } = makeHarness(MOONSHOT_TOOL_CALL_ID_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the strict resend.
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(strictMessages);
  });

  it('resends once and recovers after an OpenAI/DeepSeek role-tool 400', async () => {
    const { input, llm, strictCalls, strictMessages } = makeHarness(OPENAI_ROLE_TOOL_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the strict resend.
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(strictMessages);
  });

  it('does not resend for an unrelated 400 — the error propagates and strict is untouched', async () => {
    const { input, llm, strictCalls } = makeHarness(new APIStatusError(400, 'Bad request'));

    await expect(runTurn(input)).rejects.toThrow('Bad request');

    expect(llm.callCount).toBe(1);
    expect(strictCalls.count).toBe(0);
  });

  it('resends only once: if the strict rebuild is also rejected, it gives up (no loop)', async () => {
    // Throw a recoverable structural 400 on every attempt; the loop must stop
    // after exactly two provider calls (first attempt + one strict resend).
    const llm = new FakeLLM({ responses: [] });
    let calls = 0;
    llm.chat = async () => {
      calls += 1;
      throw ADJACENCY_400;
    };
    const context = new RecordingContext({ messages: [userMessage('normal')] });
    const sink = new CollectingSink({});
    let strictCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesStrict: () => {
        strictCount += 1;
        return [userMessage('strict')];
      },
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(ADJACENCY_400);
    expect(calls).toBe(2); // first attempt + one strict resend, then give up
    expect(strictCount).toBe(1);
  });
});

describe('executeLoopStep — request-too-large media-degraded fallback', () => {
  const REQUEST_TOO_LARGE = new APIRequestTooLargeError(413, 'Request exceeds the maximum size');

  interface MediaHarness {
    readonly input: RunTurnInput;
    readonly llm: FakeLLM;
    readonly degradedCalls: { count: number };
    readonly degradedMessages: Message[];
    readonly strictCalls: { count: number };
    readonly normalCalls: { count: number };
  }

  function makeMediaHarness(
    error: unknown,
    extra: Partial<Pick<RunTurnInput, 'tools'>> & { responses?: number } = {},
  ): MediaHarness {
    const responseCount = extra.responses ?? 2;
    const llm = new FakeLLM({
      responses: Array.from({ length: responseCount }, (_, index) =>
        makeEndTurnResponse(index === 0 ? 'unused' : 'recovered'),
      ),
      throwOnIndex: { index: 0, error },
    });
    const sink = new CollectingSink({});
    const normalCalls = { count: 0 };
    const normalMessages: Message[] = [userMessage('normal projection')];
    const context = new RecordingContext({ messages: normalMessages });
    const buildMessages: LoopMessageBuilder = () => {
      normalCalls.count += 1;
      return normalMessages;
    };
    const degradedMessages: Message[] = [userMessage('media-degraded projection')];
    const degradedCalls = { count: 0 };
    const buildMessagesMediaDegraded: LoopMessageBuilder = () => {
      degradedCalls.count += 1;
      return degradedMessages;
    };
    const strictCalls = { count: 0 };
    const buildMessagesStrict: LoopMessageBuilder = () => {
      strictCalls.count += 1;
      return [userMessage('strict projection')];
    };
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages,
      buildMessagesStrict,
      buildMessagesMediaDegraded,
      tools: extra.tools,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };
    return { input, llm, degradedCalls, degradedMessages, strictCalls, normalCalls };
  }

  it('resends once with the media-degraded projection after a request-too-large 413 and recovers', async () => {
    const { input, llm, degradedCalls, degradedMessages, strictCalls } =
      makeMediaHarness(REQUEST_TOO_LARGE);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the degraded resend —
    // and the strict builder is never consulted for a body-size rejection.
    expect(llm.callCount).toBe(2);
    expect(degradedCalls.count).toBe(1);
    expect(strictCalls.count).toBe(0);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(degradedMessages);
  });

  it('does not degrade for an unclassified 413 — the error propagates', async () => {
    const { input, llm, degradedCalls } = makeMediaHarness(
      new APIStatusError(413, 'Request failed'),
    );

    await expect(runTurn(input)).rejects.toThrow('Request failed');

    expect(llm.callCount).toBe(1);
    expect(degradedCalls.count).toBe(0);
  });

  it('resends only once: a degraded rebuild that is also rejected gives up (no loop)', async () => {
    const llm = new FakeLLM({ responses: [] });
    let calls = 0;
    llm.chat = async () => {
      calls += 1;
      throw REQUEST_TOO_LARGE;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal')] });
    let degradedCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => {
        degradedCount += 1;
        return [userMessage('degraded')];
      },
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(REQUEST_TOO_LARGE);
    expect(calls).toBe(2); // first attempt + one degraded resend, then give up
    expect(degradedCount).toBe(1);
  });

  it('keeps using the degraded projection for later steps of the same turn', async () => {
    // Step 1 is rejected with a 413 and recovers via the degraded projection,
    // then issues a tool call; step 2 must build from the degraded projection
    // directly — re-sending the full-media history would deterministically
    // pay a fresh 413 on every step.
    const echo = new EchoTool();
    const llm = new FakeLLM({
      responses: [
        makeEndTurnResponse('unused'),
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      throwOnIndex: { index: 0, error: REQUEST_TOO_LARGE },
    });
    const harness = makeMediaHarness(REQUEST_TOO_LARGE);
    const input: RunTurnInput = {
      ...harness.input,
      llm,
      tools: [echo],
    };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(3);
    // Step 1: normal projection rejected, degraded resend recovers.
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(harness.degradedMessages);
    // Step 2: built straight from the degraded projection, not the normal one.
    expect(llm.calls[2]?.messages).toBe(harness.degradedMessages);
    expect(harness.normalCalls.count).toBe(1);
    expect(harness.degradedCalls.count).toBe(2);
    expect(echo.calls).toHaveLength(1);
  });
});
