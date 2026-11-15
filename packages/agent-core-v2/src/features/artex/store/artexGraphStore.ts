import type {
  ArtexClaimResult,
  ArtexEdge,
  ArtexEdgeRelation,
  ArtexExploration,
  ArtexExplorationAnchor,
  ArtexIntentNode,
  ArtexIntentSettleState,
  ArtexIntentState,
  ArtexNode,
  ArtexNodeKind,
  ArtexNodeState,
  ArtexTokenRollup,
  ArtexTokenUsageEntry,
} from '#/features/artex/protocol/index';

export interface ArtexActivityEntry {
  readonly id: number;
  readonly nodeId?: number;
  readonly actor: string;
  readonly kind: string;
  readonly detail?: Record<string, unknown>;
  readonly at: string;
}

export interface ArtexActivityInput {
  readonly nodeId?: number;
  readonly actor: string;
  readonly kind: string;
  readonly detail?: Record<string, unknown>;
}

export interface ArtexGraphSnapshot {
  readonly exploration: ArtexExploration;
  readonly nodes: readonly ArtexNode[];
  readonly edges: readonly ArtexEdge[];
  readonly anchors: readonly ArtexExplorationAnchor[];
}

export interface ArtexAddNodeInput {
  readonly kind: ArtexNodeKind;
  readonly payload: Record<string, unknown>;
  readonly priority: number;
  readonly state: ArtexNodeState;
  readonly origin?: string;
  readonly anchors?: readonly number[];
}

export interface ArtexResetRunningOptions {
  readonly ttlMs?: number;
  readonly nowMs?: number;
}

export interface ArtexExplorationRoot {
  readonly description: string;
  readonly goal: string;
}

/**
 * The exploration graph store for one ARTEX exploration. A single backend owns
 * one exploration; the claim/heartbeat/settle trio plus the sweep is the fencing
 * protocol that lets many concurrent workers share the frontier without ever
 * double-executing one intent.
 */
export interface IArtexGraphStore {
  readonly explorationId: number;

  init(description: string, goal: string): Promise<ArtexExploration>;
  isInitialized(): Promise<boolean>;
  load(): Promise<ArtexGraphSnapshot>;
  root(): Promise<ArtexExplorationRoot>;

  addNode(input: ArtexAddNodeInput): Promise<number>;
  addIntent(
    payload: Record<string, unknown>,
    priority: number,
    anchors?: readonly number[],
    origin?: string,
  ): Promise<number>;
  addGoal(payload: Record<string, unknown>, origin?: string): Promise<number>;
  getNode(id: number): Promise<ArtexNode | undefined>;
  nodes(): Promise<readonly ArtexNode[]>;
  listByKind(kind: ArtexNodeKind, limit?: number): Promise<readonly ArtexNode[]>;
  frontier(limit?: number): Promise<readonly ArtexIntentNode[]>;
  setNodeState(id: number, state: ArtexNodeState): Promise<void>;
  mergeNodePayload(id: number, patch: Record<string, unknown>): Promise<void>;

  anchor(nodeId: number, assetId: number): Promise<void>;
  link(from: number, rel: ArtexEdgeRelation, to: number): Promise<void>;
  edges(): Promise<readonly ArtexEdge[]>;
  factsYielded(intentId: number): Promise<readonly number[]>;

  claimIntentToken(id: number, owner: string): Promise<ArtexClaimResult>;
  claimPausedIntentToken(id: number): Promise<ArtexClaimResult>;
  heartbeatIntentClaim(id: number, token: string): Promise<void>;
  settleIntentClaim(id: number, token: string, state: ArtexIntentSettleState): Promise<void>;
  settleIntentClaimBlocked(id: number, token: string, reason: string): Promise<void>;
  compareAndSetIntentState(
    id: number,
    expected: ArtexIntentState,
    state: ArtexIntentState,
  ): Promise<boolean>;
  setIntentState(id: number, state: ArtexIntentState): Promise<void>;
  reopenIntent(id: number): Promise<boolean>;
  reopenBlockedIntents(): Promise<number>;
  resetRunningIntents(options?: ArtexResetRunningOptions): Promise<number>;

  stats(): Promise<Record<string, number>>;
  hasActiveIntent(): Promise<boolean>;
  hasOpenGoal(): Promise<boolean>;
  openGoalFingerprint(): Promise<string>;

  recordTokenUsage(entry: ArtexTokenUsageEntry): Promise<void>;
  tokenRollup(): Promise<ArtexTokenRollup>;

  appendActivity(entry: ArtexActivityInput): Promise<number>;
}
