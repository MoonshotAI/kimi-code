import { randomUUID } from 'node:crypto';

import type { PromptOrigin } from '@moonshot-ai/agent-core-v2';

import { isSurveyTurnOrigin, type SurveyTurnRecovery } from './survey-turns';

import type { RatingCooldownStore } from './cooldown-store';
import {
  buildSurveyEventProperties,
  SURVEY_EVENT_NAMES,
  type SurveyEventEnvironmentFields,
} from './event-properties';
import {
  evaluateSurveyGate,
  type LongContextArmGateInput,
  type SessionArmGateInput,
} from '../common/gates';
import { kfcModelIdOf, type RatingModelRoute } from './kfc';
import { SessionRatingLedger, type RatingTracker } from './ledger';
import type { RatingOffer, SurveyAppearance, SurveyKind } from '../common/types';
import {
  resolveSurveyPopupConfig,
  type SurveyPopupConfig,
  type SurveyPopupPayload,
} from '../common/survey-popup-config';

const SESSION_RATING_IDLE_MS = 2000;
const SESSION_INIT_PARENT_TOOL_CALL_ID = 'generate-agents-md';
const TOWER_WORKER_PROFILE_NAME = 'tower-worker';

export type SessionFact =
  | { readonly kind: 'turn-started'; readonly origin: PromptOrigin | undefined }
  | { readonly kind: 'turn-ended'; readonly requestId?: string }
  | { readonly kind: 'tool-call-started'; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: 'tool-call-ended'; readonly toolCallId: string }
  | {
      readonly kind: 'subagent-spawned';
      readonly parentToolCallId?: string;
      readonly swarmIndex?: number;
      readonly model?: string;
    }
  | { readonly kind: 'compaction-completed' };

export interface ResumedAgentSeed {
  readonly type: string;
  readonly profileName?: string;
  readonly swarmItem?: string;
  readonly sessionInit?: string;
}

export interface RatingEnvironment {
  readonly sessionId: string;
  readonly currentModel: string;
  readonly model: RatingModelRoute;
  readonly cumulativeTokens: number;
  readonly contextTokens: number;
  readonly permissionMode: string;
  readonly thinkingEffort: string;
  readonly busy: boolean;
  readonly telemetryDisabled: boolean;
  readonly ratingDisabled: boolean;
  readonly historyUserTurnCount?: number;
  readonly resumedAgents?: Readonly<Record<string, ResumedAgentSeed>>;
}

export interface RatingConfigFeed {
  readyForEvaluation(): boolean;
  payload(): SurveyPopupPayload;
}

export interface SessionRatingDeps {
  readonly environment: () => RatingEnvironment;
  readonly config: RatingConfigFeed;
  readonly cooldown: RatingCooldownStore;
  readonly ledger: SessionRatingLedger;
  readonly track: RatingTracker;
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly random?: () => number;
  readonly appearanceId?: () => string;
}

export interface SessionRatingMount {
  observe(fact: SessionFact): void;
  recover(recovery: SurveyTurnRecovery): void;
  evaluate(): RatingOffer | undefined;
  end(): void;
}

export function mountSessionRating(deps: SessionRatingDeps): SessionRatingMount {
  return new SessionRatingMountImpl(deps);
}

function recordModel(models: Set<string>, model: string | undefined): void {
  if (model === undefined || model.length === 0) return;
  models.add(model);
}

function joinModels(models: ReadonlySet<string>): string | undefined {
  if (models.size === 0) return undefined;
  return [...models].toSorted().join(',');
}

function resumedSubagentCount(
  agents: Readonly<Record<string, ResumedAgentSeed>> | undefined,
): number {
  if (agents === undefined) return 0;
  return Object.values(agents).filter(
    (agent) =>
      agent.type === 'sub' &&
      agent.swarmItem === undefined &&
      agent.sessionInit === undefined &&
      agent.profileName !== TOWER_WORKER_PROFILE_NAME,
  ).length;
}

class SessionRatingMountImpl implements SessionRatingMount {
  private readonly mountId = Symbol();
  private ended = false;
  private mountedAt: number;
  private currentTurnUserOrigin: boolean | undefined;
  private turnInProgress = false;
  private evaluationPending = false;
  private pendingRequestId: string | undefined;
  private idleSince: number | undefined;
  private userTurnsSinceMount = 0;
  private recoveredUserTurns = 0;
  private lastShownAt: number | undefined;
  private userTurnsAtLastShown: number | undefined;
  private appearanceCount = 0;
  private globalLastShownAt: number | undefined;
  private readonly longContextRollConsumedModels = new Set<string | undefined>();
  private longContextShownThisMount = false;
  private stickySample: { readonly turnCount: number; readonly value: number } | undefined;
  private toolCallCount = 0;
  private compactionCount = 0;
  private subagentsSpawned = 0;
  private readonly subagentModels = new Set<string>();
  private swarmRunCount = 0;
  private readonly swarmModels = new Set<string>();
  private readonly toolCallFamilies = new Map<string, string>();

