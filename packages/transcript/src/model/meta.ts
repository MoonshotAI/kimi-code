/**
 * Session/agent meta state that floats above the timeline.
 *
 * `meta` is global (never paginated) and state-merged, not appended: every
 * `meta.merge` op carries the freshest whole sub-state. The goal strip above
 * a composer is the canonical consumer — a goal simultaneously appears inline
 * as a 'goal' marker and here as floating status.
 */

import type { StepUsage } from './turn';

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
  readonly plan?: { readonly reviewPath?: string; readonly version?: number };
  readonly swarm?: { readonly trigger?: string };
}

/**
 * Contract shape of `modes` inside a `meta.merge` op: each key may be the mode
 * object (set the badge) or `null` (the mode exited — clear it). An absent
 * key keeps the prior state.
 */
export interface ModesMetaMerge {
  readonly plan?: { readonly reviewPath?: string; readonly version?: number } | null;
  readonly swarm?: { readonly trigger?: string } | null;
}

export type ActivityMeta = 'idle' | 'turn' | 'disposing' | 'unknown';

/** Turn end reason inside the 'ended' phase; mirrors the wire `turnEndReasonSchema`. */
export type TurnEndReasonMeta = 'completed' | 'cancelled' | 'failed' | 'blocked';

/**
 * What the agent is doing right now. Same shape as the wire
 * `agentPhaseSchema` (kap-server `protocol/events-zod.ts`), copied through
 * opaquely — this package must not import the server.
 */
export type AgentPhaseMeta =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly since: number;
    }
  | {
      readonly kind: 'streaming';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly stream: 'assistant' | 'thinking' | 'tool_call';
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly since: number;
    }
  | {
      readonly kind: 'tool_call';
      readonly turnId: number;
      readonly step: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly since: number;
    }
  | {
      readonly kind: 'retrying';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName?: string;
      readonly statusCode?: number;
      readonly since: number;
    }
  | {
      readonly kind: 'awaiting_approval';
      readonly turnId: number;
      readonly step?: number;
      readonly approval?: unknown;
      readonly since: number;
    }
  | {
      readonly kind: 'interrupted';
      readonly turnId: number;
      readonly step?: number;
      readonly reason: 'aborted' | 'max_steps' | 'error';
      readonly message?: string;
      readonly at: number;
    }
  | {
      readonly kind: 'ended';
      readonly turnId: number;
      readonly reason: TurnEndReasonMeta;
      readonly durationMs?: number;
      readonly at: number;
    };

/** Token usage slices of the agent status (the wire `UsageStatus` shape, verbatim). */
export interface AgentUsageMeta {
  readonly byModel?: Readonly<Record<string, StepUsage>>;
  readonly currentTurn?: StepUsage;
  readonly total?: StepUsage;
}

/**
 * Agent status projected from `agent.status.updated` / `agent.activity.updated`.
 * Slices arrive piecemeal, so `meta.merge` shallow-merges this key one level
 * deep (`{...old.agent, ...new.agent}`) — a whole-object replace would drop
 * fields carried by earlier slices.
 */
export interface AgentStatusMeta {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly usage?: AgentUsageMeta;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly permission?: 'manual' | 'yolo' | 'auto';
  readonly phase?: AgentPhaseMeta;
}

export interface TranscriptMeta {
  readonly goal?: GoalMeta;
  readonly modes?: ModesMeta;
  readonly activity?: ActivityMeta;
  readonly agent?: AgentStatusMeta;
}

/** Contract shape of a `meta.merge` payload — like {@link TranscriptMeta}, but mode keys may be `null` to clear. */
export type TranscriptMetaMerge = Omit<TranscriptMeta, 'modes'> & {
  readonly modes?: ModesMetaMerge;
};
