import type {
  ArtexClaimResult,
  ArtexEdge,
  ArtexEdgeRelation,
  ArtexExploration,
  ArtexExplorationAnchor,
  ArtexFindingNode,
  ArtexFindingNodeState,
  ArtexGoalNode,
  ArtexGoalState,
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
  readonly tool?: string;
  readonly isError?: boolean;
  readonly summary?: string;
  readonly text?: string;
  readonly detail?: Record<string, unknown>;
  readonly at: string;
}

export interface ArtexActivityInput {
  readonly nodeId?: number;
  readonly actor: string;
  readonly kind: string;
  readonly tool?: string;
  readonly isError?: boolean;
  readonly summary?: string;
  readonly text?: string;
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

export interface ArtexIntentClaimHeartbeat {
  readonly id: number;
  readonly token: string;
}

export interface ArtexHeartbeatBatchResult {
  readonly updated: readonly number[];
  readonly lost: readonly number[];
}

export interface ArtexEditGoalPatch {
  readonly text?: string;
  readonly category?: string;
  readonly state?: ArtexGoalState;
}

export interface ArtexPatchFindingInput {
  readonly state?: ArtexFindingNodeState;
  readonly payload?: Record<string, unknown>;
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
  exploration(): Promise<ArtexExploration>;
  markExplorationAchieved(reason?: string): Promise<ArtexExploration>;
  reopenExploration(): Promise<ArtexExploration>;
  root(): Promise<ArtexExplorationRoot>;

  addNode(input: ArtexAddNodeInput): Promise<number>;
  addIntent(
    payload: Record<string, unknown>,
    priority: number,
    anchors?: readonly number[],
    origin?: string,
  ): Promise<number>;
  addGoal(payload: Record<string, unknown>, origin?: string): Promise<number>;
  editGoal(id: number, patch: ArtexEditGoalPatch): Promise<ArtexGoalNode | undefined>;
  deleteGoal(id: number): Promise<boolean>;
  patchFinding(id: number, patch: ArtexPatchFindingInput): Promise<ArtexFindingNode | undefined>;
  getNode(id: number): Promise<ArtexNode | undefined>;
  nodes(): Promise<readonly ArtexNode[]>;
  listByKind(kind: ArtexNodeKind, limit?: number): Promise<readonly ArtexNode[]>;
  frontier(limit?: number): Promise<readonly ArtexIntentNode[]>;
  countOpenIntents(): Promise<number>;
  countFinishedIntents(): Promise<number>;
  listRecentTerminalIntents(limit?: number): Promise<readonly ArtexIntentNode[]>;
  setNodeState(id: number, state: ArtexNodeState): Promise<void>;
  mergeNodePayload(id: number, patch: Record<string, unknown>): Promise<void>;

  anchor(nodeId: number, assetId: number): Promise<void>;
  link(from: number, rel: ArtexEdgeRelation, to: number): Promise<void>;
  edges(): Promise<readonly ArtexEdge[]>;
  factsYielded(intentId: number): Promise<readonly number[]>;

  claimIntentToken(id: number, owner: string): Promise<ArtexClaimResult>;
  claimPausedIntentToken(id: number): Promise<ArtexClaimResult>;
  heartbeatIntentClaim(id: number, token: string): Promise<void>;
  heartbeatIntentClaimsBatch(
    claims: readonly ArtexIntentClaimHeartbeat[],
  ): Promise<ArtexHeartbeatBatchResult>;
  settleIntentClaim(id: number, token: string, state: ArtexIntentSettleState): Promise<void>;
  settleIntentClaimBlocked(id: number, token: string, reason: string): Promise<void>;
  compareAndSetIntentState(
    id: number,
    expected: ArtexIntentState,
    state: ArtexIntentState,
  ): Promise<boolean>;
  setIntentState(id: number, state: ArtexIntentState): Promise<void>;
  softDeleteIntent(id: number, reason: string): Promise<boolean>;
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
  readActivity(): Promise<readonly ArtexActivityEntry[]>;
  readActivityByNode(nodeId: number): Promise<readonly ArtexActivityEntry[]>;
  readActivityByIds(ids: readonly number[]): Promise<readonly ArtexActivityEntry[]>;

  roundNo(): Promise<number>;
  bumpRound(): Promise<number>;
  coldStamps(): Promise<Map<number, number | undefined>>;
  contentVersions(): Promise<Map<number, number>>;
  applyColdStamps(ops: readonly ArtexColdStampOp[]): Promise<void>;
  addDigest(payload: Record<string, unknown>, memberIds: readonly number[]): Promise<number>;
  activeDigests(): Promise<readonly ArtexNode[]>;
  digestMembers(digestId: number): Promise<readonly number[]>;
  coveredMembers(): Promise<ReadonlySet<number>>;
  coveredMemberMap(): Promise<Map<number, number>>;
  supersedeDigests(digestIds: readonly number[]): Promise<void>;
}

export interface ArtexColdStampOp {
  readonly id: number;
  readonly set: boolean;
  readonly round: number;
}
