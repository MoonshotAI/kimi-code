// Compaction scenario + probe tests.
//
// Two kinds of tests live here:
//   * GUARD tests lock in behavior we rely on (so future refactors can't
//     silently regress it).
//   * PROBE tests exercise the high-risk scenarios surfaced in review and in
//     our own audit, asserting the DESIRED behavior. Where the current
//     implementation does NOT meet that bar, the probe is marked `it.fails`:
//     the suite stays green, but the test documents the exact defect and will
//     start failing (forcing its removal) the day the behavior is fixed.
//
// Compaction is a hot path, so these intentionally drive the real
// Agent/ContextMemory/FullCompaction machinery through the test harness rather
// than mocking it.
import type { ContentPart, Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { AgentOptions } from '../../../src/agent';
import { COMPACTION_SUMMARY_PREFIX } from '../../../src/agent/compaction';
import type { ContextMessage } from '../../../src/agent/context';
import { FLAG_DEFINITIONS, FlagResolver } from '../../../src/flags';
import { testAgent, type TestAgentContext } from '../harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' } as const;
const CAPS = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-compaction-summary',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function historyTexts(ctx: TestAgentContext): string[] {
  return ctx.agent.context.history.map((message) =>
    message.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(''),
  );
}

function summaryMessageText(ctx: TestAgentContext): string {
  const summary = ctx.agent.context.history.find(
    (message) => message.origin?.kind === 'compaction_summary',
  );
  return summary?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

describe('compaction — guard tests', () => {
  it('repeated compaction folds the prior summary into the new one, never stacking two summaries', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);

    ctx.mockNextResponse({ type: 'text', text: 'First summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'user two' }]);
    ctx.mockNextResponse({ type: 'text', text: 'Second summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const summaries = ctx.agent.context.history.filter(
      (message) => message.origin?.kind === 'compaction_summary',
    );
    // Exactly one summary survives; the first was re-summarized, not carried.
    expect(summaries).toHaveLength(1);
    expect(summaryMessageText(ctx)).toContain('Second summary.');
    expect(historyTexts(ctx).join('\n')).not.toContain('First summary.');
  });

  it('closes a dangling tool_use in the compaction summary request via synthesizeMissing', async () => {
    // Full compaction projects its summarizer input with { synthesizeMissing: true }
    // so an unresolved tool_use (whose result is sliced out / not yet recorded)
    // is answered by a synthetic tool_result — keeping the summary request
    // well-formed for strict providers instead of 400-ing on a dangling call.
    let summarizerMessages: Message[] | undefined;
    const capture: GenerateFn = async (_provider, _system, _tools, messages) => {
      summarizerMessages = messages;
      return textResult('Compacted summary.');
    };
    const ctx = testAgent({ generate: capture });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendUnresolvedToolExchange(0); // assistant with 2 tool calls, no results

    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const msgs = summarizerMessages ?? [];
    const assistantIndex = msgs.findIndex(
      (message) => message.role === 'assistant' && message.toolCalls.length > 0,
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    for (const toolCall of msgs[assistantIndex]!.toolCalls) {
      const answered = msgs
        .slice(assistantIndex + 1)
        .some((message) => message.role === 'tool' && message.toolCallId === toolCall.id);
      expect(answered).toBe(true);
    }
  });

  // Mutual exclusion: compaction and turn processing must not run concurrently,
  // or a turn mutating the context mid-summary loses output. Auto compaction is
  // structurally safe (it runs while the turn blocks at a step boundary); the
  // manual/SDK path is guarded explicitly here.
  it('rejects a manual compaction while a turn is active', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'seed' }], { kind: 'user' });
    ctx.mockNextResponse({ type: 'text', text: 'turn done' });

    // launch() sets the active turn synchronously, so a turn is active before the
    // worker yields — exactly the window an SDK beginCompaction could land in.
    ctx.agent.turn.prompt([{ type: 'text', text: 'go' }]);
    expect(ctx.agent.turn.hasActiveTurn).toBe(true);

    await expect(ctx.rpc.beginCompaction({})).rejects.toThrow(/turn/i);

    await ctx.agent.turn.waitForCurrentTurn();
  });

  it('rejects a new turn while a manual compaction is in progress', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });

    // begin() sets the compacting flag synchronously before the summarizer yields.
    void ctx.rpc.beginCompaction({});
    expect(ctx.agent.fullCompaction.isCompacting).toBe(true);

    // A new turn must be refused while compaction holds the context.
    const turnId = ctx.agent.turn.prompt([{ type: 'text', text: 'new turn' }]);
    expect(turnId).toBeNull();

    await ctx.once('compaction.completed');
  });
});

