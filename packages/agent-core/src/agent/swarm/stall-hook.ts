/**
 * Stall detection for swarm worker subagents.
 *
 * A worker that repeats the SAME tool call (same name + canonical args) at or
 * beyond a threshold is making no progress. This hook detects that repetition
 * and stops the offending call so a coordinator recovery loop can revise the
 * worker. It is injected ONLY for swarm workers; the main agent and regular
 * subagents never receive it, so their behavior is unchanged.
 *
 * The repeat key reuses {@link canonicalTelemetryArgs} — the same canonical
 * definition the shared tool-call deduplicator (PR #15) uses — so semantically
 * equal arguments collapse to one key regardless of property order.
 */

import { canonicalTelemetryArgs } from '../turn/canonical-args';
import type { LoopHooks, PrepareToolExecutionResult } from '../../loop/types';

/**
 * The only loop-hook phase a subagent (swarm worker) overrides. `TurnFlow`
 * composes just `prepareToolExecution` ahead of its built-in dedup, so a
 * purpose-named subset keeps the surface honest and the main agent / regular
 * subagent paths provably unaffected.
 */
export type SubagentLoopHooks = Pick<LoopHooks, 'prepareToolExecution'>;

/** Max length of the repeated-call args snippet embedded in a stall reason. */
const STALL_ARGS_PREVIEW_MAX_CHARS = 120;

export interface StallDetectionHookOptions {
  /** Repeat count (inclusive) at which a call is treated as a stall. */
  readonly repeatThreshold: number;
  /**
   * Invoked exactly once, the first time the threshold is reached. Receives a
   * distinguishable reason string (e.g.
   * `stalled: repeated <tool>(<args>) x<N>`) so a caller can abort a per-worker
   * controller with it.
   */
  readonly onStall: (reason: string) => void;
}

/**
 * Build a {@link LoopHooks} fragment whose `prepareToolExecution` counts
 * repeats of each (name, canonical-args) key. When a key's count reaches
 * `repeatThreshold`, it fires `onStall(reason)` once and blocks that call (and
 * every subsequent repeat of the same key) with the same reason.
 *
 * Distinct calls never accumulate toward the threshold, so legitimate
 * progressing work is never stalled.
 */
export function createStallDetectionHook(
  options: StallDetectionHookOptions,
): SubagentLoopHooks {
  const { repeatThreshold, onStall } = options;
  const counts = new Map<string, number>();
  let stalled = false;

  return {
    prepareToolExecution: async (ctx): Promise<PrepareToolExecutionResult | undefined> => {
      const canonicalArgs = canonicalTelemetryArgs(ctx.args);
      const key = `${ctx.toolCall.name} ${canonicalArgs}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);

      if (next < repeatThreshold) return undefined;

      // Include the repeated call's canonical args (truncated) so the reviser
      // can see WHAT was repeated, not just which tool — e.g.
      // `stalled: repeated Read({"path":"/a"}) x10`.
      const argsPreview =
        canonicalArgs.length > STALL_ARGS_PREVIEW_MAX_CHARS
          ? `${canonicalArgs.slice(0, STALL_ARGS_PREVIEW_MAX_CHARS)}…`
          : canonicalArgs;
      const reason = `stalled: repeated ${ctx.toolCall.name}(${argsPreview}) x${String(next)}`;
      if (!stalled) {
        stalled = true;
        onStall(reason);
      }
      return { block: true, reason };
    },
  };
}
