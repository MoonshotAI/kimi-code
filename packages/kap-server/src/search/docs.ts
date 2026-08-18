export const MAX_DOC_TEXT_CHARS = 20_000;

export interface MessageDoc {
  readonly kind: 'message';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly time: number;
  /**
   * 0-based turn ordinal in the transcript view (groupTurns numbering). Absent
   * for docs indexed before turn tracking existed.
   */
  readonly turn?: number;
  /**
   * Transcript step id (`t<turn>.<step>`, engine live numbering from the wire
   * record's `step` field) of the step that produced this assistant text.
   * Absent for user docs and docs indexed before step tracking existed.
   */
  readonly stepId?: string;
}

export interface TitleDoc {
  readonly kind: 'title';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** Titles belong to the session, not an agent — always ''. */
  readonly agentId: '';
  readonly role: 'title';
  readonly text: string;
  readonly time: number;
}

export interface TurnOpener {
  readonly turn: number;
  readonly anchor: boolean;
}

export interface TurnCounterState {
  /** Ordinal the next opened turn will get (0-based). */
  readonly next: number;
  /** Whether a turn is currently open (groupTurns' `ensureTurn` gate). */
  readonly hasTurn: boolean;
  /** Turn openers, in order — the replay stack for `context.undo`. */
  readonly openers: readonly TurnOpener[];
}

export interface StepTrackerState {
  /** Current turn's step uuid → ordinal (the wire `step` field, else the fallback counter). */
  readonly byUuid: Record<string, number>;
  /** `step.begin` count within the current turn — the fallback ordinal source. */
  readonly begins: number;
}

export interface FileMetaDoc {
  readonly kind: 'fileMeta';
  /** Owning session, used to drop metas when a session disappears. */
  readonly sessionId: string;
  /** Doc-key coordinates of this file's documents (see `docKeyPrefix`). */
  readonly agentId: string;
  readonly source: 'root' | 'agents';
  /** Absolute wire path (debugging aid; the key is its session + hash). */
  readonly path: string;
  /** Byte offset up to which the wire file has been indexed. */
  readonly offset: number;
  readonly size: number;
  /**
   * File mtime/inode at the last sync pass. A changed inode (atomic
   * replacement) or a bumped mtime at an unchanged size (in-place rewrite)
   * forces a rescan even when `size === offset`. Absent in metas written
   * before change tracking — such metas are simply refreshed with the
   * current stat on the next pass, without a rescan.
   */
  readonly mtimeMs?: number;
  readonly ino?: number;
  /**
   * Turn counter state at `offset` — persisted with the watermark so an
   * incremental pass resumes counting instead of restarting at turn 0.
   * Absent in metas written before turn tracking; treated as the initial
   * state, which makes a legacy meta resume mid-file with a zeroed counter —
   * an accepted one-time drift, self-healing on the next shrink/rescan.
   */
  readonly turnState?: TurnCounterState;
  /**
   * Step tracker state at `offset` — persisted with the watermark for the
   * same resume reason as `turnState`. Absent in metas written before step
   * tracking: such a file is RESCANNED from scratch (docs dropped, offset
   * reset) so stepIds are all-or-nothing per file instead of drifting.
   */
  readonly stepState?: StepTrackerState;
}

export interface SessionMetaDoc {
  readonly kind: 'sessionMeta';
}

export interface StatsDoc {
  readonly kind: 'stats';
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number;
}

export type SearchDoc = MessageDoc | TitleDoc | FileMetaDoc | SessionMetaDoc | StatsDoc;
