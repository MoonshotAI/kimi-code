import { emptyUsage, type ToolCall } from '#/app/llmProtocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentProfileService } from '#/index';
import { IAgentLLMRequesterService, type LLMStreamTiming } from '#/agent/llmRequester';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentLoopService } from '#/agent/loop';
import type { ExecutableTool } from '#/agent/tool';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { agentService, createTestAgent, type TestAgentContext } from '../harness';

describe('Agent loop', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(() => {
    ctx = createTestAgent();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('resolves the loop service from the agent scope by interface', () => {
    expect(loop).toBeDefined();
  });

  it('runs a text-only agent turn from prompt to completion', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools   { "names": [], "time": "<time>" }
      [wire] context.splice           { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
      [wire] turn.launch              { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started             { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started        { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] thinking.delta           { "turnId": 0, "delta": "<think-1>" }
      [emit] assistant.delta          { "turnId": 0, "delta": "<text-1>" }
      [wire] usage.record             { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated     { "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice           { "start": 1, "deleteCount": 0, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "think", "think": "<think-1>" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context.splice           { "start": 1, "deleteCount": 1, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "think", "think": "<think-1>" }, { "type": "text", "text": "<text-1>" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context_size.measured    { "length": 2, "tokens": 11, "time": "<time>" }
      [emit] agent.status.updated     { "contextTokens": 11 }
      [wire] context.splice           { "start": 1, "deleteCount": 1, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "think", "think": "<think-1>" }, { "type": "text", "text": "<text-1>" } ], "toolCalls": [], "providerMessageId": "mock-1" } ], "time": "<time>" }
      [emit] agent.status.updated     { "contextTokens": 0 }
      [emit] turn.step.completed      { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "completed" }
      [emit] turn.ended               { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  });

  it('fails the turn after a filtered step completes', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.splice          { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
      [wire] turn.launch             { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started            { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started       { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta         { "turnId": 0, "delta": "blocked" }
      [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context_size.measured   { "length": 2, "tokens": 8, "time": "<time>" }
      [wire] context.splice          { "start": 1, "deleteCount": 0, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "text", "text": "blocked" } ], "toolCalls": [], "providerMessageId": "mock-1" } ], "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 8 }
      [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "filtered" }
      [emit] turn.ended              { "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered", "turnId": 0 }, "retryable": false } }
      [emit] error                   { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered", "turnId": 0 }, "retryable": false }
    `);

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );

    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'filtered',
    });
  });

  it('lets onError recover a non-context loop error by retrying', async () => {
    profile.update({ activeToolNames: [] });
    const seenErrors: Array<{ readonly step: number | undefined; readonly message: string }> = [];

    loop.hooks.onError.register('test-recover-generate-error', async (hookCtx, next) => {
      seenErrors.push({
        step: hookCtx.step,
        message: hookCtx.error instanceof Error ? hookCtx.error.message : String(hookCtx.error),
      });
      if (seenErrors.length === 1) {
        ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
        hookCtx.retry = true;
        return;
      }
      await next();
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(seenErrors).toEqual([
      { step: 1, message: 'Unexpected generate call #1' },
    ]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('does not run onError for aborted turns', async () => {
    let called = false;
    loop.hooks.onError.register('test-abort-not-recoverable', async (_hookCtx, next) => {
      called = true;
      await next();
    });
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    const result = await loop.run({ turnId: 0, signal: controller.signal });

    expect(result.reason).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('fails with the onError handler error when recovery throws', async () => {
    const recoveryError = new Error('recovery failed');
    loop.hooks.onError.register('test-throw-recovery-error', async () => {
      throw recoveryError;
    });

    const result = await loop.run({ turnId: 0 });

    expect(result.reason).toBe('failed');
    if (result.reason === 'failed') {
      expect(result.error).toBe(recoveryError);
    }
  });

  it('runs an agent turn through registered tool approval and execution', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up moon' }],
    });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools   { "names": [ "Lookup" ], "time": "<time>" }
      [wire] context.splice           { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
      [wire] turn.launch              { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started             { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started        { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta          { "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta          { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [wire] usage.record             { "model": "mock-model", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated     { "usage": { "byModel": { "mock-model": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice           { "start": 1, "deleteCount": 0, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [] } ], "time": "<time>" }
      [emit] requestApproval          { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Lookup
    messages:
      user: text "Look up moon"
  `);

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [wire] context.splice                      { "start": 1, "deleteCount": 1, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] } ], "time": "<time>" }
      [wire] context_size.measured               { "length": 2, "tokens": 20, "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 20 }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [wire] context.splice                      { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "lookup-result" } ], "toolCalls": [], "toolCallId": "call_lookup", "id": "<msg-3>" } ], "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_lookup", "output": "lookup-result" }
      [wire] context.splice                      { "start": 1, "deleteCount": 1, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ], "providerMessageId": "mock-1" } ], "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 0 }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_calls" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "The lookup result is lookup-result." }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated                { "usage": { "byModel": { "mock-model": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice                      { "start": 3, "deleteCount": 0, "messages": [ { "id": "<msg-4>", "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is lookup-result." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context_size.measured               { "length": 4, "tokens": 37, "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 37 }
      [wire] context.splice                      { "start": 3, "deleteCount": 1, "messages": [ { "id": "<msg-4>", "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is lookup-result." } ], "toolCalls": [], "providerMessageId": "mock-2" } ], "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 0 }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "completed" }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    messages:
      <last>
      assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
      tool[call_lookup]: text "lookup-result"
  `);
  });

  it('lets non-external stop hooks continue a turn more than once', async () => {
    profile.update({ activeToolNames: [] });
    let continuations = 0;
    loop.hooks.afterStep.register('test-repeat-stop-continuation', async (hookCtx, next) => {
      if (continuations < 2) {
        continuations += 1;
        const prompt = `continue ${continuations}`;
        const context = ctx.get(IAgentContextMemoryService);
        context.splice(context.get().length, 0, [{
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          toolCalls: [],
          origin: { kind: 'system_trigger', name: 'stop_hook' },
        }]);
        hookCtx.continue = true;
        return;
      }
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Third answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(continuations).toBe(2);
    expect(ctx.llmCalls).toHaveLength(3);
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 1' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 2' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
  });
});

describe('step timing split propagation', () => {
  it('carries the split from the llmRequester timing event to the turn.step.completed protocol event', async () => {
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, createTimingRequester()));
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await ctx.untilTurnEnd();

      const stepCompleted = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
      );
      // The protocol event is copied field-by-field from the step.end event, so
      // these exact values also prove the split survived on step.end.
      expect(stepCompleted?.args).toMatchObject({
        llmFirstTokenLatencyMs: 100,
        llmStreamDurationMs: 200,
        llmRequestBuildMs: 30,
        llmServerFirstTokenMs: 70,
        llmServerDecodeMs: 150,
        llmClientConsumeMs: 50,
      });
    } finally {
      await ctx.dispose();
    }
  });
});

function createTimingRequester(): IAgentLLMRequesterService {
  const timing: LLMStreamTiming = {
    firstTokenLatencyMs: 100,
    streamDurationMs: 200,
    requestBuildMs: 30,
    serverFirstTokenMs: 70,
    serverDecodeMs: 150,
    clientConsumeMs: 50,
  };

  return {
    _serviceBrand: undefined,
    async request(_overrides, onPart = () => {}) {
      await onPart({ type: 'text', text: 'answer' });
      return {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        model: 'mock-model',
        timing,
      };
    },
  };
}
