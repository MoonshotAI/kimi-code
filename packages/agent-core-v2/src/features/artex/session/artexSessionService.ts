/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Event2 } from '#/app/event/event2';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IArtexModeService } from '#/features/artex/agent/artexMode';
import { ARTEX_EXPLORATION_UPDATED_EVENT_TYPE } from '#/features/artex/agent/artexOps';
import {
  IArtexOrchestrator,
  type ArtexOrchestratorStatus,
} from '#/features/artex/engine/artexOrchestrator';
import { newArtexBudget } from '#/features/artex/logic/budget';
import {
  buildCoverageLedger,
  coverageCompletenessFor,
} from '#/features/artex/logic/coverageLedger';
import { renderConstraintBlock } from '#/features/artex/prompts/index';
import type {
  ArtexCoverageLedger,
  ArtexEdge,
  ArtexExploration,
  ArtexExplorationAnchor,
  ArtexFindingNode,
  ArtexFindingNodeState,
  ArtexGoalNode,
  ArtexGoalState,
  ArtexNode,
  ArtexTaskConstraint,
  ArtexTaskCredentialSource,
  ArtexTaskScope,
  ArtexTaskScopeKind,
  ArtexTaskScopeSource,
  ArtexTokenRollup,
} from '#/features/artex/protocol/index';
import type {
  ArtexActivityEntry,
  IArtexGraphStore,
} from '#/features/artex/store/artexGraphStore';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import type {
  ArtexExchangeMeta,
  ArtexExchangeRaw,
  ArtexExternalTrafficInput,
  ArtexTrafficBinding,
  ArtexTrafficHostSummary,
  ArtexTrafficSearchQuery,
} from '#/features/artex/store/artexTrafficStore';
import { IArtexTrafficStoreProvider } from '#/features/artex/store/artexTrafficStoreProvider';
import type {
  ArtexCompanyScopeResult,
  ArtexCompanySummary,
  ArtexConstraintInput,
  ArtexTargetPin,
  ArtexUntestedResult,
  IArtexWorkStore,
} from '#/features/artex/store/artexWorkStore';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import type { ArtexArtifactRange } from '#/features/artex/store/fileArtexArtifactStore';
import { artexRootDir } from '#/features/artex/store/paths';

import { IArtexSessionContext } from './artexSessionContext';

export interface ArtexSessionExplorationUpdatedPayload {
  readonly explorationId: number | undefined;
  readonly reason?: string;
  readonly exploration?: ArtexExploration;
  readonly orchestrator?: ArtexOrchestratorStatus;
}

class ArtexSessionExplorationUpdated extends Event2<ArtexSessionExplorationUpdatedPayload> {
  static override readonly type = ARTEX_EXPLORATION_UPDATED_EVENT_TYPE;
  static override readonly observable = true;
}

export interface ArtexFindingReportedPayload {
  readonly explorationId: number;
  readonly finding: ArtexFindingNode;
}

export class ArtexFindingReported extends Event2<ArtexFindingReportedPayload> {
  static override readonly type = 'artex.finding.reported';
  static override readonly observable = true;
}
export interface ArtexFindingReported extends ArtexFindingReportedPayload {}

export interface ArtexFindingReportedEvent extends ArtexFindingReportedPayload {
  readonly type: 'artex.finding.reported';
}

export interface ArtexActivityAppendedPayload {
  readonly explorationId: number;
  readonly entry: ArtexActivityEntry;
}

export class ArtexActivityAppended extends Event2<ArtexActivityAppendedPayload> {
  static override readonly type = 'artex.activity.appended';
  static override readonly observable = true;
}
export interface ArtexActivityAppended extends ArtexActivityAppendedPayload {}

export interface ArtexActivityAppendedEvent extends ArtexActivityAppendedPayload {
  readonly type: 'artex.activity.appended';
}

export interface ArtexTrafficCapturedPayload {
  readonly exchange: ArtexExchangeMeta;
}

export class ArtexTrafficCaptured extends Event2<ArtexTrafficCapturedPayload> {
  static override readonly type = 'artex.traffic.captured';
  static override readonly observable = true;
}
export interface ArtexTrafficCaptured extends ArtexTrafficCapturedPayload {}

export interface ArtexTrafficCapturedEvent extends ArtexTrafficCapturedPayload {
  readonly type: 'artex.traffic.captured';
}

export interface ArtexSessionStatusResult {
  readonly explorationId?: number;
  readonly active: boolean;
  readonly initialized: boolean;
  readonly exploration?: ArtexExploration;
  readonly orchestrator?: ArtexOrchestratorStatus;
  readonly nodeCounts?: Record<string, number>;
}

export interface ArtexSessionStartInput {
  readonly explorationId?: number;
  readonly goal: string;
  readonly description?: string;
  readonly callerAgentId?: string;
  readonly targetConcurrency?: number;
  readonly timeoutSeconds?: number;
  readonly maxWaves?: number;
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly background?: boolean;
}

export interface ArtexSessionStartResult {
  readonly explorationId: number;
  readonly exploration: ArtexExploration;
  readonly status: ArtexOrchestratorStatus | undefined;
}

export type ArtexSessionControlAction = 'pause' | 'resume' | 'stop' | 'rerun_blocked';

export interface ArtexSessionControlInput {
  readonly explorationId?: number;
  readonly action: ArtexSessionControlAction;
  readonly callerAgentId?: string;
  readonly targetConcurrency?: number;
  readonly timeoutSeconds?: number;
  readonly maxWaves?: number;
}

