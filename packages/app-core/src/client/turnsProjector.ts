// packages/app-core/src/client/turnsProjector.ts
// Incremental wrapper over messagesToTurns.
//
// The plain conversion rebuilds EVERY ChatTurn from ALL messages on every
// streaming frame (O(transcript) per frame, fresh object identities → the
// keyed v-for downstream re-patches the whole list). The reducer keeps
// unchanged messages reference-stable, so a turn whose source messages are all
// the same references renders identically — this projector reuses the previous
// ChatTurn OBJECT for those, rebuilding only the tail.
//
// Reuse rules:
// - Fast path needs the non-message inputs to be reference-identical too
//   (approvals / planReview / getFileUrl); any change falls back to a full
//   rebuild for that run (they change at turn/approval boundaries, not per
//   delta, so the hot path still hits).
// - The PREVIOUS run's LAST assistant turn is never reused: it may still be
//   growing (the next delta lands in it), so it is always rebuilt from its
//   recorded span. sessionActive flipping true→false only affects that same
//   trailing turn's settle rule (non-final flushes settle unconditionally), so
//   it needs no gate.
// - A prefix mismatch (history prepend at the front, undo truncation, hidden
//   side-chat ids filtered out) simply stops the reuse walk there; the suffix
//   is rebuilt from the first mismatching span onward.
//
// Pure logic (no Vue) so it can be unit-tested without a reactive runtime.

import type { AppMessage, AppApprovalRequest, SessionPlan } from '../api/types';
import type { ChatTurn } from './types';
import { messagesToTurns } from './messagesToTurns';

export interface TurnsProjectInput {
  messages: AppMessage[];
  approvals: AppApprovalRequest[];
  getFileUrl?: (fileId: string) => string;
  getSessionMediaUrl?: (sessionId: string, fileId: string) => string;
  sessionActive?: boolean;
  planReviewByToolCallId?: Record<string, { plan: string; path?: string }>;
  plansByToolCallId?: Record<string, SessionPlan>;
}

export interface TurnsProjector {
  (input: TurnsProjectInput): ChatTurn[];
  /** Drop the cached prefix (e.g. on hard state replacement). */
  reset(): void;
}

export function createTurnsProjector(): TurnsProjector {
  let prevTurns: ChatTurn[] = [];
  let prevApprovals: AppApprovalRequest[] | null = null;
  // planReviewByToolCallId is mutated PER KEY in place (applyRecordDiff), so
  // the record's own identity never changes and cannot gate reuse. Snapshot
  // its entries instead and gate by value — a late-arriving plan path must
  // rebuild the ExitPlanMode turn it belongs to.
  let prevPlanReviewEntries: Record<string, { plan: string; path?: string }> | null = null;
  let prevPlanEntries: Record<string, SessionPlan> | null = null;
  let prevGetFileUrl: TurnsProjectInput['getFileUrl'];
  let prevGetSessionMediaUrl: TurnsProjectInput['getSessionMediaUrl'];
  let prevSessionActive = true;
  // Sidecar: source message span per emitted turn (the core reports them via
  // `collect`; kept out of the turn objects so the shape stays untouched).
  const sources = new WeakMap<ChatTurn, readonly AppMessage[]>();

  const project: TurnsProjector = (input) => {
    const { messages, approvals } = input;
    const sessionActive = input.sessionActive ?? true;
    const planReview = input.planReviewByToolCallId ?? {};
    const plans = input.plansByToolCallId ?? {};
    const collect = (turn: ChatTurn, src: readonly AppMessage[]) => sources.set(turn, src);

    let planReviewUnchanged = prevPlanReviewEntries !== null;
    if (planReviewUnchanged) {
      const prev = prevPlanReviewEntries!;
      const nextKeys = Object.keys(planReview);
      planReviewUnchanged =
        nextKeys.length === Object.keys(prev).length &&
        nextKeys.every((k) => planReview[k] === prev[k]);
    }
    let plansUnchanged = prevPlanEntries !== null;
    if (plansUnchanged) {
      const prev = prevPlanEntries!;
      const nextKeys = Object.keys(plans);
      plansUnchanged =
        nextKeys.length === Object.keys(prev).length &&
        nextKeys.every((k) => plans[k] === prev[k]);
    }

    const canReuse =
      prevTurns.length > 0 &&
      approvals === prevApprovals &&
      planReviewUnchanged &&
      plansUnchanged &&
      input.getFileUrl === prevGetFileUrl &&
      input.getSessionMediaUrl === prevGetSessionMediaUrl;

    let reuseCount = 0;
    let cursor = 0;
    let startNo = 1;

    if (canReuse) {
      // The trailing assistant turn may still be growing: reuse it only when
      // it stays the transcript tail (nothing after its span) AND sessionActive
      // did not flip (the final group's tool-settle rule keys off it). Every
      // earlier turn is closed by a hard boundary that the identical prefix
      // preserves, so those can always be reused.
      let lastAssistant = -1;
      for (let i = prevTurns.length - 1; i >= 0; i--) {
        if (prevTurns[i]!.role === 'assistant') {
          lastAssistant = i;
          break;
        }
      }
      for (let i = 0; i < prevTurns.length; i++) {
        const turn = prevTurns[i]!;
        const src = sources.get(turn);
        if (!src || src.length === 0) break;
        if (i === lastAssistant && sessionActive !== prevSessionActive) break;
        let match = cursor + src.length <= messages.length;
        for (let j = 0; match && j < src.length; j++) {
          if (messages[cursor + j] !== src[j]) match = false;
        }
        if (!match) break;
        if (i === lastAssistant && cursor + src.length !== messages.length) break;
        reuseCount++;
        cursor += src.length;
        if (turn.role !== 'compaction') startNo++;
      }
    }

    const suffixTurns = messagesToTurns(
      messages.slice(cursor),
      approvals,
      input.getFileUrl,
      sessionActive,
      planReview,
      plans,
      { startNo, collect, getSessionMediaUrl: input.getSessionMediaUrl },
    );
    const next = reuseCount > 0 ? [...prevTurns.slice(0, reuseCount), ...suffixTurns] : suffixTurns;

    prevTurns = next;
    prevApprovals = approvals;
    prevPlanReviewEntries = { ...planReview };
    prevPlanEntries = { ...plans };
    prevGetFileUrl = input.getFileUrl;
    prevGetSessionMediaUrl = input.getSessionMediaUrl;
    prevSessionActive = sessionActive;
    return next;
  };

  project.reset = () => {
    prevTurns = [];
    prevApprovals = null;
    prevPlanReviewEntries = null;
    prevPlanEntries = null;
    prevGetFileUrl = undefined;
    prevSessionActive = true;
  };

  return project;
}
