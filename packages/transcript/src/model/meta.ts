/**
 * Session/agent meta state that floats above the timeline.
 *
 * `meta` is global (never paginated) and state-merged, not appended: every
 * `meta.merge` op carries the freshest whole sub-state. The goal strip above
 * a composer is the canonical consumer — a goal simultaneously appears inline
 * as a 'goal' marker and here as floating status.
 */

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalMeta {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly completionCriterion?: string;
  readonly budgetUsed?: number;
  readonly budgetLimit?: number;
}

/** Mode badges (plan mode, swarm mode) mirrored at session level. */
export interface ModesMeta {
  readonly plan?: { readonly reviewPath?: string };
  readonly swarm?: { readonly trigger?: string };
}

/**
 * Wire shape of `modes` inside a `meta.merge` op: each key may be the mode
 * object (set the badge) or `null` (the mode exited — clear it). An absent
 * key keeps the prior state.
 */
export interface ModesMetaMerge {
  readonly plan?: { readonly reviewPath?: string } | null;
  readonly swarm?: { readonly trigger?: string } | null;
}

export type ActivityMeta = 'idle' | 'turn' | 'disposing' | 'unknown';

export interface TranscriptMeta {
  readonly goal?: GoalMeta;
  readonly modes?: ModesMeta;
  readonly activity?: ActivityMeta;
}

/** Wire shape of a `meta.merge` payload — like {@link TranscriptMeta}, but mode keys may be `null` to clear. */
export type TranscriptMetaMerge = Omit<TranscriptMeta, 'modes'> & {
  readonly modes?: ModesMetaMerge;
};
