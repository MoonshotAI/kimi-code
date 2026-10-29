import { join } from 'node:path';

import {
  agentContextOf,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  IModelCatalog,
  IOAuthService,
  IOAuthToolkit,
  ISessionManager,
  ISessionMetadata,
  ISessionTokenCountingService,
  ISessionUsageService,
  ITelemetryService,
  MAIN_AGENT_ID,
  CompactionCompleted,
  SubagentSpawned,
  type AgentMeta,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import {
  ToolCallStarted,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';

import { ClientConfigClient } from '#/client-configs/node/client-configs';
import {
  mountSessionRating,
  type RatingConfigFeed,
  type RatingEnvironment,
  type ResumedAgentSeed,
  type SessionRatingMount,
} from '#/session-rating/node/engine';
import type { SurveyEventName, SurveyEventProperties } from '#/session-rating/node/event-properties';
import { isSurveyTurnOrigin, mountSurveyTurnCounter, type MountedSurveyTurnCounter } from '#/session-rating/node/survey-turns';
import { SessionRatingLedger } from '#/session-rating/node/ledger';
import type { RatingOffer, RatingReport } from '#/session-rating/common/types';
import { ratingCooldownFile, type RatingCooldownStore } from '#/session-rating/node/cooldown-store';
import {
  cloudSurveyPopupConfigFeed,
  SurveyPopupConfigFeed,
} from '#/session-rating/node/survey-popup-config-feed';
import {
  DEFAULT_SURVEY_POPUP_PAYLOAD,
  type SurveyPopupPayload,
} from '#/session-rating/common/survey-popup-config';

export const SESSION_RATING_PREVIEW_ENV = 'KIMI_CODE_SESSION_RATING_PREVIEW';

const CLIENT_CONFIG_CACHE_DIR = join('cache', 'client-configs');

const PREVIEW_SURVEY_POPUP_PAYLOAD: SurveyPopupPayload = {
  ...DEFAULT_SURVEY_POPUP_PAYLOAD,
  probability: 1,
  min_time_before_feedback_ms: 0,
  min_user_turns_before_feedback: 0,
  min_time_between_feedback_ms: 0,
  min_user_turns_between_feedback: 0,
  min_time_between_global_feedback_ms: 0,
};

function memoryCooldownStore(): RatingCooldownStore {
  let lastShownTime: number | undefined;
  return {
    read: () => lastShownTime,
    write: (value) => {
      lastShownTime = value;
    },
  };
}

class LazyConfigFeed implements RatingConfigFeed {
  private feed: SurveyPopupConfigFeed | undefined;

  constructor(private readonly create: () => SurveyPopupConfigFeed) {}

  readyForEvaluation(): boolean {
    return this.current().readyForEvaluation();
  }

  payload(): SurveyPopupPayload {
    return this.current().payload();
  }

  private current(): SurveyPopupConfigFeed {
    this.feed ??= this.create();
    return this.feed;
  }
}

export interface SessionRatingHostOptions {
  readonly telemetryDisabled: () => boolean;
  readonly preview?: boolean;
  readonly log?: (message: string, properties: Readonly<Record<string, unknown>>) => void;
}

interface MountedSession {
  readonly mount: SessionRatingMount;
  readonly disposables: IDisposable[];
  readonly ready: () => Promise<void>;
  recover: boolean;
}

export class SessionRatingHost implements IDisposable {
  private readonly sessions = new Map<string, MountedSession>();
  private readonly subscriptions: IDisposable[] = [];
  private readonly preview: boolean;
  private readonly config: RatingConfigFeed;
  private readonly cooldown: RatingCooldownStore;
  private readonly settings: IConfigService;
  private readonly ledger: SessionRatingLedger;

  constructor(
    core: Scope,
    private readonly options: SessionRatingHostOptions,
  ) {
    const bootstrap = core.accessor.get(IBootstrapService);
    this.settings = core.accessor.get(IConfigService);
    this.ledger = new SessionRatingLedger({ telemetryDisabled: options.telemetryDisabled });
    this.preview = options.preview === true;
    if (this.preview) {
      this.config = new SurveyPopupConfigFeed({
        peek: () => PREVIEW_SURVEY_POPUP_PAYLOAD,
        isFresh: () => true,
        region: () => '',
      });
      this.cooldown = memoryCooldownStore();
    } else {
      const auth = core.accessor.get(IOAuthService);
      const oauth = core.accessor.get(IOAuthToolkit);
      const client = new ClientConfigClient({
        region: () => auth.getRegion(),
        baseUrlOverride: () => bootstrap.getEnv('KIMI_CODE_BASE_URL'),
        cacheDir: () => join(bootstrap.homeDir, CLIENT_CONFIG_CACHE_DIR),
      });
      this.config = new LazyConfigFeed(() =>
        cloudSurveyPopupConfigFeed(client, async () => {
          await auth.getRegionAsync();
          return oauth.getCachedAccessToken();
        }),
      );
      this.cooldown = ratingCooldownFile(bootstrap.homeDir);
    }
    const manager = core.accessor.get(ISessionManager);
    const creating = manager.onWillCreateSession?.((event) => {
      event.onDidCreateScope((handle) => {
        this.mountSession(event.sessionId, handle);
      });
      event.onSessionDispose(() => {
        this.unmountSession(event.sessionId);
      });
    });
    const created = manager.onDidCreateSession?.((event) => {
      this.mountSession(event.sessionId, event.handle);
      const session = this.sessions.get(event.sessionId);
      if (session !== undefined) session.recover = event.source === 'reclaimed';
    });
    const closing = manager.onWillCloseSession?.((event) => {
      this.unmountSession(event.sessionId);
    });
    if (creating !== undefined) this.subscriptions.push(creating);
    if (created !== undefined) this.subscriptions.push(created);
    if (closing !== undefined) this.subscriptions.push(closing);
    for (const handle of manager.list()) this.mountSession(handle.id, handle);
  }

  async whenReady(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.ready();
  }

  evaluate(sessionId: string): RatingOffer | undefined {
    return this.sessions.get(sessionId)?.mount.evaluate();
  }

  report(sessionId: string, report: RatingReport): void {
    this.ledger.report(sessionId, report);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const session of this.sessions.values()) {
      session.mount.end();
      for (const disposable of session.disposables) disposable.dispose();
    }
    this.sessions.clear();
    this.ledger.clear();
  }

  private mountSession(sessionId: string, handle: ISessionScopeHandle): void {
    if (this.sessions.has(sessionId)) return;
    const telemetry = handle.accessor.get(ITelemetryService).withContext({});
    const agents = handle.accessor.get(IAgentLifecycleService);
    let mainAgent: IAgentScopeHandle | undefined;
    let surveyTurns: MountedSurveyTurnCounter | undefined;
    let mainAgentEvents: IDisposable | undefined;
    let userTurnsObserved = 0;
    let resumedAgents: Readonly<Record<string, ResumedAgentSeed>> | undefined;
    let historyReady: Promise<void> = Promise.resolve();
    const metadataReady = handle.accessor
      .get(ISessionMetadata)
      .read()
      .then((meta) => {
        resumedAgents = resumedAgentSeeds(meta.agents ?? {});
      })
      .catch(() => undefined);
    const mount = mountSessionRating({
      environment: () => ({
        ...readEnvironment(sessionId, mainAgent, userTurnsObserved, surveyTurns?.count),
        telemetryDisabled: this.options.telemetryDisabled(),
        ratingDisabled: this.settings.get('disableFeedbackSurvey') === true,
        resumedAgents,
      }),
      config: this.config,
      cooldown: this.cooldown,
      ledger: this.ledger,
      track: (event, properties) => {
        this.track(telemetry, event, properties);
      },
    });
    const attach = (agent: IAgentScopeHandle): void => {
      mainAgentEvents?.dispose();
      mainAgent = agent;
      const counter = mountSurveyTurnCounter(agent.accessor.get(IEventDispatcher));
      surveyTurns = counter;
      historyReady = counter.whenAttached;
      void historyReady.catch((error: unknown) => {
        this.options.log?.('session rating history unavailable', { error: String(error) });
      });
      const bus = agent.accessor.get(IEventBus);
      const subscriptions = [
        counter,
        bus.subscribe(TurnStarted, (event) => {
          if (isSurveyTurnOrigin(event.origin) === true) userTurnsObserved += 1;
          mount.observe({ kind: 'turn-started', origin: event.origin });
        }),
        bus.subscribe(TurnEnded, (event) => {
          mount.observe({ kind: 'turn-ended', requestId: event.requestId });
        }),
        bus.subscribe(ToolCallStarted, (event) => {
          mount.observe({
            kind: 'tool-call-started',
            toolCallId: event.toolCallId,
            toolName: event.name,
          });
        }),
        bus.subscribe(ToolResultEvent, (event) => {
          mount.observe({ kind: 'tool-call-ended', toolCallId: event.toolCallId });
        }),
        bus.subscribe(SubagentSpawned, (event) => {
          mount.observe({
            kind: 'subagent-spawned',
            parentToolCallId: event.parentToolCallId === '' ? undefined : event.parentToolCallId,
            swarmIndex: event.swarmIndex,
            model: event.model,
          });
        }),
        bus.subscribe(CompactionCompleted, () => {
          mount.observe({ kind: 'compaction-completed' });
        }),
      ];
      mainAgentEvents = {
        dispose: () => {
          for (const subscription of subscriptions) subscription.dispose();
        },
      };
    };
    const existing = agents.handleOf(MAIN_AGENT_ID);
    if (existing !== undefined) attach(existing);
    const disposables: IDisposable[] = [
      agents.onDidCreateScope(({ context, handle: agent }) => {
        if (context.agentId === MAIN_AGENT_ID) attach(agent);
      }),
      agents.onDidClose((context) => {
        if (context.agentId !== MAIN_AGENT_ID) return;
        mainAgentEvents?.dispose();
        mainAgentEvents = undefined;
        mainAgent = undefined;
        surveyTurns = undefined;
      }),
      { dispose: () => mainAgentEvents?.dispose() },
    ];
    const ready = async () => {
      await Promise.all([metadataReady, historyReady]).catch(() => undefined);
      if (this.sessions.get(sessionId)?.recover !== true) return;
      const recovery = surveyTurns?.recovery();
      if (recovery !== undefined) mount.recover(recovery);
    };
    this.sessions.set(sessionId, { mount, disposables, ready, recover: false });
  }

  private unmountSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    session.mount.end();
    for (const disposable of session.disposables) disposable.dispose();
  }

  private track(
    telemetry: ITelemetryService,
    event: SurveyEventName,
    properties: SurveyEventProperties,
  ): void {
    if (this.preview) {
      this.options.log?.('session rating preview event', { event, ...properties });
      return;
    }
    telemetry.track(event, { ...properties });
  }
}

