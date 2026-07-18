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

export type ActivityMeta = 'idle' | 'turn' | 'disposing' | 'unknown';

export interface TranscriptMeta {
  readonly goal?: GoalMeta;
  readonly modes?: ModesMeta;
  readonly activity?: ActivityMeta;
}
