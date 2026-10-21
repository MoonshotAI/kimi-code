import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { OUTPUT_LIMIT_RECOVERY_VARIANT } from '#/agent/outputLimitRecovery/outputLimitRecovery';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
import type { ToolCall } from '#human/llm/message';

import { createTestAgent, type TestAgentContext } from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { submitPromptTurn } from '../loop/stubs';

describe('output-limit recovery', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;
  let records: TelemetryRecord[];

  beforeEach(async () => {
    records = [];
    ctx = createTestAgent({
      telemetry: recordingTelemetry(records),
    });
    await ctx.restorePersisted();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
    profile.update({ activeToolNames: [] });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function recoveryInjections(): ContextMessage[] {
    return ctx.context
      .get()
      .filter(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === OUTPUT_LIMIT_RECOVERY_VARIANT,
      );
  }

  function textOf(message: ContextMessage | undefined): string {
    return (message?.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  function truncatedThought(think: string, traceId?: string) {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
      traceId,
    });
  }

  function recoveryEvents(): TelemetryRecord[] {
    return records.filter((record) => record.event === 'llm_output_limit_recovery');
  }

  it('retries a think-only truncation with the reminder', async () => {
    truncatedThought('unfinished thought');
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    const history = ctx.llmCalls[1]!.history;
    expect(history.map((message) => message.role)).toEqual(['user', 'user']);
    expect(textOf(history.at(-1) as ContextMessage | undefined)).toBe(
      '<system-reminder>\n' +
        'Output token limit hit while you were still reasoning, before this response produced any text or tool call. That reasoning was not kept and is not part of this conversation, so there is nothing to resume. Continue from the conversation above: reason much more briefly and produce your answer or next tool call well within the output limit.' +
        '\n</system-reminder>',
    );
    expect(recoveryInjections()).toHaveLength(1);
    expect(recoveryEvents().map((event) => event.properties?.['action'])).toEqual(['nudged']);
  });

  it('leaves a truncation with visible text to end the turn as truncated', async () => {
    ctx.mockNextProviderResponse({
      parts: [
        { type: 'think', think: 'planning' },
        { type: 'text', text: 'partial answer' },
      ],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 1, truncated: true });
    expect(recoveryInjections()).toEqual([]);
    expect(recoveryEvents()).toEqual([]);
  });

  it('fails the turn after three reminders without leaking content', async () => {
    for (let index = 1; index <= 4; index++) {
      truncatedThought(`secret thought ${index}`, `trace-output-${index}`);
    }

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);
    const result = await turn.result;
    expect(result.type).toBe('failed');
    expect(result.type === 'failed' ? result.error : undefined).toMatchObject({
      code: 'agent.max_tokens_exceeded',
    });
    expect(recoveryInjections()).toHaveLength(3);
    const events = recoveryEvents();
    expect(events.map((event) => event.properties?.['action'])).toEqual([
      'nudged',
      'nudged',
      'nudged',
      'exhausted',
    ]);
    expect(events.map((event) => event.properties?.['attempt'])).toEqual([1, 2, 3, 3]);
    expect(events.map((event) => event.properties?.['step_no'])).toEqual([1, 2, 3, 4]);
    expect(events[0]?.properties).toMatchObject({
      turn_id: 0,
      model: 'mock-model',
      trace_id: 'trace-output-1',
    });
    for (const event of events) {
      expect(JSON.stringify(event.properties)).not.toContain('secret thought');
    }
  });

  it('keeps reminder steps within maxSteps', async () => {
    const local = createTestAgent({
      initialConfig: {
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    try {
      await local.restorePersisted();
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'think', think: 'unfinished thought' }],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });
      local.mockNextResponse({ type: 'text', text: 'completed answer' });

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(1);
      const result = await turn.result;
      expect(result.type).toBe('failed');
      expect(result.type === 'failed' ? result.error : undefined).toMatchObject({
        code: 'loop.max_steps_exceeded',
      });
    } finally {
      await local.dispose();
    }
  });

  it('resets the reminder count after a step that is not truncated', async () => {
    const lookupCall = registerLookupTool(ctx);
    truncatedThought('first thought');
    truncatedThought('second thought');
    ctx.mockNextResponse({ type: 'text', text: 'calling a tool' }, lookupCall);
    truncatedThought('third thought');
    truncatedThought('fourth thought');
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const { turn } = submitTurn(loop, 'Look up mars');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(6);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 6, truncated: false });
    expect(recoveryInjections()).toHaveLength(4);
  });

  it('keeps a pending notification alongside the reminder', async () => {
    let notified = false;
    loop.hooks.onWillBeginStep.register('test-notify', async (_hookCtx, next) => {
      if (!notified) {
        notified = true;
        loop.notify({
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'queued follow-up' }],
            toolCalls: [],
          },
        });
      }
      await next();
    });
    truncatedThought('unfinished thought');
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    const history = ctx.llmCalls[1]!.history as ContextMessage[];
    expect(history.slice(-2).map(textOf)).toEqual([
      expect.stringContaining('Output token limit hit while you were still reasoning'),
      'queued follow-up',
    ]);
    expect(recoveryInjections()).toHaveLength(1);
  });

  it('retries before a separate prompt queued behind the turn', async () => {
    truncatedThought('unfinished thought');
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });
    ctx.mockNextResponse({ type: 'text', text: 'next answer' });

    const { turn } = submitTurn(loop, 'Hello');
    const queued = submitTurn(loop, 'Next question').turn;
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    await expect(queued.result).resolves.toMatchObject({ type: 'completed' });

    expect(ctx.llmCalls).toHaveLength(3);
    expect(recoveryInjections()).toHaveLength(1);
    expect(recoveryEvents().map((event) => event.properties?.['action'])).toEqual(['nudged']);
  });

  it('lets cancellation stop the retried step', async () => {
    loop.hooks.onWillBeginStep.register('test-cancel-turn', async (hookCtx, next) => {
      if (hookCtx.step === 2) loop.cancel();
      await next();
    });
    truncatedThought('unfinished thought');
    ctx.mockNextResponse({ type: 'text', text: 'should not run' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const result = await turn.result;
    expect(result.type).toBe('cancelled');
  });
});

function registerLookupTool(agent: TestAgentContext): ToolCall {
  const lookupCall: ToolCall = {
    type: 'function',
    id: 'call_lookup',
    name: 'Lookup',
    arguments: '{"query":"mars"}',
  };
  const lookupTool: ExecutableTool<{ query: string }> = {
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    resolveExecution: () => ({
      approvalRule: 'Lookup',
      execute: async () => ({ output: 'lookup-result' }),
    }),
  };
  agent.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
  agent.get(IAgentToolRegistryService).register(lookupTool);
  return lookupCall;
}

function submitTurn(loop: IAgentLoopService, text: string): { readonly turn: Turn } {
  return submitPromptTurn(loop, {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { origin: { kind: 'user' } },
  });
}
