// The napi cancel path against the built kimi_agent.node addon. Mirrors the
// stdio cancel smoke: cancel mid-turn from the first llm callback and expect
// the turn to stop at the next step boundary with stopReason "Aborted".
// Requires the addon (`cargo build -p kimi-agent --features napi`), same as
// napi-integration.test.ts.
import { createRequire } from 'node:module';

import { expect, test } from 'vitest';

const nativeRequire = createRequire(import.meta.url);

test('cancelTurnRust aborts a running napi turn at the next step boundary', async () => {
  const native = nativeRequire('./kimi_agent.node');
  expect(typeof native.cancelTurnRust).toBe('function');
  // No such turn yet — must report false, not throw.
  expect(native.cancelTurnRust('nope')).toBe(false);

  let llmCalls = 0;
  const llmChatCb = (callbackId) => {
    const payload = native.getCallbackPayload(callbackId);
    if (!payload) return;
    llmCalls++;
    if (llmCalls === 1) {
      // Cancel mid-turn, then answer with a tool call that WOULD continue.
      expect(native.cancelTurnRust('napi-t1')).toBe(true);
      native.resolveCallback(
        callbackId,
        null,
        JSON.stringify({
          tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    native.resolveCallback(
      callbackId,
      null,
      JSON.stringify({
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    );
  };
  const executeToolCb = (callbackId) => {
    const payload = native.getCallbackPayload(callbackId);
    if (!payload) return;
    native.resolveCallback(
      callbackId,
      null,
      JSON.stringify({ content: 'ok', is_error: false }),
    );
  };

  const result = await native.runTurnRust(
    {
      turnId: 'napi-t1',
      systemPrompt: 'smoke',
      modelName: 'mock',
      messages: [],
      tools: [{ name: 'noop', description: 'noop', inputSchema: '{"type":"object"}' }],
      maxSteps: 5,
    },
    llmChatCb,
    executeToolCb,
  );

  expect(result.stopReason).toBe('Aborted');
  expect(llmCalls).toBe(1);
  // The finished turn is deregistered — cancelling again reports false.
  expect(native.cancelTurnRust('napi-t1')).toBe(false);
}, 15000);
