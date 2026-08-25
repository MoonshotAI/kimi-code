// app-core api/daemon/projector — the AgentProjector contract.
//
// DaemonKimiWebApi drives raw agent-core frames through a projector supplied
// via projectorFactory (createKimiWebApi wires the in-package implementation,
// which receives its translator by injection). Holding only the interface here
// keeps the api client free of that coupling.

import type { AppEvent } from '../types';

export interface ProjectMeta {
  /**
   * Wire-level pre-append stream offset on volatile text-delta frames (v2
   * sync protocol). Retained on the contract for forward compatibility; the
   * current projector does not align deltas (the message stream lives on the
   * transcript channel).
   */
  offset?: number;
}

export interface AgentProjector {
  /** Project a single raw agent-core event into zero or more AppEvents. Never throws. */
  project(rawType: string, payload: unknown, sessionId: string, meta?: ProjectMeta): AppEvent[];
  /**
   * Bind an externally-known promptId to the next turn.started for this session.
   * Call this right after submitPrompt() returns, before the first turn.started arrives.
   */
  bindNextPromptId(sessionId: string, promptId: string): void;
  /** Reset all per-session state (call on re-subscribe / resync). */
  reset(sessionId: string): void;
  /**
   * Drop all per-session state (call when the session is gone for good:
   * unsubscribed, forgotten, or deleted). Unlike reset(), this removes the
   * sessions-map entry so no transcript copies stay pinned.
   */
  forgetSession(sessionId: string): void;
  /**
   * Mark an agent id as a side-channel (e.g. BTW side chat) rather than a
   * background subagent.
   */
  markSideChannelAgent(agentId: string): void;
}
