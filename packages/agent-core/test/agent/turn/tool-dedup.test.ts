import { describe, expect, it } from 'vitest';

import type { ExecutableToolResult } from '../../../src/loop/types';
import type {
  TelemetryClient,
  TelemetryProperties,
} from '../../../src/telemetry';
import { ToolCallDeduplicator, __testing } from '../../../src/agent/turn/tool-dedup';

const { REMINDER_TEXT_1, REMINDER_TEXT_3, makeReminderText2 } = __testing;

interface RecordedTelemetryEvent {
  readonly event: string;
  readonly properties: TelemetryProperties | undefined;
}

function makeRecordingTelemetry(): {
  readonly client: TelemetryClient;
  readonly events: RecordedTelemetryEvent[];
} {
  const events: RecordedTelemetryEvent[] = [];
  const client: TelemetryClient = {
    track: (event, properties) => {
      events.push({ event, properties });
    },
  };
  return { client, events };
}

function okResult(text: string): ExecutableToolResult {
  return { output: text };
}

function errResult(text: string): ExecutableToolResult {
  return { output: text, isError: true };
}

/**
 * Drives one full lifecycle for a single (original) tool call:
 * beginStep is the caller's responsibility — this only handles checkSameStep
 * + finalizeResult for the original (first-occurrence) call.
 */
async function runOriginal(
  deduper: ToolCallDeduplicator,
  callId: string,
  tool: string,
  args: unknown,
  result: ExecutableToolResult,
): Promise<ExecutableToolResult> {
  const cached = deduper.checkSameStep(callId, tool, args);
  expect(cached).toBeNull();
  return deduper.finalizeResult(callId, tool, args, result);
}