  constructor(private readonly deps: SessionRatingDeps) {
    this.mountedAt = this.now();
  }

  observe(fact: SessionFact): void {
    if (this.ended) return;
    switch (fact.kind) {
      case 'turn-started':
        this.turnStarted(isSurveyTurnOrigin(fact.origin) === true);
        return;
      case 'turn-ended':
        this.turnEnded(fact.requestId);
        return;
      case 'tool-call-started':
        this.toolCallCount += 1;
        this.toolCallFamilies.set(fact.toolCallId, fact.toolName);
        if (fact.toolName === 'AgentSwarm') this.swarmRunCount += 1;
        return;
      case 'tool-call-ended':
        this.toolCallFamilies.delete(fact.toolCallId);
        return;
      case 'subagent-spawned':
        this.subagentSpawned(fact);
        return;
      case 'compaction-completed':
        this.compactionCount += 1;
    }
  }

  recover(recovery: SurveyTurnRecovery): void {
    if (this.ended || this.turnInProgress || this.evaluationPending || this.userTurnsSinceMount > 0) return;
    this.recoveredUserTurns = recovery.userTurnCount;
    this.userTurnsSinceMount = recovery.userTurnCount;
    if (recovery.firstPromptAt !== undefined) {
      this.mountedAt = this.now() - Math.max(0, this.wallNow() - recovery.firstPromptAt);
    }
    if (isSurveyTurnOrigin(recovery.origin) !== true) return;
    this.evaluationPending = true;
    this.pendingRequestId = recovery.requestId;
    this.idleSince = recovery.endedAt === undefined
      ? this.now()
      : this.now() - Math.max(0, this.wallNow() - recovery.endedAt);
  }

