import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';

import {
  ARTEX_INTENT_CLAIM_TTL_MS,
  ArtexIntentClaimLostError,
  ArtexIntentStateConflictError,
  isTerminalArtexIntentState,
  isValidArtexNodeState,
  newArtexUnclaimToken,
  type ArtexClaimResult,
  type ArtexEdge,
  type ArtexEdgeRelation,
  type ArtexExploration,
  type ArtexExplorationAnchor,
  type ArtexFactNode,
  type ArtexIntentNode,
  type ArtexIntentSettleState,
  type ArtexIntentState,
  type ArtexNode,
  type ArtexNodeKind,
  type ArtexNodeState,
  type ArtexTokenRollup,
  type ArtexTokenUsage,
  type ArtexTokenUsageEntry,
} from '#/features/artex/protocol/index';

import type {
  ArtexActivityEntry,
  ArtexActivityInput,
  ArtexAddNodeInput,
  ArtexExplorationRoot,
  ArtexGraphSnapshot,
  ArtexResetRunningOptions,
  IArtexGraphStore,
} from './artexGraphStore';
import {
  ARTEX_STATE_SCHEMA_VERSION,
  artexActivityLog,
  artexExplorationDir,
  artexStateFile,
  artexStateLockPath,
} from './paths';

export const ARTEX_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
export const ARTEX_LOCK_RETRY_INTERVAL_MS = 20;
export const ARTEX_LOCK_STALE_MS = 30_000;

