export type ArtexNodeKind =
  | 'begin'
  | 'goal'
  | 'intent'
  | 'fact'
  | 'finding'
  | 'hint'
  | 'digest';

export const ARTEX_NODE_KINDS: readonly ArtexNodeKind[] = [
  'begin',
  'goal',
  'intent',
  'fact',
  'finding',
  'hint',
  'digest',
];

export type ArtexBeginState = 'open';

export type ArtexIntentState =
  | 'open'
  | 'running'
  | 'paused'
  | 'done'
  | 'blocked'
  | 'exhausted'
  | 'stopped'
  | 'deleted';

export type ArtexGoalState = 'open' | 'met' | 'abandoned';

export type ArtexFactState = 'confirmed' | 'dismissed' | 'origin';

export type ArtexFindingNodeState = 'confirmed' | 'dismissed';

export type ArtexHintState = 'active' | 'consumed';

export type ArtexDigestState = 'active' | 'superseded';

export const ARTEX_INTENT_STATES: readonly ArtexIntentState[] = [
  'open',
  'running',
  'paused',
  'done',
  'blocked',
  'exhausted',
  'stopped',
  'deleted',
];

export const ARTEX_GOAL_STATES: readonly ArtexGoalState[] = ['open', 'met', 'abandoned'];

export const ARTEX_FACT_STATES: readonly ArtexFactState[] = ['confirmed', 'dismissed', 'origin'];

export const ARTEX_FINDING_NODE_STATES: readonly ArtexFindingNodeState[] = [
  'confirmed',
  'dismissed',
];

export const ARTEX_HINT_STATES: readonly ArtexHintState[] = ['active', 'consumed'];

export const ARTEX_DIGEST_STATES: readonly ArtexDigestState[] = ['active', 'superseded'];

export interface ArtexNodeBase {
  readonly id: number;
  readonly explorationId: number;
  payload: Record<string, unknown>;
  priority: number;
  origin?: string;
  owner?: string;
  blockedReason?: string;
  deleteReason?: string;
  readonly createdAt: string;
  updatedAt: string;
  completedAt?: string;
  contentVersion: number;
  coldSinceRound?: number;
  lastHeartbeatAt?: string;
  unclaimToken?: string;
}

export interface ArtexBeginNode extends ArtexNodeBase {
  kind: 'begin';
  state: ArtexBeginState;
}

export interface ArtexGoalNode extends ArtexNodeBase {
  kind: 'goal';
  state: ArtexGoalState;
}

export interface ArtexIntentNode extends ArtexNodeBase {
  kind: 'intent';
  state: ArtexIntentState;
}

export interface ArtexFactNode extends ArtexNodeBase {
  kind: 'fact';
  state: ArtexFactState;
}

export interface ArtexFindingNode extends ArtexNodeBase {
  kind: 'finding';
  state: ArtexFindingNodeState;
}

export interface ArtexHintNode extends ArtexNodeBase {
  kind: 'hint';
  state: ArtexHintState;
}

export interface ArtexDigestNode extends ArtexNodeBase {
  kind: 'digest';
  state: ArtexDigestState;
}

export type ArtexNode =
  | ArtexBeginNode
  | ArtexGoalNode
  | ArtexIntentNode
  | ArtexFactNode
  | ArtexFindingNode
  | ArtexHintNode
  | ArtexDigestNode;

export type ArtexNodeState =
  | ArtexBeginState
  | ArtexGoalState
  | ArtexIntentState
  | ArtexFactState
  | ArtexFindingNodeState
  | ArtexHintState
  | ArtexDigestState;

export function artexStatesForKind(kind: ArtexNodeKind): readonly ArtexNodeState[] {
  switch (kind) {
    case 'begin':
      return ['open'];
    case 'goal':
      return ARTEX_GOAL_STATES;
    case 'intent':
      return ARTEX_INTENT_STATES;
    case 'fact':
      return ARTEX_FACT_STATES;
    case 'finding':
      return ARTEX_FINDING_NODE_STATES;
    case 'hint':
      return ARTEX_HINT_STATES;
    case 'digest':
      return ARTEX_DIGEST_STATES;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function isValidArtexNodeState(kind: ArtexNodeKind, state: string): boolean {
  return (artexStatesForKind(kind) as readonly string[]).includes(state);
}

export function isLiveArtexIntentState(state: ArtexIntentState): boolean {
  switch (state) {
    case 'open':
    case 'running':
    case 'paused':
      return true;
    case 'done':
    case 'blocked':
    case 'exhausted':
    case 'stopped':
    case 'deleted':
      return false;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function isTerminalArtexIntentState(state: ArtexIntentState): boolean {
  switch (state) {
    case 'done':
    case 'blocked':
    case 'exhausted':
    case 'stopped':
      return true;
    case 'open':
    case 'running':
    case 'paused':
    case 'deleted':
      return false;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function isFoldableArtexNodeKind(kind: ArtexNodeKind): boolean {
  switch (kind) {
    case 'intent':
    case 'fact':
      return true;
    case 'begin':
    case 'goal':
    case 'finding':
    case 'hint':
    case 'digest':
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