function resumedAgentSeeds(
  agents: Readonly<Record<string, AgentMeta>>,
): Record<string, ResumedAgentSeed> {
  const seeds: Record<string, ResumedAgentSeed> = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    seeds[agentId] = {
      type: agent.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
      profileName: agent.labels?.['profileName'],
      swarmItem: agent.labels?.['swarmItem'] ?? agent.swarmItem,
      sessionInit: agent.labels?.['sessionInit'],
    };
  }
  return seeds;
}

function modelRouteOf(agent: IAgentScopeHandle, alias: string): RatingEnvironment['model'] {
  try {
    const model = agent.accessor.get(IModelCatalog).get(alias);
    return { modelId: model.name, baseUrl: model.baseUrl };
  } catch {
    return { modelId: undefined, baseUrl: undefined };
  }
}

function readEnvironment(
  sessionId: string,
  agent: IAgentScopeHandle | undefined,
  userTurnsObserved: number,
  sessionUserTurns: number | undefined,
): Omit<RatingEnvironment, 'telemetryDisabled' | 'ratingDisabled'> {
  if (agent === undefined) {
    return {
      sessionId,
      currentModel: '',
      model: { modelId: undefined, baseUrl: undefined },
      cumulativeTokens: 0,
      contextTokens: 0,
      permissionMode: '',
      thinkingEffort: '',
      busy: false,
    };
  }
  const context = agentContextOf(agent);
  const profile = agent.accessor.get(IAgentProfileService);
  const alias = profile.getModel();
  const total = agent.accessor.get(ISessionUsageService).status(context).total;
  return {
    sessionId,
    currentModel: alias,
    model: modelRouteOf(agent, alias),
    cumulativeTokens:
      total === undefined
        ? 0
        : total.inputOther + total.output + total.inputCacheRead + total.inputCacheCreation,
    contextTokens: agent.accessor.get(ISessionTokenCountingService).statusSize(context),
    permissionMode: agent.accessor.get(IAgentPermissionModeService).mode,
    thinkingEffort: profile.getEffectiveThinkingLevel(),
    busy:
      agent.accessor.get(IAgentLoopService).snapshot().state === 'running' ||
      agent.accessor.get(IAgentFullCompactionService).compacting !== null,
    historyUserTurnCount:
      sessionUserTurns === undefined ? undefined : sessionUserTurns - userTurnsObserved,
  };
}
