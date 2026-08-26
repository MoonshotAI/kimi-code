// packages/app-core/src/client/thinkingTiming.ts
// Client-clock timing for LIVE thinking frames.
//
// A thinking block's clock starts when the client first projects the
// streaming frame (its first visible delta), not at the daemon's step
// start — queue/prefill/retry time before the first delta is not thinking
// time. Both stamps ride the client clock, so a measured span is immune to
// daemon↔client clock skew. History gets no stamp: a frame already closed
// at first sight keeps the daemon step bounds (see turnToMessages), the
// true first-delta moment being unrecoverable.

import type { AgentTranscriptSnapshot, TranscriptFrame, TranscriptStep } from '../transcript';

export interface ThinkingSpanStamp {
  /** Local ISO time the frame was first projected while still open. */
  startedAt: string;
  /** Local ISO time the frame was first observed closed (the step ended, a
      later frame took over, or an interaction suspended the step). */
  settledAt?: string;
}

/** Per-session store of live thinking spans, keyed by frame id. Written by
 *  the turns projection (first visibility) and by settleClosedThinkingSpans
 *  (close at ops-application time); pruned by pruneThinkingSpans when the
 *  transcript window is re-anchored. */
export type ThinkingTimingMap = Map<string, ThinkingSpanStamp>;

/** True while a thinking frame can still receive appends: its step is
 *  running, it is the step's latest frame, and no interaction has suspended
 *  the step. */
export function isThinkingFrameOpen(
  step: TranscriptStep,
  frame: TranscriptFrame,
  stepSuspended: boolean,
): boolean {
  return step.state === 'running' && step.frames.at(-1) === frame && !stepSuspended;
}

/** Freeze every stamped span whose frame is no longer open in this
 *  snapshot. The transcript pool calls this on each applied batch so spans
 *  settle when the closing fact LANDS: a session that only projects on
 *  activation would otherwise bill the time spent in the background into
 *  the thinking duration. A pending interaction suspends the running step
 *  without ending it — the human's wait is not thinking time either, so a
 *  frame of the suspended step settles here as well. (Interactions carry
 *  no step id, so suspension is correlated the same way the facade's edge
 *  watcher does it: any pending interaction parks the latest running step
 *  of the latest running turn.) */
export function settleClosedThinkingSpans(
  snapshot: AgentTranscriptSnapshot,
  timing: ThinkingTimingMap,
): void {
  if (timing.size === 0) return;
  let hasUnsettled = false;
  for (const stamp of timing.values()) {
    if (stamp.settledAt === undefined) {
      hasUnsettled = true;
      break;
    }
  }
  if (!hasUnsettled) return;

  const now = new Date().toISOString();
  const lastRunningTurn = snapshot.items.findLast(
    (item) => item.kind === 'turn' && item.state === 'running',
  );
  const lastRunningStep =
    lastRunningTurn?.kind === 'turn'
      ? lastRunningTurn.steps.findLast((step) => step.state === 'running')
      : undefined;
  const anyPending = snapshot.interactions.some(
    (interaction) => interaction.state === 'pending',
  );
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      const suspended = anyPending && step === lastRunningStep;
      for (const frame of step.frames) {
        if (frame.kind !== 'thinking') continue;
        const stamp = timing.get(frame.frameId);
        if (stamp === undefined || stamp.settledAt !== undefined) continue;
        if (!isThinkingFrameOpen(step, frame, suspended)) stamp.settledAt = now;
      }
    }
  }
}

/** Drop stamps whose frame is no longer in the window after a re-anchor
 *  (refresh/reset): frame ids are reused after an undo rewind, so a stale
 *  stamp must not outlive the content it was measured on. A frame that
 *  SURVIVES the re-anchor (an ordinary gap-recovery refresh) keeps its
 *  stamp — clearing it would visibly reset a running clock to zero. */
export function pruneThinkingSpans(
  snapshot: AgentTranscriptSnapshot,
  timing: ThinkingTimingMap,
): void {
  if (timing.size === 0) return;
  const surviving = new Set<string>();
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'thinking') surviving.add(frame.frameId);
      }
    }
  }
  for (const frameId of [...timing.keys()]) {
    if (!surviving.has(frameId)) timing.delete(frameId);
  }
}