describe('compaction — probe tests (high-risk scenarios)', () => {
  // PROBE #1 / CMP-02 — messages appended while the summarizer request is in
  // flight (a live step racing a manual/SDK compaction). The summary only covers
  // the pre-compaction snapshot, and the all-user rebuild would drop the appended
  // assistant/tool tail — so compaction detects the changed history and cancels,
  // leaving the appended turn intact for a later clean-boundary compaction.
  it('preserves an assistant turn appended while the summarizer call is in flight', async () => {
    let ctx!: TestAgentContext;
    const appendDuringGenerate: GenerateFn = async () => {
      // Simulate the turn loop completing a step while compaction awaits.
      ctx.agent.context.appendLoopEvent({
        type: 'step.begin',
        uuid: 'race-step',
        turnId: '',
        step: 9,
      });
      ctx.agent.context.appendLoopEvent({
        type: 'content.part',
        uuid: 'race-part',
        turnId: '',
        step: 9,
        stepUuid: 'race-step',
        part: { type: 'text', text: 'RACE-ASSISTANT-OUTPUT' },
      });
      ctx.agent.context.appendLoopEvent({
        type: 'step.end',
        uuid: 'race-step',
        turnId: '',
        step: 9,
        finishReason: 'end_turn',
      });
      return textResult('Compacted summary.');
    };
    ctx = testAgent({ generate: appendDuringGenerate });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);

    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.cancelled');

    expect(historyTexts(ctx).join('\n')).toContain('RACE-ASSISTANT-OUTPUT');
  });

  // PROBE #1b — a user-ROLE message that compaction would drop (background-task
  // notification, hook/cron reminder, shell output) appended mid-summary. It is
  // neither summarized (added after the snapshot) nor kept (applyCompaction keeps
  // only real user input), so it would silently vanish; the race guard must cancel
  // on any tail compaction would drop, not just non-user roles.
  it('cancels compaction when a droppable user-role tail is appended mid-summary', async () => {
    let ctx!: TestAgentContext;
    const appendDuringGenerate: GenerateFn = async () => {
      ctx.agent.context.appendUserMessage([{ type: 'text', text: 'BG-NOTIFY-OUTPUT' }], {
        kind: 'background_task',
        taskId: 't',
        status: 'completed',
        notificationId: 'n',
      });
      return textResult('Compacted summary.');
    };
    ctx = testAgent({ generate: appendDuringGenerate });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'user one', 'assistant one', 40);

    await ctx.rpc.beginCompaction({});
    await Promise.race([ctx.once('compaction.completed'), ctx.once('compaction.cancelled')]);

    // Cancelled, so the notification survives in history rather than being dropped.
    expect(historyTexts(ctx).join('\n')).toContain('BG-NOTIFY-OUTPUT');
  });

  // PROBE #2 — empty/truncated summarizer responses drop one oldest message and
  // retry. A dedicated shrink counter, bounded by MAX_COMPACTION_RETRY_ATTEMPTS,
  // keeps a model that always returns empty from issuing ~one call per message.
  it('bounds summarizer calls by the retry limit when the model keeps returning empty', async () => {
    let calls = 0;
    // Empty 7 times, then a valid summary. The bounded shrink counter gives up by
    // ~call 6, so compaction errors out before ever reaching the 8th (valid)
    // response; an unbounded impl would tolerate all 7 and complete on the 8th.
    const flakyEmpty: GenerateFn = async () => {
      calls += 1;
      return calls <= 7 ? textResult('') : textResult('Compacted summary.');
    };
    const ctx = testAgent({ generate: flakyEmpty });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    for (let i = 1; i <= 5; i++) {
      ctx.appendExchange(i, `user ${String(i)}`, `assistant ${String(i)}`, 40);
    }

    await ctx.rpc.beginCompaction({});
    await Promise.race([ctx.once('compaction.completed'), ctx.once('error')]);

    // A retry budget of MAX_COMPACTION_RETRY_ATTEMPTS(5) should bound calls.
    expect(calls).toBeLessThanOrEqual(6);
  });

  // PROBE #3 / CMP-08 — the kept-user budget is a fixed 20k and ignores the
  // model window, so on a small-window model the post-compaction context can
  // still exceed the trigger, re-compacting every turn without converging.
  it.fails('keeps the post-compaction context below the auto-compaction trigger on a small window', async () => {
    const SMALL_WINDOW = 16_000;
    const ctx = testAgent();
    ctx.configure({
      provider: PROVIDER,
      modelCapabilities: { ...CAPS, max_context_tokens: SMALL_WINDOW },
    });
    // ~7.5k tokens of user text per message (30k ascii chars / 4).
    for (let i = 1; i <= 3; i++) {
      ctx.appendExchange(i, 'u'.repeat(30_000), `assistant ${String(i)}`, 40);
    }

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    // tokenCount after compaction should leave headroom below the 85% trigger,
    // otherwise the next turn immediately re-compacts and never converges.
    expect(ctx.agent.context.tokenCount).toBeLessThan(SMALL_WINDOW * 0.85);
  });

  // PROBE #4 / CMP-01 — compaction started while a tool exchange is still open
  // (SDK/REST caller mid-tool) clears pendingToolResultIds, so the tool.result
  // that arrives afterwards is treated as an orphan and silently dropped.
  it.fails('does not drop a tool result that arrives after a compaction started mid-exchange', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendUnresolvedToolExchange(0); // assistant with 2 tool calls, no results yet

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    // The tool finishes after compaction; its result must not vanish.
    ctx.agent.context.appendLoopEvent({
      type: 'tool.result',
      parentUuid: 'call_unresolved_one',
      toolCallId: 'call_unresolved_one',
      result: { output: 'LATE-TOOL-RESULT' },
    });

    expect(historyTexts(ctx).join('\n')).toContain('LATE-TOOL-RESULT');
  });

  // CMP-12 fix — restoring a legacy `context.apply_compaction` record (pre-rework:
  // no keptUserMessageCount; the old `[summary, ...history.slice(compactedCount)]`
  // semantics kept a verbatim recent tail). On restore we reproduce that shape so
  // an upgraded session does not lose its recent assistant/tool tail.
  it('preserves the verbatim tail when restoring a legacy compaction record', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'summarized user', 'TAIL-ASSISTANT', 40);

    // Goes through the real restore path so `records.restoring` gates the legacy
    // reconstruction. No keptUserMessageCount + compactedCount < length marks the
    // pre-rework record that kept history.slice(compactedCount) as a tail.
    ctx.agent.records.restore({
      type: 'context.apply_compaction',
      summary: 'Legacy summary.',
      compactedCount: 1,
      tokensBefore: 100,
      tokensAfter: 50,
    });

    expect(historyTexts(ctx).join('\n')).toContain('TAIL-ASSISTANT');
  });

  // PROBE #6 — when the summarizer request overflows, historyForModel is shrunk
  // to a recent suffix but still projected through MicroCompaction.compact()
  // with the cutoff computed for the FULL history. The absolute cutoff applied
  // to the shifted suffix can clear recent tool results the summary needs.
  it.fails('does not clear recent tool results when projecting a shrunk suffix under an active micro-compaction cutoff', () => {
    // This defect only exists when micro-compaction is active, so enable the
    // flag explicitly rather than inheriting the ambient KIMI_CODE_EXPERIMENTAL
    // master switch — otherwise the probe's pass/fail flips with the runner's
    // environment (on locally with the master switch, off in CI by default).
    const ctx = testAgent({
      experimentalFlags: new FlagResolver(
        { KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: '1' },
        FLAG_DEFINITIONS,
      ),
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });

    const bigToolOutput = 'TOOL-OUTPUT-CONTENT '.repeat(60); // > minContentTokens(100)
    const full: ContextMessage[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 15) {
        full.push({
          role: 'tool',
          content: [{ type: 'text', text: bigToolOutput } satisfies ContentPart],
          toolCalls: [],
          toolCallId: `tool-${String(i)}`,
        });
      } else {
        full.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `m${String(i)}` }],
          toolCalls: [],
          origin: i % 2 === 0 ? { kind: 'user' } : undefined,
        });
      }
    }

    // Cutoff computed for the full history: keep the recent 10 (indices >= 10).
    ctx.agent.microCompaction.apply(10);

    // In the full history the tool result is at index 15 (>= cutoff) -> kept.
    const projectedFull = ctx.agent.context.project(full);
    const fullToolText = projectedFull
      .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');
    expect(fullToolText).toContain('TOOL-OUTPUT-CONTENT');

    // After an overflow shrink drops the oldest 10, the SAME tool result sits at
    // suffix index 5; the unchanged cutoff(10) now covers it. It must still be
    // preserved (it is a recent result the summary depends on).
    const shrunkSuffix = full.slice(10);
    const projectedSuffix = ctx.agent.context.project(shrunkSuffix);
    const suffixToolText = projectedSuffix
      .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');
    expect(suffixToolText).toContain('TOOL-OUTPUT-CONTENT');
  });

  // PROBE #7 / CMP-07 — when the oldest kept user message overflows the budget it
  // is truncated to text only, dropping any image/audio/video it carried. This
  // matches how codex (no media-aware truncation) and Claude Code (strips media)
  // handle media at compaction: media can't be partially truncated, and keeping
  // it whole would overshoot the budget. Recent messages that fit keep their
  // media; only this boundary message loses its attachments. Documented as an
  // accepted limitation rather than fixed.
  it.fails('keeps media on the oldest kept user message instead of dropping it on truncation', () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // Oldest user message: an image + long text that will overflow the budget.
    ctx.agent.context.appendUserMessage(
      [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'x'.repeat(120_000) }, // ~30k tokens of text
      ],
      { kind: 'user' },
    );
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'recent user' }], { kind: 'user' });

    ctx.agent.context.applyCompaction({
      summary: 'Summary.',
      compactedCount: 2,
      tokensBefore: 100,
    });

    const keptParts = ctx.agent.context.history.flatMap((message) => message.content);
    expect(keptParts.some((part) => part.type === 'image_url')).toBe(true);
  });
});