export interface ArtexSessionControlResult {
  readonly explorationId: number;
  readonly action: ArtexSessionControlAction;
  readonly applied: boolean;
  readonly reopened?: number;
  readonly status: ArtexOrchestratorStatus | undefined;
}

export interface ArtexSessionGraphResult {
  readonly exploration: ArtexExploration;
  readonly nodes: readonly ArtexNode[];
  readonly edges: readonly ArtexEdge[];
  readonly anchors: readonly ArtexExplorationAnchor[];
  readonly stats: Record<string, number>;
  readonly tokenRollup: ArtexTokenRollup;
}

export interface ArtexSessionNodeDetailResult {
  readonly node: ArtexNode;
  readonly edgesOut: readonly { readonly rel: string; readonly to: number }[];
  readonly edgesIn: readonly { readonly rel: string; readonly from: number }[];
  readonly factsYielded?: readonly number[];
  readonly findingId?: number;
  readonly trafficCount?: number;
  readonly trafficBindings?: readonly ArtexTrafficBinding[];
  readonly activity: readonly ArtexActivityEntry[];
}

export interface ArtexSessionActivityQuery {
  readonly explorationId?: number;
  readonly nodeId?: number;
  readonly before?: number;
  readonly limit?: number;
  readonly q?: string;
}

export interface ArtexSessionActivityResult {
  readonly entries: readonly ArtexActivityEntry[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextBefore?: number;
}

export interface ArtexSessionFindingItem {
  readonly node: ArtexFindingNode;
  readonly findingId: number;
  readonly trafficCount: number;
  readonly bindings: readonly ArtexTrafficBinding[];
}

export interface ArtexSessionPatchFindingInput {
  readonly explorationId?: number;
  readonly nodeId: number;
  readonly state?: ArtexFindingNodeState;
  readonly summary?: string;
  readonly severity?: string;
  readonly name?: string;
  readonly vulnclass?: string;
  readonly evidence?: string;
  readonly payloadPatch?: Record<string, unknown>;
}

export interface ArtexSessionAddGoalInput {
  readonly explorationId?: number;
  readonly text: string;
  readonly category?: string;
  readonly origin?: string;
}

export interface ArtexSessionEditGoalInput {
  readonly explorationId?: number;
  readonly goalId: number;
  readonly text?: string;
  readonly category?: string;
  readonly state?: ArtexGoalState;
}

export interface ArtexSessionDeleteGoalInput {
  readonly explorationId?: number;
  readonly goalId: number;
}

export interface ArtexSessionConstraintsResult {
  readonly constraints: readonly ArtexTaskConstraint[];
  readonly rendered: string;
}

export interface ArtexSessionSetConstraintsInput {
  readonly explorationId?: number;
  readonly entries: readonly ArtexConstraintInput[];
  readonly origin?: string;
  readonly append?: boolean;
}

export interface ArtexSessionScopeResult {
  readonly taskScope: readonly ArtexTaskScope[];
  readonly companies: readonly ArtexCompanySummary[];
}

export type ArtexSessionAddScopeInput =
  | {
      readonly explorationId?: number;
      readonly kind: ArtexTaskScopeKind;
      readonly value: string;
      readonly reason?: string;
      readonly source?: ArtexTaskScopeSource;
    }
  | {
      readonly company: string;
      readonly scope: readonly string[];
      readonly reason?: string;
      readonly logo?: string;
    };

export type ArtexSessionAddScopeResult =
  | { readonly taskScope: ArtexTaskScope }
  | { readonly companyScope: ArtexCompanyScopeResult };

export interface ArtexSessionDeleteScopeInput {
  readonly explorationId?: number;
  readonly scopeId: number;
  readonly companyId?: number;
}

export interface ArtexSessionCredentialView {
  readonly id: number;
  readonly taskId: number;
  readonly domain: string;
  readonly username: string;
  readonly password: string;
  readonly hasPassword: boolean;
  readonly source: ArtexTaskCredentialSource;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtexSessionSaveCredentialInput {
  readonly explorationId?: number;
  readonly domain: string;
  readonly username: string;
  readonly password: string;
  readonly note?: string;
  readonly source?: ArtexTaskCredentialSource;
}

export interface ArtexSessionDeleteCredentialInput {
  readonly explorationId?: number;
  readonly credentialId: number;
}

export interface ArtexSessionCoverageResult {
  readonly denominator: number;
  readonly tested: number;
  readonly pct: number | null;
  readonly byType: Readonly<Record<string, { readonly total: number; readonly tested: number }>>;
  readonly ledger: ArtexCoverageLedger;
}

export interface ArtexSessionUntestedAssetsInput {
  readonly explorationId?: number;
  readonly type?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ArtexSessionUntestedAssetsResult extends ArtexUntestedResult {
  readonly page: number;
  readonly pageSize: number;
}

export type ArtexSessionIntentControlAction = 'pause' | 'resume' | 'cancel' | 'reopen';

export interface ArtexSessionIntentControlInput {
  readonly explorationId?: number;
  readonly intentId: number;
  readonly action: ArtexSessionIntentControlAction;
  readonly reason?: string;
}

export interface ArtexSessionIntentControlResult {
  readonly intentId: number;
  readonly state: string;
}

export interface ArtexSessionIngestTrafficInput {
  readonly entries: ArtexExternalTrafficInput | readonly ArtexExternalTrafficInput[];
}

export interface ArtexSessionIngestTrafficResult {
  readonly ids: readonly string[];
  readonly count: number;
}

export interface ArtexSessionTargetPinsInput {
  readonly explorationId?: number;
  readonly host?: string;
  readonly port?: number;
}

export interface ArtexSessionRevokePinInput {
  readonly explorationId?: number;
  readonly pinId: number;
}

export interface IArtexSessionService {
  readonly _serviceBrand: undefined;

