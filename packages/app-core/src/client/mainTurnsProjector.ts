// packages/app-core/src/client/mainTurnsProjector.ts
// Incremental wrapper over mainTranscriptToTurns — the transcript-path
// counterpart of turnsProjector. The plain conversion rebuilds every ChatTurn
// from the whole snapshot on each ops batch; this projector reuses the
// previous ChatTurn OBJECT for turns whose serialized content is unchanged,
// so the keyed v-for downstream only patches the turns that actually moved.
//
// Unlike the message-path projector there are no reference-stable sources to
// gate on (transcript upserts replace the item objects), so the gate is a
// full-content fingerprint per turn slot: any field that affects rendering
// changes it, deps (plans, reviews, url builders) included because their
// output is baked into the turn. The slot is the LIST POSITION, not the turn
// id — message-derived ids (`f1`, `m1`) repeat across turns and sessions.
// Position keying means a history prepend rebuilds the shifted suffix, which
// its renumbered `no` fields would invalidate anyway.

import type { AgentTranscriptSnapshot } from '../transcript';
import type { SessionPlan } from '../api/types';
import { mainTranscriptToTurns } from './mainTranscriptToTurns';
import type { ChatTurn } from './types';

export interface MainTurnsProjectDeps {
  sessionId: string;
  getFileUrl?: (fileId: string) => string;
  getSessionMediaUrl?: (sessionId: string, fileId: string) => string;
  plansByToolCallId?: Record<string, SessionPlan>;
  planReviewByToolCallId?: Record<string, { plan: string; path?: string }>;
  agentCreatedAt?: string;
  /** Observed times the session's pending interactions appeared, keyed by the
   *  suspended step id — each waiting step's open thinking span settles at
   *  its own stamp. */
  pendingInteractionAtByStepId?: ReadonlyMap<string, string>;
}

export interface MainTurnsProjector {
  (snapshot: AgentTranscriptSnapshot, deps: MainTurnsProjectDeps): ChatTurn[];
  reset(): void;
}

export function createMainTurnsProjector(): MainTurnsProjector {
  let prev: { turn: ChatTurn; fingerprint: string }[] = [];
  const project: MainTurnsProjector = (snapshot, deps) => {
    const built = mainTranscriptToTurns(snapshot, deps);
    const out = built.map((turn, index) => {
      const fingerprint = JSON.stringify(turn);
      const hit = prev[index];
      const reused = hit !== undefined && hit.fingerprint === fingerprint ? hit.turn : turn;
      prev[index] = { turn: reused, fingerprint };
      return reused;
    });
    prev.length = out.length;
    return out;
  };
  project.reset = () => {
    prev = [];
  };
  return project;
}