describe('ToolCallDeduplicator', () => {
  describe('same-step dedup', () => {
    it('returns a placeholder synchronously and resolves to the real result on finalize', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      const original = await runOriginal(dedup, 'c1', 'Read', { path: '/a' }, okResult('FILE_A'));
      const cached = dedup.checkSameStep('c2', 'Read', { path: '/a' });
      // Same-step dup gets a synthetic placeholder (non-error, empty string).
      expect(cached).not.toBeNull();
      expect(cached!.isError).toBeUndefined();
      // Finalize substitutes the original's real result.
      const finalDup = await dedup.finalizeResult('c2', 'Read', { path: '/a' }, cached!);
      expect(finalDup).toEqual(original);
    });

    it('propagates error results to same-step dups', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      await runOriginal(dedup, 'c1', 'Bash', { cmd: 'x' }, errResult('boom'));
      const cached = dedup.checkSameStep('c2', 'Bash', { cmd: 'x' });
      expect(cached).not.toBeNull();
      const finalDup = await dedup.finalizeResult('c2', 'Bash', { cmd: 'x' }, cached!);
      expect(finalDup).toEqual(errResult('boom'));
    });

    it('finalizes original before dup (provider order)', async () => {
      // The loop guarantees finalize runs in provider order, so by the time a
      // dup's finalize runs, the original's deferred is already resolved.
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      const origCached = dedup.checkSameStep('c1', 'Read', { path: '/a' });
      expect(origCached).toBeNull();
      const dupCached = dedup.checkSameStep('c2', 'Read', { path: '/a' });
      expect(dupCached).not.toBeNull();
      // Finalize in provider order: c1 first, then c2.
      const origFinal = await dedup.finalizeResult('c1', 'Read', { path: '/a' }, okResult('A'));
      const dupFinal = await dedup.finalizeResult('c2', 'Read', { path: '/a' }, dupCached!);
      expect(origFinal).toEqual(okResult('A'));
      expect(dupFinal).toEqual(okResult('A'));
    });
  });

  describe('cross-step streak', () => {
    it('does not inject reminder below 3 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(typeof last!.output).toBe('string');
      expect(last!.output as string).not.toContain('<system-reminder>');
    });

    it('injects reminder1 at exactly 3 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 3; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('repeating the exact same tool call');
      expect(last!.output as string).not.toContain('repeated_times');
    });

    it('keeps injecting reminder1 at 4 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 4; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('repeating the exact same tool call');
    });

    it('injects reminder2 at exactly 5 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 5; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('repeated_times: 5');
      expect(last!.output as string).toContain('tool: Read');
      expect(last!.output as string).toContain('arguments:');
    });

    it.each([6, 7])('keeps injecting reminder2 at %i consecutive', async (streak) => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < streak; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain(`repeated_times: ${String(streak)}`);
      expect(last!.output as string).toContain('tool: Read');
    });

    it('injects the dead-end reminder at exactly 8 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 8; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      expect(last!.output as string).toContain('<system-reminder>');
      expect(last!.output as string).toContain('stuck in a dead end');
    });

    it('resets streak when a different call is interleaved', async () => {
      const dedup = new ToolCallDeduplicator();
      // 2× Read({p:1}) — should NOT trigger yet
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `a${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      // 1× Read({p:2}) interrupts the streak
      dedup.beginStep();
      await runOriginal(dedup, 'b1', 'Read', { p: 2 }, okResult('R'));
      dedup.endStep();
      // Back to Read({p:1}); streak restarts → 1 occurrence, no reminder
      dedup.beginStep();
      const last = await runOriginal(dedup, 'c1', 'Read', { p: 1 }, okResult('R'));
      dedup.endStep();
      expect(last.output as string).not.toContain('<system-reminder>');
    });

    it('same-step dups inherit reminder1 when streak triggers on original', async () => {
      const dedup = new ToolCallDeduplicator();
      // Build streak up to 2 across previous steps.
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      // Next step: same call appears twice. First is the original (triggers reminder1 at streak=3),
      // second is a same-step dup that should inherit it.
      dedup.beginStep();
      const original = await runOriginal(
        dedup,
        'orig',
        'Read',
        { p: 1 },
        okResult('R'),
      );
      const dupCached = dedup.checkSameStep('dup', 'Read', { p: 1 });
      expect(dupCached).not.toBeNull();
      const finalDup = await dedup.finalizeResult('dup', 'Read', { p: 1 }, dupCached!);
      dedup.endStep();

      expect(original.output as string).toContain('<system-reminder>');
      expect(original.output as string).toContain('repeating the exact same tool call');
      expect(finalDup.output as string).toContain('<system-reminder>');
      expect(finalDup.output as string).toContain('repeating the exact same tool call');
    });

    it('same-step spam alone does not trigger reminder', async () => {
      const dedup = new ToolCallDeduplicator();
      // 8 occurrences of the same call within a single step, but no prior
      // streak — the trigger is about sustained behaviour across steps, not
      // intra-step spam. Same-step dedup already short-circuits execution.
      dedup.beginStep();
      const cached = dedup.checkSameStep('orig', 'Read', { p: 1 });
      expect(cached).toBeNull();
      for (let i = 0; i < 7; i += 1) {
        dedup.checkSameStep(`dup${String(i)}`, 'Read', { p: 1 });
      }
      const final = await dedup.finalizeResult('orig', 'Read', { p: 1 }, okResult('R'));
      expect(final.output as string).not.toContain('<system-reminder>');
    });
  });

  describe('reminder injection into ContentPart[] outputs', () => {
    it('appends reminder1 to a trailing text part at streak 3', async () => {
      const dedup = new ToolCallDeduplicator();
      const arrayResult: ExecutableToolResult = {
        output: [{ type: 'text', text: 'hello' }],
      };
      // Build streak up to 2 prior steps then this one (streak=3).
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', {}, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', {}, arrayResult);
      dedup.endStep();
      const arr = final.output as Array<{ type: string; text: string }>;
      expect(arr).toHaveLength(1);
      expect(arr[0]!.type).toBe('text');
      expect(arr[0]!.text).toBe('hello' + REMINDER_TEXT_1);
    });

    it('appends reminder2 to a trailing text part at streak 5', async () => {
      const dedup = new ToolCallDeduplicator();
      const arrayResult: ExecutableToolResult = {
        output: [{ type: 'text', text: 'hello' }],
      };
      // Build streak up to 4 prior steps then this one (streak=5).
      for (let i = 0; i < 4; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', { a: 1 }, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', { a: 1 }, arrayResult);
      dedup.endStep();
      const arr = final.output as Array<{ type: string; text: string }>;
      expect(arr).toHaveLength(1);
      expect(arr[0]!.type).toBe('text');
      expect(arr[0]!.text).toBe('hello' + makeReminderText2('X', 5, { a: 1 }));
    });

    it('pushes a new text part when trailing part is non-text', async () => {
      const dedup = new ToolCallDeduplicator();
      const arrayResult: ExecutableToolResult = {
        output: [{ type: 'image_url', imageUrl: { url: 'data:foo' } }],
      };
      // Build streak to 3.
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', {}, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', {}, arrayResult);
      dedup.endStep();
      const arr = final.output as Array<{ type: string; text?: string }>;
      expect(arr).toHaveLength(2);
      expect(arr[0]!.type).toBe('image_url');
      expect(arr[1]!.type).toBe('text');
      expect(arr[1]!.text).toBe(REMINDER_TEXT_1);
    });

    it('preserves isError flag when injecting reminder', async () => {
      const dedup = new ToolCallDeduplicator();
      // Build streak to 3.
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `p${String(i)}`, 'X', {}, errResult('boom'));
        dedup.endStep();
      }
      dedup.beginStep();
      const final = await runOriginal(dedup, 'final', 'X', {}, errResult('boom'));
      dedup.endStep();
      expect(final.isError).toBe(true);
      expect(final.output as string).toContain('<system-reminder>');
    });
  });

  describe('key canonicalization', () => {
    it('treats argument objects with different key order as the same call', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      await runOriginal(dedup, 'c1', 'Read', { a: 1, b: 2 }, okResult('SAME'));
      const cached = dedup.checkSameStep('c2', 'Read', { b: 2, a: 1 });
      expect(cached).not.toBeNull();
      const finalDup = await dedup.finalizeResult('c2', 'Read', { b: 2, a: 1 }, cached!);
      expect(finalDup).toEqual(okResult('SAME'));
    });
  });

  describe('arg rewrite between checkSameStep and finalize', () => {
    it('resolves the dup deferred even when the original call args are rewritten before finalize', async () => {
      // Models the loop contract: prepareToolExecution may return
      // {updatedArgs}, in which case finalizeToolResult sees the rewritten
      // args. The dedup key registered at checkSameStep time uses the
      // LLM-issued args; the deferred must be resolved under that same key.
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      const c1 = dedup.checkSameStep('c1', 'Read', { path: '/a' });
      expect(c1).toBeNull();
      const c2 = dedup.checkSameStep('c2', 'Read', { path: '/a' });
      expect(c2).not.toBeNull();

      // Original finalize is called with REWRITTEN args (simulates a hook
      // returning updatedArgs).
      const finalC1 = await dedup.finalizeResult(
        'c1',
        'Read',
        { path: '/REWRITTEN' },
        okResult('A'),
      );
      // Dup's finalize must not hang — it should resolve via the deferred
      // registered under the original-args key.
      const finalC2 = await Promise.race([
        dedup.finalizeResult('c2', 'Read', { path: '/a' }, c2!),
        new Promise<ExecutableToolResult>((_, reject) => {
          setTimeout(() => {
            reject(new Error('dup finalize hung — deferred was never resolved'));
          }, 500);
        }),
      ]);
      expect(finalC1).toEqual(okResult('A'));
      expect(finalC2).toEqual(okResult('A'));
    });
  });

  describe('beginStep cleanup', () => {
    it('resolves leaked deferreds from a prior aborted step with an error result', async () => {
      const dedup = new ToolCallDeduplicator();
      dedup.beginStep();
      // Register an original but never finalize it (simulates abort mid-step).
      const orig = dedup.checkSameStep('leaked', 'Read', { p: 1 });
      expect(orig).toBeNull();
      // Register a dup that captures the leaked deferred.
      const dupCached = dedup.checkSameStep('dup', 'Read', { p: 1 });
      expect(dupCached).not.toBeNull();

      // Next step begins — the leaked deferred should resolve so an awaiter
      // doesn't hang. (In production the dup's finalize would have already
      // happened before beginStep, but defensively resolving leaked deferreds
      // protects against any ordering bug.)
      dedup.beginStep();
      // Finalize the dup that captured the leaked deferred. Since we cleared
      // syntheticCallIds in beginStep, this is no longer tracked — it just
      // returns the placeholder it was passed. The leaked deferred has been
      // resolved with an error result but nothing is awaiting it now.
      const finalDup = await dedup.finalizeResult('dup', 'Read', { p: 1 }, dupCached!);
      expect(finalDup).toEqual(dupCached);
    });
  });

  describe('dead-end stop reminder (streak >= 8)', () => {
    function stopTurnOf(result: ExecutableToolResult): boolean | undefined {
      return result.stopTurn;
    }

    async function runStreak(
      dedup: ToolCallDeduplicator,
      count: number,
    ): Promise<ExecutableToolResult> {
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < count; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      return last!;
    }

    it('injects the dead-end reminder at exactly 8 consecutive without force-stopping', async () => {
      const dedup = new ToolCallDeduplicator();
      const last = await runStreak(dedup, 8);
      expect(last.output as string).toContain('<system-reminder>');
      expect(last.output as string).toContain('stuck in a dead end');
      expect(last.output as string).toContain('Stop all function calls immediately');
      // 8 is the reminder threshold, not yet force-stop.
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBeUndefined();
    });

    it.each([8, 9, 10, 11])(
      'keeps injecting the dead-end reminder without stopping the turn at streak %i',
      async (streak) => {
        const dedup = new ToolCallDeduplicator();
        const last = await runStreak(dedup, streak);
        expect(last.output as string).toContain('stuck in a dead end');
        expect(last.isError).toBeUndefined();
        expect(stopTurnOf(last)).toBeUndefined();
      },
    );

    it('force-stops the turn at exactly 12 consecutive without marking the tool failed', async () => {
      const dedup = new ToolCallDeduplicator();
      const last = await runStreak(dedup, 12);
      expect(last.output as string).toContain('stuck in a dead end');
      // The underlying tool succeeded — force-stop must not flip it to error.
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBe(true);
    });

    it('continues force-stopping past 12 consecutive', async () => {
      const dedup = new ToolCallDeduplicator();
      const last = await runStreak(dedup, 14);
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBe(true);
    });

    it('preserves the dead-end reminder text exactly', async () => {
      const dedup = new ToolCallDeduplicator();
      const last = await runStreak(dedup, 8);
      expect(last.output as string).toContain(REMINDER_TEXT_3.trim());
    });

    it('keeps an error result error when force-stopping', async () => {
      const dedup = new ToolCallDeduplicator();
      let last: ExecutableToolResult | undefined;
      for (let i = 0; i < 12; i += 1) {
        dedup.beginStep();
        last = await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, errResult('boom'));
        dedup.endStep();
      }
      // The underlying tool was an error — that must survive force-stop.
      expect(last!.isError).toBe(true);
      expect(stopTurnOf(last!)).toBe(true);
      expect(last!.output as string).toContain('stuck in a dead end');
    });
  });

  describe('repeat telemetry', () => {
    it('emits tool_call_repeat with the streak count starting at the second occurrence', async () => {
      const { client, events } = makeRecordingTelemetry();
      const dedup = new ToolCallDeduplicator({ telemetry: client });
      for (let i = 0; i < 3; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      const repeats = events.filter((e) => e.event === 'tool_call_repeat');
      expect(repeats.map((e) => e.properties?.['repeat_count'])).toEqual([2, 3]);
      expect(repeats.every((e) => e.properties?.['tool_name'] === 'Read')).toBe(true);
    });

    it('does not emit telemetry on the first call', async () => {
      const { client, events } = makeRecordingTelemetry();
      const dedup = new ToolCallDeduplicator({ telemetry: client });
      dedup.beginStep();
      await runOriginal(dedup, 'c0', 'Read', { p: 1 }, okResult('R'));
      dedup.endStep();
      expect(events.filter((e) => e.event === 'tool_call_repeat')).toHaveLength(0);
    });

    it('labels the action as r1/r2/r3 according to the reminder tier from streak 3 through 11', async () => {
      const { client, events } = makeRecordingTelemetry();
      const dedup = new ToolCallDeduplicator({ telemetry: client });
      for (let i = 0; i < 11; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      const byCount = new Map<number, string>();
      for (const e of events) {
        if (e.event !== 'tool_call_repeat') continue;
        byCount.set(e.properties?.['repeat_count'] as number, e.properties?.['action'] as string);
      }
      expect(byCount.get(2)).toBe('none');
      expect(byCount.get(3)).toBe('r1');
      expect(byCount.get(4)).toBe('r1');
      expect(byCount.get(5)).toBe('r2');
      expect(byCount.get(6)).toBe('r2');
      expect(byCount.get(7)).toBe('r2');
      expect(byCount.get(8)).toBe('r3');
      expect(byCount.get(9)).toBe('r3');
      expect(byCount.get(10)).toBe('r3');
      expect(byCount.get(11)).toBe('r3');
    });

    it('labels the action as "stop" at streak 12+', async () => {
      const { client, events } = makeRecordingTelemetry();
      const dedup = new ToolCallDeduplicator({ telemetry: client });
      for (let i = 0; i < 13; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      const at12 = events.find(
        (e) => e.event === 'tool_call_repeat' && e.properties?.['repeat_count'] === 12,
      );
      const at13 = events.find(
        (e) => e.event === 'tool_call_repeat' && e.properties?.['repeat_count'] === 13,
      );
      expect(at12?.properties?.['action']).toBe('stop');
      expect(at13?.properties?.['action']).toBe('stop');
    });

    it('resets the count when a different call interleaves', async () => {
      const { client, events } = makeRecordingTelemetry();
      const dedup = new ToolCallDeduplicator({ telemetry: client });
      for (let i = 0; i < 2; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `a${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      dedup.beginStep();
      await runOriginal(dedup, 'b1', 'Read', { p: 2 }, okResult('R'));
      dedup.endStep();
      dedup.beginStep();
      await runOriginal(dedup, 'c1', 'Read', { p: 1 }, okResult('R'));
      dedup.endStep();
      const counts = events
        .filter((e) => e.event === 'tool_call_repeat')
        .map((e) => e.properties?.['repeat_count']);
      // Only the second Read({p:1}) is a repeat; the streak then breaks.
      expect(counts).toEqual([2]);
    });

    it('does not emit telemetry when no client is provided', async () => {
      const dedup = new ToolCallDeduplicator();
      for (let i = 0; i < 3; i += 1) {
        dedup.beginStep();
        await runOriginal(dedup, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
        dedup.endStep();
      }
      // Exercises the optional telemetry path; should complete silently.
      expect(true).toBe(true);
    });
  });
});