  status(explorationId?: number): Promise<ArtexSessionStatusResult>;
  start(input: ArtexSessionStartInput): Promise<ArtexSessionStartResult>;
  control(input: ArtexSessionControlInput): Promise<ArtexSessionControlResult>;

  graph(explorationId?: number): Promise<ArtexSessionGraphResult>;
  nodeDetail(nodeId: number, explorationId?: number): Promise<ArtexSessionNodeDetailResult>;
  activity(query?: ArtexSessionActivityQuery): Promise<ArtexSessionActivityResult>;

  findings(explorationId?: number): Promise<readonly ArtexSessionFindingItem[]>;
  patchFinding(input: ArtexSessionPatchFindingInput): Promise<ArtexFindingNode>;

  goals(explorationId?: number): Promise<readonly ArtexGoalNode[]>;
  addGoal(input: ArtexSessionAddGoalInput): Promise<ArtexGoalNode>;
  editGoal(input: ArtexSessionEditGoalInput): Promise<ArtexGoalNode>;
  deleteGoal(input: ArtexSessionDeleteGoalInput): Promise<{ readonly deleted: boolean }>;

  constraints(explorationId?: number): Promise<ArtexSessionConstraintsResult>;
  setConstraints(input: ArtexSessionSetConstraintsInput): Promise<ArtexSessionConstraintsResult>;

  scope(explorationId?: number): Promise<ArtexSessionScopeResult>;
  addScope(input: ArtexSessionAddScopeInput): Promise<ArtexSessionAddScopeResult>;
  deleteScope(input: ArtexSessionDeleteScopeInput): Promise<{ readonly deleted: boolean }>;

  credentials(explorationId?: number): Promise<readonly ArtexSessionCredentialView[]>;
  saveCredential(input: ArtexSessionSaveCredentialInput): Promise<ArtexSessionCredentialView>;
  deleteCredential(input: ArtexSessionDeleteCredentialInput): Promise<{ readonly deleted: boolean }>;

  coverage(explorationId?: number): Promise<ArtexSessionCoverageResult>;
  untestedAssets(
    input?: ArtexSessionUntestedAssetsInput,
  ): Promise<ArtexSessionUntestedAssetsResult>;

  intentControl(input: ArtexSessionIntentControlInput): Promise<ArtexSessionIntentControlResult>;

  trafficHosts(): Promise<readonly ArtexTrafficHostSummary[]>;
  trafficSearch(query: ArtexTrafficSearchQuery): Promise<readonly ArtexExchangeMeta[]>;
  trafficExchange(id: string): Promise<ArtexExchangeRaw | undefined>;
  trafficBlob(
    hash: string,
    offset?: number,
    length?: number,
  ): Promise<ArtexArtifactRange | undefined>;
  ingestTraffic(input: ArtexSessionIngestTrafficInput): Promise<ArtexSessionIngestTrafficResult>;

