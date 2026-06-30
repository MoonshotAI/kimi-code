/**
 * Post-400 strict-resend fallback.
 *
 * When a strict provider rejects a step with a tool_use/tool_result adjacency
 * 400, the same history would be re-sent every turn and the session would stay
 * stuck forever. `executeLoopStep` resends ONCE with a strict, guaranteed
 * wire-compliant rebuild (`buildMessagesStrict`). Any other error propagates
 * unchanged and the strict builder is never consulted.
 */

import { APIStatusError, type Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  createLoopEventDispatcher,
  runTurn,
  type LoopMessageBuilder,
  type RunTurnInput,
} from '../../src/loop/index';
import { CollectingSink } from './fixtures/collecting-sink';
import { FakeLLM, makeEndTurnResponse } from './fixtures/fake-llm';
import { RecordingContext } from './fixtures/recording-context';

const ADJACENCY_400 = new APIStatusError(
  400,
  'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: ' +
    'toolu_01MWFhDRqdbB4nzCJNuWYiun. Each `tool_use` block must have a corresponding ' +
    '`tool_result` block in the next message.',
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