interface ArtexPersistedState {
  schemaVersion: number;
  exploration: ArtexExploration;
  nextNodeId: number;
  nextActivityId: number;
  nodes: ArtexNode[];
  edges: ArtexEdge[];
  anchors: ArtexExplorationAnchor[];
  tokenUsage: ArtexTokenUsageEntry[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class FileArtexGraphStore implements IArtexGraphStore {
  readonly explorationId: number;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly lockPath: string;
  private readonly activityLogPath: string;

  constructor(workspaceRoot: string, explorationId: number) {
    this.explorationId = explorationId;
    this.dir = artexExplorationDir(workspaceRoot, explorationId);
    this.stateFile = artexStateFile(workspaceRoot, explorationId);
    this.lockPath = artexStateLockPath(workspaceRoot, explorationId);
    this.activityLogPath = artexActivityLog(workspaceRoot, explorationId);
  }

  async init(description: string, goal: string): Promise<ArtexExploration> {
    await mkdir(this.dir, { recursive: true });
    const token = await this.acquireLock();
    try {
      if (await this.isInitialized()) {
        throw new Error(
          `artex exploration ${String(this.explorationId)} is already initialized at ${this.stateFile}`,
        );
      }
      const now = this.now();
      const exploration: ArtexExploration = {
        id: this.explorationId,
        description: description || undefined,
        goal,
        status: 'open',
        roundNo: 0,
        createdAt: now,
        updatedAt: now,
      };
      const state: ArtexPersistedState = {
        schemaVersion: ARTEX_STATE_SCHEMA_VERSION,
        exploration,
        nextNodeId: 1,
        nextActivityId: 1,
        nodes: [],
        edges: [],
        anchors: [],
        tokenUsage: [],
      };
      const origin: ArtexFactNode = {
        id: state.nextNodeId++,
        explorationId: this.explorationId,
        kind: 'fact',
        state: 'origin',
        payload: { text: goal, description },
        priority: 0,
        origin: 'system',
        createdAt: now,
        updatedAt: now,
        contentVersion: 1,
      };
      state.nodes.push(origin);
      await this.writeState(state);
      await writeFile(this.activityLogPath, '', 'utf8');
      return exploration;
    } finally {
      await this.releaseLock(token);
    }
  }

  async isInitialized(): Promise<boolean> {
    try {
      await readFile(this.stateFile, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<ArtexGraphSnapshot> {
    const state = await this.readState();
    return {
      exploration: state.exploration,
      nodes: state.nodes,
      edges: state.edges,
      anchors: state.anchors,
    };
  }

  async root(): Promise<ArtexExplorationRoot> {
    const state = await this.readState();
    return { description: state.exploration.description ?? '', goal: state.exploration.goal };
  }

  async addNode(input: ArtexAddNodeInput): Promise<number> {
    if (!isValidArtexNodeState(input.kind, input.state)) {
      throw new Error(`invalid state '${input.state}' for ${input.kind} node`);
    }
    return this.mutate((state) => {
      const now = this.now();
      const id = state.nextNodeId++;
      const node = {
        id,
        explorationId: this.explorationId,
        kind: input.kind,
        state: input.state,
        payload: input.payload,
        priority: input.priority,
        origin: input.origin,
        createdAt: now,
        updatedAt: now,
        contentVersion: 1,
      } as ArtexNode;
      state.nodes.push(node);
      for (const assetId of input.anchors ?? []) {
        this.addAnchor(state, id, assetId);
      }
      return id;
    });
  }

  addIntent(
    payload: Record<string, unknown>,
    priority: number,
    anchors?: readonly number[],
    origin?: string,
  ): Promise<number> {
    return this.addNode({
      kind: 'intent',
      payload,
      priority,
      state: 'open',
      origin: origin || 'planner',
      anchors,
    });
  }

  addGoal(payload: Record<string, unknown>, origin?: string): Promise<number> {
    return this.addNode({ kind: 'goal', payload, priority: 0, state: 'open', origin });
  }

  async getNode(id: number): Promise<ArtexNode | undefined> {
    const state = await this.readState();
    return state.nodes.find((node) => node.id === id);
  }

  async nodes(): Promise<readonly ArtexNode[]> {
    const state = await this.readState();
    return state.nodes;
  }

  async listByKind(kind: ArtexNodeKind, limit?: number): Promise<readonly ArtexNode[]> {
    const state = await this.readState();
    const matches = state.nodes
      .filter((node) => node.kind === kind)
      .toSorted((a, b) => a.id - b.id);
    return typeof limit === 'number' && limit > 0 ? matches.slice(0, limit) : matches;
  }

  async frontier(limit = 50): Promise<readonly ArtexIntentNode[]> {
    const effectiveLimit = limit <= 0 ? 50 : limit;
    const state = await this.readState();
    return state.nodes
      .filter((node): node is ArtexIntentNode => node.kind === 'intent' && node.state === 'open')
      .toSorted((a, b) => b.priority - a.priority || a.id - b.id)
      .slice(0, effectiveLimit);
  }

  setNodeState(id: number, nodeState: ArtexNodeState): Promise<void> {
    return this.mutate((state) => {
      const node = state.nodes.find((candidate) => candidate.id === id);
      if (!node) return;
      if (!isValidArtexNodeState(node.kind, nodeState)) {
        throw new Error(`invalid state '${nodeState}' for ${node.kind} node ${String(id)}`);
      }
      (node as { state: ArtexNodeState }).state = nodeState;
      node.blockedReason = undefined;
      node.contentVersion += 1;
      node.updatedAt = this.now();
    });
  }

  mergeNodePayload(id: number, patch: Record<string, unknown>): Promise<void> {
    return this.mutate((state) => {
      const node = state.nodes.find((candidate) => candidate.id === id);
      if (!node) return;
      node.payload = { ...node.payload, ...patch };
      node.contentVersion += 1;
      node.updatedAt = this.now();
    });
  }

  anchor(nodeId: number, assetId: number): Promise<void> {
    return this.mutate((state) => {
      this.addAnchor(state, nodeId, assetId);
    });
  }

  link(from: number, rel: ArtexEdgeRelation, to: number): Promise<void> {
    return this.mutate((state) => {
      const exists = state.edges.some(
        (edge) => edge.srcId === from && edge.rel === rel && edge.dstId === to,
      );
      if (exists) return;
      state.edges.push({
        explorationId: this.explorationId,
        srcId: from,
        rel,
        dstId: to,
        createdAt: this.now(),
      });
    });
  }

  async edges(): Promise<readonly ArtexEdge[]> {
    const state = await this.readState();
    return state.edges;
  }

  async factsYielded(intentId: number): Promise<readonly number[]> {
    const state = await this.readState();
    const factIds = new Set(
      state.nodes.filter((node) => node.kind === 'fact').map((node) => node.id),
    );
    return state.edges
      .filter((edge) => edge.srcId === intentId && edge.rel === 'yields' && factIds.has(edge.dstId))
      .map((edge) => edge.dstId)
      .toSorted((a, b) => a - b);
  }

  claimIntentToken(id: number, owner: string): Promise<ArtexClaimResult> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (!node || node.state !== 'open') return { claimed: false };
      const token = newArtexUnclaimToken();
      node.state = 'running';
      node.owner = owner;
      node.unclaimToken = token;
      node.lastHeartbeatAt = this.now();
      node.updatedAt = this.now();
      return { claimed: true, token };
    });
  }

  claimPausedIntentToken(id: number): Promise<ArtexClaimResult> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (!node || node.state !== 'paused') return { claimed: false };
      const token = newArtexUnclaimToken();
      node.state = 'running';
      node.blockedReason = undefined;
      node.contentVersion += 1;
      node.completedAt = undefined;
      node.unclaimToken = token;
      node.lastHeartbeatAt = this.now();
      node.updatedAt = this.now();
      return { claimed: true, token };
    });
  }

  heartbeatIntentClaim(id: number, token: string): Promise<void> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (node && node.state === 'running' && node.unclaimToken === token) {
        node.lastHeartbeatAt = this.now();
        return;
      }
      throw new ArtexIntentClaimLostError(id, 'heartbeat');
    });
  }

  settleIntentClaim(id: number, token: string, settle: ArtexIntentSettleState): Promise<void> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (node && node.state === 'running' && node.unclaimToken === token) {
        const terminal = isTerminalArtexIntentState(settle);
        node.state = settle;
        node.blockedReason = undefined;
        node.contentVersion += 1;
        node.completedAt = terminal ? this.now() : undefined;
        node.unclaimToken = undefined;
        node.updatedAt = this.now();
        return;
      }
      throw this.settleRejection(node, id, token);
    });
  }

  settleIntentClaimBlocked(id: number, token: string, reason: string): Promise<void> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (node && node.state === 'running' && node.unclaimToken === token) {
        node.state = 'blocked';
        node.blockedReason = reason || undefined;
        node.completedAt = this.now();
        node.unclaimToken = undefined;
        node.updatedAt = this.now();
        return;
      }
      throw this.settleRejection(node, id, token);
    });
  }

  compareAndSetIntentState(
    id: number,
    expected: ArtexIntentState,
    next: ArtexIntentState,
  ): Promise<boolean> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (!node || node.state !== expected) return false;
      const terminal = isTerminalArtexIntentState(next);
      node.state = next;
      node.blockedReason = undefined;
      node.contentVersion += 1;
      node.completedAt = terminal ? this.now() : undefined;
      node.updatedAt = this.now();
      return true;
    });
  }

  setIntentState(id: number, next: ArtexIntentState): Promise<void> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (!node) return;
      const terminal = isTerminalArtexIntentState(next);
      node.state = next;
      node.blockedReason = undefined;
      node.contentVersion += 1;
      node.completedAt = terminal ? this.now() : undefined;
      node.updatedAt = this.now();
    });
  }

  reopenIntent(id: number): Promise<boolean> {
    return this.mutate((state) => {
      const node = this.findIntent(state, id);
      if (
        !node ||
        (node.state !== 'blocked' && node.state !== 'exhausted' && node.state !== 'stopped')
      ) {
        return false;
      }
      node.state = 'open';
      node.completedAt = undefined;
      node.blockedReason = undefined;
      node.updatedAt = this.now();
      return true;
    });
  }

  reopenBlockedIntents(): Promise<number> {
    return this.mutate((state) => {
      let count = 0;
      for (const node of state.nodes) {
        if (node.kind === 'intent' && node.state === 'blocked') {
          node.state = 'open';
          node.completedAt = undefined;
          node.blockedReason = undefined;
          node.updatedAt = this.now();
          count += 1;
        }
      }
      return count;
    });
  }

  resetRunningIntents(options?: ArtexResetRunningOptions): Promise<number> {
    const ttlMs = options?.ttlMs ?? ARTEX_INTENT_CLAIM_TTL_MS;
    const nowMs = options?.nowMs ?? Date.now();
    const cutoff = nowMs - ttlMs;
    return this.mutate((state) => {
      let count = 0;
      for (const node of state.nodes) {
        if (node.kind !== 'intent' || node.state !== 'running') continue;
        const heartbeat = node.lastHeartbeatAt ? Date.parse(node.lastHeartbeatAt) : Number.NaN;
        const expired = !node.lastHeartbeatAt || Number.isNaN(heartbeat) || heartbeat < cutoff;
        if (!expired) continue;
        node.state = 'open';
        node.completedAt = undefined;
        node.blockedReason = undefined;
        node.unclaimToken = undefined;
        node.updatedAt = this.now();
        count += 1;
      }
      return count;
    });
  }

  async stats(): Promise<Record<string, number>> {
    const state = await this.readState();
    const counts: Record<string, number> = {};
    for (const node of state.nodes) {
      counts[node.kind] = (counts[node.kind] ?? 0) + 1;
    }
    return counts;
  }

  async hasActiveIntent(): Promise<boolean> {
    const state = await this.readState();
    return state.nodes.some(
      (node) => node.kind === 'intent' && (node.state === 'open' || node.state === 'running'),
    );
  }

  async hasOpenGoal(): Promise<boolean> {
    const state = await this.readState();
    return state.nodes.some((node) => node.kind === 'goal' && node.state === 'open');
  }

  async openGoalFingerprint(): Promise<string> {
    const state = await this.readState();
    return state.nodes
      .filter((node) => node.kind === 'goal' && node.state === 'open')
      .map((node) => node.id)
      .toSorted((a, b) => a - b)
      .join(',');
  }

  recordTokenUsage(entry: ArtexTokenUsageEntry): Promise<void> {
    return this.mutate((state) => {
      state.tokenUsage.push({ ...entry, at: entry.at || this.now() });
    });
  }

  async tokenRollup(): Promise<ArtexTokenRollup> {
    const state = await this.readState();
    const total = emptyTokenUsage();
    const byWorker = new Map<string, MutableTokenUsage>();
    for (const entry of state.tokenUsage) {
      addTokenUsage(total, entry);
      if (entry.worker) {
        let bucket = byWorker.get(entry.worker);
        if (!bucket) {
          bucket = emptyTokenUsage();
          byWorker.set(entry.worker, bucket);
        }
        addTokenUsage(bucket, entry);
      }
    }
    return {
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cacheReadTokens: total.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens,
      totalTokens:
        total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens,
      byWorker: Object.fromEntries(byWorker),
    };
  }

  async appendActivity(entry: ArtexActivityInput): Promise<number> {
    const token = await this.acquireLock();
    try {
      const state = await this.readState();
      const id = state.nextActivityId++;
      const record: ArtexActivityEntry = {
        id,
        nodeId: entry.nodeId,
        actor: entry.actor,
        kind: entry.kind,
        detail: entry.detail,
        at: this.now(),
      };
      await this.writeState(state);
      await appendFile(this.activityLogPath, `${JSON.stringify(record)}\n`, 'utf8');
      return id;
    } finally {
      await this.releaseLock(token);
    }
  }

  private settleRejection(
    node: ArtexIntentNode | undefined,
    id: number,
    token: string,
  ): Error {
    if (node && node.unclaimToken === token) {
      return new ArtexIntentStateConflictError(id);
    }
    return new ArtexIntentClaimLostError(id, 'settle');
  }

  private addAnchor(state: ArtexPersistedState, nodeId: number, assetId: number): void {
    if (nodeId <= 0 || assetId <= 0) return;
    const exists = state.anchors.some(
      (anchor) => anchor.nodeId === nodeId && anchor.assetId === assetId,
    );
    if (!exists) {
      state.anchors.push({ nodeId, assetId });
    }
  }

  private findIntent(state: ArtexPersistedState, id: number): ArtexIntentNode | undefined {
    const node = state.nodes.find((candidate) => candidate.id === id);
    return node && node.kind === 'intent' ? node : undefined;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async mutate<T>(fn: (state: ArtexPersistedState) => T): Promise<T> {
    const token = await this.acquireLock();
    try {
      const state = await this.readState();
      const result = fn(state);
      await this.writeState(state);
      return result;
    } finally {
      await this.releaseLock(token);
    }
  }

  private async readState(): Promise<ArtexPersistedState> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `artex exploration ${String(this.explorationId)} is not initialized (${this.stateFile} missing)`, { cause: error },
        );
      }
      throw error;
    }
    return JSON.parse(raw) as ArtexPersistedState;
  }

  private async writeState(state: ArtexPersistedState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp-${String(process.pid)}-${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.stateFile);
  }

  private async acquireLock(): Promise<string> {
    const token = randomUUID();
    const deadline = Date.now() + ARTEX_LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(
            `pid=${String(process.pid)} since=${this.now()} token=${token}`,
            'utf8',
          );
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.reapStaleLock();
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring artex state lock at ${this.lockPath}`, { cause: error });
        }
        await delay(ARTEX_LOCK_RETRY_INTERVAL_MS);
      }
    }
  }

  private async reapStaleLock(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    const pid = Number(/pid=(\d+)/.exec(content)?.[1]);
    const since = Date.parse(/since=(\S+)/.exec(content)?.[1] ?? '');
    const dead =
      Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && this.pidIsDead(pid);
    const expired = Number.isFinite(since) && Date.now() - since > ARTEX_LOCK_STALE_MS;
    if (dead || expired) {
      await rm(this.lockPath, { force: true });
    }
  }

  private pidIsDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async releaseLock(token: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    if (!content.includes(`token=${token}`)) return;
    await rm(this.lockPath, { force: true });
  }
}

interface MutableTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function emptyTokenUsage(): MutableTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addTokenUsage(target: MutableTokenUsage, usage: ArtexTokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
}