  targetPins(input?: ArtexSessionTargetPinsInput): Promise<readonly ArtexTargetPin[]>;
  revokeTargetPin(input: ArtexSessionRevokePinInput): Promise<{ readonly revoked: boolean }>;
}

export const IArtexSessionService: ServiceIdentifier<IArtexSessionService> =
  createDecorator<IArtexSessionService>('artexSessionService');

const MASKED_SECRET = '••••••••';

async function nextExplorationId(workspaceRoot: string): Promise<number> {
  const dir = join(artexRootDir(workspaceRoot), 'explorations');
  try {
    const entries = await readdir(dir);
    let maxId = 0;
    for (const entry of entries) {
      const parsed = Number(entry);
      if (Number.isInteger(parsed) && parsed > maxId) maxId = parsed;
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}

export class ArtexSessionService extends Disposable implements IArtexSessionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IArtexSessionContext private readonly artexSession: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly graphStoreProvider: IArtexGraphStoreProvider,
    @IArtexWorkStoreProvider private readonly workStoreProvider: IArtexWorkStoreProvider,
    @IArtexTrafficStoreProvider private readonly trafficStoreProvider: IArtexTrafficStoreProvider,
    @IArtexOrchestrator private readonly orchestrator: IArtexOrchestrator,
    @ISessionEventBus private readonly sessionBus: ISessionEventBus,
    @IAgentLifecycleService private readonly agentLifecycle?: IAgentLifecycleService,
  ) {
    super();

    if (this.graphStoreProvider.onDidAppendActivity !== undefined) {
      this._register(
        this.graphStoreProvider.onDidAppendActivity((ev) => {
          if (ev.workspaceRoot !== this.workspaceRoot) return;
          this.sessionBus.publish(
            new ArtexActivityAppended({
              explorationId: ev.explorationId,
              entry: ev.entry,
            }),
          );
        }),
      );
    }

    if (this.graphStoreProvider.onDidMutateFinding !== undefined) {
      this._register(
        this.graphStoreProvider.onDidMutateFinding((ev) => {
          if (ev.workspaceRoot !== this.workspaceRoot) return;
          this.sessionBus.publish(
            new ArtexFindingReported({
              explorationId: ev.explorationId,
              finding: ev.finding,
            }),
          );
        }),
      );
    }

    if (this.trafficStoreProvider.onDidRecord !== undefined) {
      this._register(
        this.trafficStoreProvider.onDidRecord((ev) => {
          if (ev.workspaceRoot !== this.workspaceRoot) return;
          this.sessionBus.publish(
            new ArtexTrafficCaptured({
              exchange: ev.exchange,
            }),
          );
        }),
      );
    }

    if (this.artexSession.onDidChangeActiveExplorationId !== undefined) {
      this._register(
        this.artexSession.onDidChangeActiveExplorationId((explorationId) => {
          this.sessionBus.publish(
            new ArtexSessionExplorationUpdated({
              explorationId,
              reason: 'active_exploration_changed',
              orchestrator:
                explorationId !== undefined
                  ? this.orchestrator.getStatus(explorationId)
                  : undefined,
            }),
          );
        }),
      );
    }
  }

  async status(explorationId?: number): Promise<ArtexSessionStatusResult> {
    const resolvedId = explorationId ?? this.artexSession.getActiveExplorationId();
    if (resolvedId === undefined) {
      return {
        explorationId: undefined,
        active: false,
        initialized: false,
      };
    }
    const store = this.graphStoreProvider.open(this.workspaceRoot, resolvedId);
    const initialized = await store.isInitialized();
    const orchestrator = this.orchestrator.getStatus(resolvedId);
    if (!initialized) {
      return {
        explorationId: resolvedId,
        active: this.artexSession.getActiveExplorationId() === resolvedId,
        initialized: false,
        orchestrator,
      };
    }
    const [exploration, nodeCounts] = await Promise.all([store.exploration(), store.stats()]);
    return {
      explorationId: resolvedId,
      active: this.artexSession.getActiveExplorationId() === resolvedId,
      initialized: true,
      exploration,
      orchestrator,
      nodeCounts,
    };
  }

  async start(input: ArtexSessionStartInput): Promise<ArtexSessionStartResult> {
    const explorationId =
      input.explorationId ?? (await nextExplorationId(this.workspaceRoot));
    const store = this.graphStoreProvider.open(this.workspaceRoot, explorationId);
    let exploration: ArtexExploration;
    if (!(await store.isInitialized())) {
      const goal = input.goal.trim();
      if (goal === '') {
        throw new Error('goal is required to start a new ARTEX exploration');
      }
      exploration = await store.init((input.description ?? '').trim(), goal);
    } else {
      exploration = await store.exploration();
    }

    this.artexSession.setActiveExplorationId(explorationId);
    const callerAgentId = input.callerAgentId ?? MAIN_AGENT_ID;
    this.tryEnterMode(callerAgentId, explorationId);

    const taskBudget =
      input.tokenBudget !== undefined || input.turnBudget !== undefined
        ? newArtexBudget(input.tokenBudget ?? 0, input.turnBudget ?? 0)
        : undefined;
    const runOptions = {
      explorationId,
      callerAgentId,
      workspaceRoot: this.workspaceRoot,
      targetConcurrency: input.targetConcurrency,
      timeoutSeconds: input.timeoutSeconds,
      maxWaves: input.maxWaves,
      taskBudget,
    };

    if (input.background === false) {
      await this.orchestrator.run(runOptions);
      exploration = await store.exploration();
    } else {
      this.orchestrator.start(runOptions);
    }

    const orchStatus = this.orchestrator.getStatus(explorationId);
    await this.emitExplorationUpdated(explorationId, 'started', store, orchStatus);
    return { explorationId, exploration, status: orchStatus };
  }

  async control(input: ArtexSessionControlInput): Promise<ArtexSessionControlResult> {
    const id = this.requireExplorationId(input.explorationId);
    const store = await this.requireInitializedStore(id);
    switch (input.action) {
      case 'pause': {
        const applied = await this.orchestrator.pause(id);
        const status = this.orchestrator.getStatus(id);
        await this.emitExplorationUpdated(id, 'paused', store, status);
        return { explorationId: id, action: input.action, applied, status };
      }
      case 'stop': {
        const applied = this.orchestrator.stop(id);
        const status = this.orchestrator.getStatus(id);
        await this.emitExplorationUpdated(id, 'stopped', store, status);
        return { explorationId: id, action: input.action, applied, status };
      }
      case 'resume': {
        this.artexSession.setActiveExplorationId(id);
        const callerAgentId = input.callerAgentId ?? MAIN_AGENT_ID;
        this.tryEnterMode(callerAgentId, id);
        this.orchestrator.start({
          explorationId: id,
          callerAgentId,
          workspaceRoot: this.workspaceRoot,
          targetConcurrency: input.targetConcurrency,
          timeoutSeconds: input.timeoutSeconds,
          maxWaves: input.maxWaves,
        });
        const status = this.orchestrator.getStatus(id);
        await this.emitExplorationUpdated(id, 'resumed', store, status);
        return { explorationId: id, action: input.action, applied: true, status };
      }
      case 'rerun_blocked': {
        const reopened = await store.reopenBlockedIntents();
        if (reopened > 0) {
          await store.reopenExploration();
        }
        this.orchestrator.notifyGraphChanged(id, 'resume');
        const status = this.orchestrator.getStatus(id);
        await this.emitExplorationUpdated(id, 'rerun_blocked', store, status);
        return {
          explorationId: id,
          action: input.action,
          applied: reopened > 0,
          reopened,
          status,
        };
      }
      default: {
        const exhaustive: never = input.action;
        return exhaustive;
      }
    }
  }

  async graph(explorationId?: number): Promise<ArtexSessionGraphResult> {
    const id = this.requireExplorationId(explorationId);
    const store = await this.requireInitializedStore(id);
    const [snapshot, stats, tokenRollup] = await Promise.all([
      store.load(),
      store.stats(),
      store.tokenRollup(),
    ]);
    return {
      exploration: snapshot.exploration,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      anchors: snapshot.anchors,
      stats,
      tokenRollup,
    };
  }

  async nodeDetail(
    nodeId: number,
    explorationId?: number,
  ): Promise<ArtexSessionNodeDetailResult> {
    const id = this.requireExplorationId(explorationId);
    const store = await this.requireInitializedStore(id);
    const node = await store.getNode(nodeId);
    if (node === undefined) {
      throw new Error(`node ${String(nodeId)} does not exist`);
    }
    const [edges, activity, yielded] = await Promise.all([
      store.edges(),
      store.readActivityByNode(nodeId),
      node.kind === 'intent' ? store.factsYielded(nodeId) : Promise.resolve(undefined),
    ]);
    const edgesOut = edges
      .filter((edge) => edge.srcId === nodeId)
      .map((edge) => ({ rel: edge.rel, to: edge.dstId }));
    const edgesIn = edges
      .filter((edge) => edge.dstId === nodeId)
      .map((edge) => ({ rel: edge.rel, from: edge.srcId }));

    let findingId: number | undefined;
    let trafficCount: number | undefined;
    let trafficBindings: readonly ArtexTrafficBinding[] | undefined;
    if (node.kind === 'finding') {
      const payloadFindingId = (node.payload as { finding_id?: unknown }).finding_id;
      findingId = typeof payloadFindingId === 'number' ? payloadFindingId : node.id;
      trafficBindings = await this.trafficStore().findingBindings(node.id);
      trafficCount = trafficBindings.length;
    }

    return {
      node,
      edgesOut,
      edgesIn,
      factsYielded: yielded,
      findingId,
      trafficCount,
      trafficBindings,
      activity,
    };
  }

  async activity(query?: ArtexSessionActivityQuery): Promise<ArtexSessionActivityResult> {
    const id = this.requireExplorationId(query?.explorationId);
    const store = await this.requireInitializedStore(id);
    const raw =
      query?.nodeId !== undefined
        ? await store.readActivityByNode(query.nodeId)
        : await store.readActivity();
    const keyword = (query?.q ?? '').trim().toLowerCase();
    const sorted = raw.toSorted((a, b) => b.id - a.id);
    const filtered =
      keyword === ''
        ? sorted
        : sorted.filter((entry) => {
            const haystack = [entry.actor, entry.kind, entry.tool, entry.summary, entry.text]
              .filter((part): part is string => typeof part === 'string')
              .join(' ')
              .toLowerCase();
            return haystack.includes(keyword);
          });
    const total = filtered.length;
    const before = query?.before ?? 0;
    const afterBefore = before > 0 ? filtered.filter((entry) => entry.id < before) : filtered;
    const limit = query?.limit !== undefined && query.limit > 0 ? query.limit : 100;
    const hasMore = afterBefore.length > limit;
    const entries = afterBefore.slice(0, limit);
    return {
      entries,
      total,
      hasMore,
      nextBefore: hasMore && entries.length > 0 ? entries.at(-1)!.id : undefined,
    };
  }

  async findings(explorationId?: number): Promise<readonly ArtexSessionFindingItem[]> {
    const id = this.requireExplorationId(explorationId);
    const store = await this.requireInitializedStore(id);
    const findingNodes = (await store.listByKind('finding'))
      .filter((node): node is ArtexFindingNode => node.kind === 'finding')
      .toSorted((a, b) => b.id - a.id);
    const traffic = this.trafficStore();
    return Promise.all(
      findingNodes.map(async (node) => {
        const bindings = await traffic.findingBindings(node.id);
        const payloadFindingId = (node.payload as { finding_id?: unknown }).finding_id;
        const findingId = typeof payloadFindingId === 'number' ? payloadFindingId : node.id;
        return {
          node,
          findingId,
          trafficCount: bindings.length,
          bindings,
        };
      }),
    );
  }

  async patchFinding(input: ArtexSessionPatchFindingInput): Promise<ArtexFindingNode> {
    const id = this.requireExplorationId(input.explorationId);
    const store = await this.requireInitializedStore(id);
    const payloadPatch: Record<string, unknown> = { ...input.payloadPatch };
    if (input.summary !== undefined) payloadPatch['summary'] = input.summary;
    if (input.severity !== undefined) payloadPatch['severity'] = input.severity;
    if (input.name !== undefined) payloadPatch['name'] = input.name;
    if (input.vulnclass !== undefined) payloadPatch['vulnclass'] = input.vulnclass;
    if (input.evidence !== undefined) payloadPatch['evidence'] = input.evidence;
    const updated = await store.patchFinding(input.nodeId, {
      state: input.state,
      payload: Object.keys(payloadPatch).length > 0 ? payloadPatch : undefined,
    });
    if (updated === undefined) {
      throw new Error(`finding node ${String(input.nodeId)} does not exist`);
    }
    await this.emitExplorationUpdated(id, 'finding_patched', store);
    return updated;
  }

  async goals(explorationId?: number): Promise<readonly ArtexGoalNode[]> {
    const id = this.requireExplorationId(explorationId);
    const store = await this.requireInitializedStore(id);
    return (await store.listByKind('goal')).filter(
      (node): node is ArtexGoalNode => node.kind === 'goal',
    );
  }

  async addGoal(input: ArtexSessionAddGoalInput): Promise<ArtexGoalNode> {
    const id = this.requireExplorationId(input.explorationId);
    const store = await this.requireInitializedStore(id);
    const text = input.text.trim();
    if (text === '') {
      throw new Error('goal text must not be empty');
    }
    const payload: Record<string, unknown> = { text, summary: text };
    const category = input.category?.trim();
    if (category !== undefined && category !== '') {
      payload['category'] = category;
    }
    const goalId = await store.addGoal(payload, input.origin ?? 'user');
    const originId = (await store.listByKind('fact')).find((node) => node.state === 'origin')?.id;
    if (originId !== undefined) {
      await store.link(originId, 'spawns', goalId);
    }
    await store.reopenExploration();
    this.orchestrator.notifyGraphChanged(id, 'set_goals');
    const created = await store.getNode(goalId);
    if (created === undefined || created.kind !== 'goal') {
      throw new Error(`failed to read created goal ${String(goalId)}`);
    }
    await this.emitExplorationUpdated(id, 'goal_added', store);
    return created;
  }

  async editGoal(input: ArtexSessionEditGoalInput): Promise<ArtexGoalNode> {
    const id = this.requireExplorationId(input.explorationId);
    const store = await this.requireInitializedStore(id);
    const updated = await store.editGoal(input.goalId, {
      text: input.text,
      category: input.category,
      state: input.state,
    });
    if (updated === undefined) {
      throw new Error(`goal ${String(input.goalId)} does not exist`);
    }
    if (input.state === 'open') {
      await store.reopenExploration();
    }
    this.orchestrator.notifyGraphChanged(id, 'set_goals');
    await this.emitExplorationUpdated(id, 'goal_edited', store);
    return updated;
  }

  async deleteGoal(input: ArtexSessionDeleteGoalInput): Promise<{ readonly deleted: boolean }> {
    const id = this.requireExplorationId(input.explorationId);
    const store = await this.requireInitializedStore(id);
    const deleted = await store.deleteGoal(input.goalId);
    if (deleted) {
      this.orchestrator.notifyGraphChanged(id, 'set_goals');
      await this.emitExplorationUpdated(id, 'goal_deleted', store);
    }
    return { deleted };
  }

  async constraints(explorationId?: number): Promise<ArtexSessionConstraintsResult> {
    const id = this.requireExplorationId(explorationId);
    const work = await this.openWorkStore();
    const list = await work.listConstraints(id);
    return {
      constraints: list,
      rendered: renderConstraintBlock(list),
    };
  }

  async setConstraints(
    input: ArtexSessionSetConstraintsInput,
  ): Promise<ArtexSessionConstraintsResult> {
    const id = this.requireExplorationId(input.explorationId);
    const work = await this.openWorkStore();
    const origin = input.origin ?? 'user';
    if (input.append) {
      await work.appendConstraints(id, input.entries, origin);
    } else {
      await work.setConstraints(id, input.entries, origin);
    }
    const list = await work.listConstraints(id);
    await this.emitExplorationUpdatedIfInitialized(id, 'constraints_updated');
    return {
      constraints: list,
      rendered: renderConstraintBlock(list),
    };
  }

  async scope(explorationId?: number): Promise<ArtexSessionScopeResult> {
    const id = this.requireExplorationId(explorationId);
    const work = await this.openWorkStore();
    const [taskScope, companies] = await Promise.all([
      work.listTaskScope(id),
      work.listCompanies(),
    ]);
    return { taskScope, companies };
  }

  async addScope(input: ArtexSessionAddScopeInput): Promise<ArtexSessionAddScopeResult> {
    const work = await this.openWorkStore();
    if ('company' in input) {
      const company = await work.upsertCompany(input.company, input.logo);
      const companyScope = await work.addCompanyScope(
        company.id,
        input.scope,
        input.reason ?? '',
      );
      const activeId = this.artexSession.getActiveExplorationId();
      if (activeId !== undefined) {
        await this.emitExplorationUpdatedIfInitialized(activeId, 'scope_updated');
      }
      return { companyScope };
    }
    const id = this.requireExplorationId(input.explorationId);
    const taskScope = await work.addTaskScope(
      id,
      input.kind,
      input.value,
      input.reason ?? '',
      input.source ?? 'manual',
    );
    await this.emitExplorationUpdatedIfInitialized(id, 'scope_updated');
    return { taskScope };
  }

  async deleteScope(
    input: ArtexSessionDeleteScopeInput,
  ): Promise<{ readonly deleted: boolean }> {
    const work = await this.openWorkStore();
    if (input.companyId !== undefined) {
      const deleted = await work.deleteCompanyScope(input.companyId, input.scopeId);
      const activeId = this.artexSession.getActiveExplorationId();
      if (deleted && activeId !== undefined) {
        await this.emitExplorationUpdatedIfInitialized(activeId, 'scope_deleted');
      }
      return { deleted };
    }
    const id = this.requireExplorationId(input.explorationId);
    const deleted = await work.deleteTaskScope(id, input.scopeId);
    if (deleted) {
      await this.emitExplorationUpdatedIfInitialized(id, 'scope_deleted');
    }
    return { deleted };
  }

  async credentials(explorationId?: number): Promise<readonly ArtexSessionCredentialView[]> {
    const id = this.requireExplorationId(explorationId);
    const work = await this.openWorkStore();
    const creds = await work.taskCredentials(id);
    return creds.map((cred) => ({
      id: cred.id,
      taskId: cred.taskId,
      domain: cred.domain,
      username: cred.username,
      password: cred.password === '' ? '' : MASKED_SECRET,
      hasPassword: cred.password.length > 0,
      source: cred.source,
      note: cred.note,
      createdAt: cred.createdAt,
      updatedAt: cred.updatedAt,
    }));
  }

  async saveCredential(
    input: ArtexSessionSaveCredentialInput,
  ): Promise<ArtexSessionCredentialView> {
    const id = this.requireExplorationId(input.explorationId);
    if (input.domain.trim() === '') throw new Error('domain must not be empty');
    if (input.username.trim() === '') throw new Error('username must not be empty');
    const work = await this.openWorkStore();
    const cred = await work.upsertTaskCredential(id, {
      domain: input.domain,
      username: input.username,
      password: input.password,
      note: input.note,
      source: input.source ?? 'user',
    });
    return {
      id: cred.id,
      taskId: cred.taskId,
      domain: cred.domain,
      username: cred.username,
      password: cred.password === '' ? '' : MASKED_SECRET,
      hasPassword: cred.password.length > 0,
      source: cred.source,
      note: cred.note,
      createdAt: cred.createdAt,
      updatedAt: cred.updatedAt,
    };
  }

  async deleteCredential(
    input: ArtexSessionDeleteCredentialInput,
  ): Promise<{ readonly deleted: boolean }> {
    const id = this.requireExplorationId(input.explorationId);
    const work = await this.openWorkStore();
    const deleted = await work.deleteTaskCredential(id, input.credentialId);
    return { deleted };
  }

  async coverage(explorationId?: number): Promise<ArtexSessionCoverageResult> {
    const id = this.requireExplorationId(explorationId);
    const [store, work] = await Promise.all([
      this.requireInitializedStore(id),
      this.openWorkStore(),
    ]);
    const [snapshot, denom, taskAssets, entries] = await Promise.all([
      store.load(),
      work.coverageDenominator(id),
      work.assetsForTask(id),
      work.coverageEntries(id),
    ]);

    const factIds = new Set(
      snapshot.nodes.filter((node) => node.kind === 'fact').map((node) => node.id),
    );
    const testedIds = new Set(
      snapshot.anchors
        .filter((anchor) => factIds.has(anchor.nodeId))
        .map((anchor) => anchor.assetId),
    );
    const inScopeSet = new Set(denom.assetIds);
    const assetById = new Map(taskAssets.map((asset) => [asset.id, asset]));
    const byTypeMutable: Record<string, { total: number; tested: number }> = {};
    let tested = 0;
    for (const assetId of inScopeSet) {
      const isTested = testedIds.has(assetId);
      if (isTested) tested += 1;
      const asset = assetById.get(assetId);
      if (asset !== undefined) {
        const bucket = byTypeMutable[asset.type] ?? { total: 0, tested: 0 };
        bucket.total += 1;
        if (isTested) bucket.tested += 1;
        byTypeMutable[asset.type] = bucket;
      }
    }

    const mandatory: string[] = [];
    for (const node of snapshot.nodes) {
      if (node.kind !== 'goal') continue;
      const category = (node.payload as { category?: unknown; vulnclass?: unknown }).category ??
        (node.payload as { vulnclass?: unknown }).vulnclass;
      if (typeof category === 'string' && category.trim() !== '') {
        mandatory.push(category.trim());
      }
    }
    const findingsByClass: Record<string, number> = {};
    for (const node of snapshot.nodes) {
      if (node.kind !== 'finding') continue;
      const vc = (node.payload as { vulnclass?: unknown }).vulnclass;
      if (typeof vc === 'string' && vc.trim() !== '') {
        const key = vc.trim().toLowerCase();
        findingsByClass[key] = (findingsByClass[key] ?? 0) + 1;
      }
    }

    const orchStatus = this.orchestrator.getStatus(id);
    const completeness = coverageCompletenessFor(
      snapshot.exploration.status === 'achieved' ? 'done' : orchStatus?.running ? 'running' : 'done',
      orchStatus?.paused ?? false,
      false,
      false,
    );
    const baseLedger = buildCoverageLedger(entries, mandatory, completeness);
    const ledger: ArtexCoverageLedger = {
      ...baseLedger,
      findingsByClass,
    };

    return {
      denominator: denom.denominator,
      tested,
      pct:
        denom.denominator === 0
          ? null
          : Math.round((tested / denom.denominator) * 1000) / 10,
      byType: byTypeMutable,
      ledger,
    };
  }

  async untestedAssets(
    input?: ArtexSessionUntestedAssetsInput,
  ): Promise<ArtexSessionUntestedAssetsResult> {
    const id = this.requireExplorationId(input?.explorationId);
    const [store, work] = await Promise.all([
      this.requireInitializedStore(id),
      this.openWorkStore(),
    ]);
    const snapshot = await store.load();
    const factIds = new Set(
      snapshot.nodes.filter((node) => node.kind === 'fact').map((node) => node.id),
    );
    const tested = new Set<number>();
    for (const anchor of snapshot.anchors) {
      if (factIds.has(anchor.nodeId)) tested.add(anchor.assetId);
    }
    const page = input?.page !== undefined && input.page > 0 ? input.page : 1;
    const pageSize = input?.pageSize !== undefined && input.pageSize > 0 ? input.pageSize : 20;
    const offset = (page - 1) * pageSize;
    const result = await work.listUntestedAssets(id, [...tested], input?.type, pageSize, offset);
    return {
      assets: result.assets,
      total: result.total,
      page,
      pageSize,
    };
  }

  async intentControl(
    input: ArtexSessionIntentControlInput,
  ): Promise<ArtexSessionIntentControlResult> {
    const id = this.requireExplorationId(input.explorationId);
    const store = await this.requireInitializedStore(id);
    const node = await store.getNode(input.intentId);
    if (node === undefined || node.kind !== 'intent') {
      throw new Error(`intent ${String(input.intentId)} does not exist`);
    }
    switch (input.action) {
      case 'pause': {
        if (node.state !== 'running') {
          throw new Error('only running intents can be paused');
        }
        const aborted = this.orchestrator.pauseIntent(input.intentId);
        if (!aborted) {
          await store.compareAndSetIntentState(input.intentId, 'running', 'paused');
        }
        await this.emitExplorationUpdated(id, 'intent_paused', store);
        return { intentId: input.intentId, state: 'paused' };
      }
      case 'resume': {
        if (node.state !== 'paused') {
          throw new Error('only paused intents can be resumed');
        }
        const changed = await store.compareAndSetIntentState(input.intentId, 'paused', 'open');
        if (!changed) {
          throw new Error('intent is no longer in the paused state');
        }
        this.orchestrator.notifyGraphChanged(id, 'resume');
        await this.emitExplorationUpdated(id, 'intent_resumed', store);
        return { intentId: input.intentId, state: 'open' };
      }
      case 'cancel': {
        const reason = (input.reason ?? 'cancelled by user').trim();
        if (node.state === 'running') {
          this.orchestrator.abortIntent(input.intentId, new Error(reason));
        }
        await store.softDeleteIntent(input.intentId, reason);
        this.orchestrator.notifyGraphChanged(id, 'kill_work');
        await this.emitExplorationUpdated(id, 'intent_cancelled', store);
        return { intentId: input.intentId, state: 'deleted' };
      }
      case 'reopen': {
        const reopened = await store.reopenIntent(input.intentId);
        if (!reopened) {
          throw new Error(`intent ${String(input.intentId)} cannot be reopened from state ${node.state}`);
        }
        this.orchestrator.notifyGraphChanged(id, 'resume');
        await this.emitExplorationUpdated(id, 'intent_reopened', store);
        return { intentId: input.intentId, state: 'open' };
      }
      default: {
        const exhaustive: never = input.action;
        return exhaustive;
      }
    }
  }

  trafficHosts(): Promise<readonly ArtexTrafficHostSummary[]> {
    return this.trafficStore().listHosts();
  }

  trafficSearch(query: ArtexTrafficSearchQuery): Promise<readonly ArtexExchangeMeta[]> {
    return this.trafficStore().search(query);
  }

  trafficExchange(id: string): Promise<ArtexExchangeRaw | undefined> {
    return this.trafficStore().get(id);
  }

  trafficBlob(
    hash: string,
    offset = 0,
    length = 8192,
  ): Promise<ArtexArtifactRange | undefined> {
    return this.trafficStore().blobRange(hash, offset, length);
  }

  async ingestTraffic(
    input: ArtexSessionIngestTrafficInput,
  ): Promise<ArtexSessionIngestTrafficResult> {
    const ids = await this.trafficStore().ingestExternalTraffic(input.entries);
    return { ids, count: ids.length };
  }

  async targetPins(input?: ArtexSessionTargetPinsInput): Promise<readonly ArtexTargetPin[]> {
    const id = this.requireExplorationId(input?.explorationId);
    const work = await this.openWorkStore();
    return work.listTargetPins(id, input?.host, input?.port);
  }

  async revokeTargetPin(
    input: ArtexSessionRevokePinInput,
  ): Promise<{ readonly revoked: boolean }> {
    const id = this.requireExplorationId(input.explorationId);
    const work = await this.openWorkStore();
    const revoked = await work.revokeTargetPin(id, input.pinId);
    return { revoked };
  }

  private get workspaceRoot(): string {
    return this.sessionContext.sessionDir;
  }

  private requireExplorationId(explorationId?: number): number {
    const resolved = explorationId ?? this.artexSession.getActiveExplorationId();
    if (resolved === undefined) {
      throw new Error('no active ARTEX exploration');
    }
    return resolved;
  }

  private async requireInitializedStore(explorationId: number): Promise<IArtexGraphStore> {
    const store = this.graphStoreProvider.open(this.workspaceRoot, explorationId);
    if (!(await store.isInitialized())) {
      throw new Error(`ARTEX exploration ${String(explorationId)} is not initialized`);
    }
    return store;
  }

  private async openWorkStore(): Promise<IArtexWorkStore> {
    const store = this.workStoreProvider.open(this.workspaceRoot);
    await store.ensureSeeded();
    return store;
  }

  private trafficStore() {
    return this.trafficStoreProvider.open(this.workspaceRoot);
  }

  private tryEnterMode(callerAgentId: string, explorationId: number): void {
    const handle = this.agentLifecycle?.handleOf(callerAgentId);
    if (handle === undefined) return;
    try {
      const modeService = handle.accessor.get(IArtexModeService);
      modeService?.enter(explorationId);
    } catch {
    }
  }

  private async emitExplorationUpdatedIfInitialized(
    explorationId: number,
    reason: string,
  ): Promise<void> {
    const store = this.graphStoreProvider.open(this.workspaceRoot, explorationId);
    if (await store.isInitialized()) {
      await this.emitExplorationUpdated(explorationId, reason, store);
    } else {
      this.sessionBus.publish(
        new ArtexSessionExplorationUpdated({
          explorationId,
          reason,
          orchestrator: this.orchestrator.getStatus(explorationId),
        }),
      );
    }
  }

  private async emitExplorationUpdated(
    explorationId: number,
    reason: string,
    store: IArtexGraphStore,
    orchestratorStatus?: ArtexOrchestratorStatus,
  ): Promise<void> {
    const exploration = await store.exploration();
    this.sessionBus.publish(
      new ArtexSessionExplorationUpdated({
        explorationId,
        reason,
        exploration,
        orchestrator: orchestratorStatus ?? this.orchestrator.getStatus(explorationId),
      }),
    );
  }
}