  evaluate(): RatingOffer | undefined {
    if (this.ended || !this.evaluationPending || this.turnInProgress) return undefined;
    this.evaluationPending = false;
    try {
      if (!this.deps.config.readyForEvaluation()) return undefined;
      const persisted = this.deps.cooldown.read();
      if (persisted !== undefined) {
        this.globalLastShownAt = Math.max(persisted, this.globalLastShownAt ?? 0);
      }
      const environment = this.deps.environment();
      const kfcModelId = kfcModelIdOf(environment.model);
      const config = resolveSurveyPopupConfig(this.deps.config.payload(), kfcModelId);
      const verdict = evaluateSurveyGate({ ...this.gateInputs(environment, kfcModelId), config });
      if (verdict.longContextRollConsumed === true) {
        this.longContextRollConsumedModels.add(kfcModelId);
      }
      return verdict.show ? this.open(verdict.survey, config, environment, kfcModelId) : undefined;
    } catch {
      return undefined;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.deps.ledger.detach(this.mountId);
  }

  private turnStarted(userOrigin: boolean): void {
    if (this.slotElapsed()) this.evaluationPending = false;
    this.currentTurnUserOrigin = userOrigin;
    this.turnInProgress = true;
    this.idleSince = undefined;
    if (!userOrigin) return;
    this.userTurnsSinceMount += 1;
    this.evaluationPending = false;
    this.pendingRequestId = undefined;
  }

  private turnEnded(requestId: string | undefined): void {
    if (this.currentTurnUserOrigin === true) {
      this.evaluationPending = true;
      this.pendingRequestId = requestId;
    }
    this.currentTurnUserOrigin = undefined;
    this.turnInProgress = false;
    if (this.evaluationPending) this.idleSince = this.now();
  }

  private subagentSpawned(fact: Extract<SessionFact, { kind: 'subagent-spawned' }>): void {
    if (fact.parentToolCallId === SESSION_INIT_PARENT_TOOL_CALL_ID) return;
    const toolName =
      fact.parentToolCallId === undefined
        ? undefined
        : this.toolCallFamilies.get(fact.parentToolCallId);
    if (toolName === 'Agent') {
      this.subagentsSpawned += 1;
      recordModel(this.subagentModels, fact.model);
      return;
    }
    if (toolName === 'AgentSwarm') {
      recordModel(this.swarmModels, fact.model);
      return;
    }
    if (toolName !== undefined) return;
    if (fact.swarmIndex !== undefined) {
      recordModel(this.swarmModels, fact.model);
      return;
    }
    this.subagentsSpawned += 1;
    recordModel(this.subagentModels, fact.model);
  }

  private slotElapsed(): boolean {
    return (
      this.evaluationPending &&
      this.idleSince !== undefined &&
      this.now() - this.idleSince >= SESSION_RATING_IDLE_MS
    );
  }

  private gateInputs(
    environment: RatingEnvironment,
    kfcModelId: string | undefined,
  ): { session: SessionArmGateInput; longContext: LongContextArmGateInput } {
    const now = this.now();
    const shared = {
      turnInProgress: this.turnInProgress || environment.busy,
      feedbackSurveyDisabled: environment.ratingDisabled,
      telemetryDisabled: environment.telemetryDisabled,
      kfcModelId,
    };
    const msSinceGlobalLastShown =
      this.globalLastShownAt === undefined ? undefined : this.wallNow() - this.globalLastShownAt;
    return {
      session: {
        ...shared,
        mountedForMs: now - this.mountedAt,
        userTurnsSinceMount: this.userTurnsSinceMount,
        msSinceLastShown: this.lastShownAt === undefined ? undefined : now - this.lastShownAt,
        userTurnsSinceLastShown:
          this.userTurnsAtLastShown === undefined
            ? undefined
            : this.userTurnsSinceMount - this.userTurnsAtLastShown,
        sample: this.currentSample(),
        msSinceGlobalLastShown,
      },
      longContext: {
        ...shared,
        cumulativeTokens: environment.cumulativeTokens,
        virtualContextTokens: environment.contextTokens,
        mountRollConsumed: this.longContextRollConsumedModels.has(kfcModelId),
        mountSurveyShown: this.longContextShownThisMount,
        msSinceGlobalLastShown,
        drawMountRoll: () => this.random(),
      },
    };
  }

  private currentSample(): number {
    if (this.stickySample?.turnCount !== this.userTurnsSinceMount) {
      this.stickySample = { turnCount: this.userTurnsSinceMount, value: this.random() };
    }
    return this.stickySample.value;
  }

  private open(
    survey: SurveyKind,
    config: SurveyPopupConfig,
    environment: RatingEnvironment,
    kfcModelId: string | undefined,
  ): RatingOffer {
    this.appearanceCount += 1;
    const appearance: SurveyAppearance = {
      survey,
      appearanceId: (this.deps.appearanceId ?? randomUUID)(),
      appearanceIndex: this.appearanceCount,
    };
    this.deps.ledger.register({
      mount: this.mountId,
      event: SURVEY_EVENT_NAMES[survey],
      properties: buildSurveyEventProperties(
        {
          event_type: 'appeared',
          appearance_id: appearance.appearanceId,
          appearance_index: appearance.appearanceIndex,
        },
        this.environmentFields(environment, kfcModelId),
        config,
      ),
      context: { sessionId: environment.sessionId },
      track: this.deps.track,
    });
    this.pendingRequestId = undefined;
    this.lastShownAt = this.now();
    this.userTurnsAtLastShown = this.userTurnsSinceMount;
    if (survey === 'long_context') this.longContextShownThisMount = true;
    const wallTime = this.wallNow();
    this.globalLastShownAt = wallTime;
    try {
      this.deps.cooldown.write(wallTime);
    } catch {}
    return { appearanceId: appearance.appearanceId, survey };
  }

  private environmentFields(
    environment: RatingEnvironment,
    kfcModelId: string | undefined,
  ): SurveyEventEnvironmentFields {
    return {
      current_model: environment.currentModel,
      kfc_model_id: kfcModelId,
      kfc_trace_id: kfcModelId === undefined ? undefined : this.pendingRequestId,
      user_turn_count:
        environment.historyUserTurnCount === undefined
          ? undefined
          : environment.historyUserTurnCount + this.userTurnsSinceMount - this.recoveredUserTurns,
      cumulative_tokens: environment.cumulativeTokens,
      virtual_context_tokens: environment.contextTokens,
      tool_call_count: this.toolCallCount,
      compaction_count: this.compactionCount,
      permission_mode: environment.permissionMode,
      thinking_effort: environment.thinkingEffort,
      subagent_count: resumedSubagentCount(environment.resumedAgents) + this.subagentsSpawned,
      subagent_models: joinModels(this.subagentModels),
      swarm_run_count: this.swarmRunCount,
      swarm_models: joinModels(this.swarmModels),
    };
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }

  private wallNow(): number {
    return (this.deps.wallNow ?? Date.now)();
  }

  private random(): number {
    return (this.deps.random ?? Math.random)();
  }
}
