/**
 * `rewind` domain (L6) — the single owner of the undo operation.
 *
 * `IAgentRewindService` turns "undo N user turns" into the rewind pipeline:
 * quiesce (abort the active turn, cancel in-flight compaction, pause prompt
 * launching) → precheck (turn boundaries from `TurnIndexModel`, compaction
 * boundary) → `wire.rewind` (persist a `log.cut` control record and rebuild
 * every rewindable model) → reconcile (context-size rebase, `lastPrompt`) →
 * telemetry + `context.rewound`. Every entry point (REST `:undo`, RPC
 * `undoHistory`, debug surface) converges here so the operation has exactly
 * one guard, one error contract, and one telemetry call.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface RewindAvailability {
  /** How many trailing user turns a rewind may cut (compaction-boundary aware). */
  readonly maxTurns: number;
  /** Whether an uncompacted compaction record bounds the rewindable range. */
  readonly stoppedAtCompaction: boolean;
}

export interface IAgentRewindService {
  readonly _serviceBrand: undefined;

  /** Current rewind availability — the server-side source for undo selectors. */
  availability(): RewindAvailability;

  /**
   * Undo the last `turns` user turns of this agent. Aborts an active turn and
   * cancels an in-flight compaction first (quiesce), then rewinds every
   * rewindable model to the Nth-to-last `turn.prompt` record. Pending prompt
   * queue is preserved. Throws `session.undo_unavailable` (with a structured
   * `reason`) when fewer than `turns` turns may be cut. Resolves to the number
   * of turns actually cut.
   */
  rewind(turns: number): Promise<number>;
}

export const IAgentRewindService: ServiceIdentifier<IAgentRewindService> =
  createDecorator<IAgentRewindService>('agentRewindService');
