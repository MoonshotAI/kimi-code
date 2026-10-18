import {
  agentContextOf,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IBootstrapService,
  IEventBus,
  ISessionManager,
  ISessionTokenCountingService,
  ISessionUsageService,
  ITelemetryService,
  MAIN_AGENT_ID,
  type FeedbackSurveyEvent,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';

import {
  CLOSED_RATING_VIEW,
  mountSessionRating,
  type RatingAction,
  type RatingEnvironment,
  type RatingView,
  type SessionRatingMount,
} from '#/sessionRating/engine';
import type { SurveyEventName } from '#/sessionRating/eventProperties';

export const SESSION_RATING_PREVIEW_ENV = 'KIMI_CODE_SESSION_RATING_PREVIEW';

const ENABLED_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

export interface SessionRatingHostOptions {
  readonly log?: (message: string, properties: Readonly<Record<string, unknown>>) => void;
}

interface MountedSession {
  readonly mount: SessionRatingMount;
  readonly disposables: IDisposable[];
}

export class SessionRatingHost implements IDisposable {
  private readonly sessions = new Map<string, MountedSession>();
  private readonly subscriptions: IDisposable[] = [];
  private readonly preview: boolean;

  constructor(
    core: Scope,
    private readonly options: SessionRatingHostOptions = {},
  ) {
    const previewEnv = core.accessor.get(IBootstrapService).getEnv(SESSION_RATING_PREVIEW_ENV);
    this.preview = previewEnv !== undefined && ENABLED_ENV_VALUES.has(previewEnv.trim().toLowerCase());
    const manager = core.accessor.get(ISessionManager);
    const created = manager.onDidCreateSession?.((event) => {
      this.mountSession(event.sessionId, event.handle);
    });
    const closing = manager.onWillCloseSession?.((event) => {
      this.unmountSession(event.sessionId);
    });
    if (created !== undefined) this.subscriptions.push(created);
    if (closing !== undefined) this.subscriptions.push(closing);
    for (const handle of manager.list()) this.mountSession(handle.id, handle);
  }

  view(sessionId: string): RatingView {
    return this.sessions.get(sessionId)?.mount.view() ?? CLOSED_RATING_VIEW;
  }

  async evaluate(sessionId: string): Promise<RatingView> {
    return (await this.sessions.get(sessionId)?.mount.evaluate()) ?? CLOSED_RATING_VIEW;
  }

  act(sessionId: string, action: RatingAction): RatingView {
    return this.sessions.get(sessionId)?.mount.act(action) ?? CLOSED_RATING_VIEW;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const session of this.sessions.values()) {
      session.mount.end('exit');
      for (const disposable of session.disposables) disposable.dispose();
    }
    this.sessions.clear();
  }

  private mountSession(sessionId: string, handle: ISessionScopeHandle): void {
    if (this.sessions.has(sessionId)) return;
    const telemetry = handle.accessor.get(ITelemetryService);
    const agents = handle.accessor.get(IAgentLifecycleService);
    let mainAgent: IAgentScopeHandle | undefined;
    let mainAgentEvents: IDisposable | undefined;
    const mount = mountSessionRating(
      {},
      {
        environment: () => readEnvironment(mainAgent),
        track: (event, properties) => {
          this.track(telemetry, event, properties);
        },
        preview: this.preview,
      },
    );
    const attach = (agent: IAgentScopeHandle): void => {
      mainAgentEvents?.dispose();
      mainAgent = agent;
      const bus = agent.accessor.get(IEventBus);
      const started = bus.subscribe(TurnStarted, (event) => {
        mount.observe({ kind: 'turn-started', origin: event.origin });
      });
      const ended = bus.subscribe(TurnEnded, (event) => {
        mount.observe({ kind: 'turn-ended', traceId: event.traceId });
      });
      mainAgentEvents = {
        dispose: () => {
          started.dispose();
          ended.dispose();
        },
      };
    };
    const existing = agents.handleOf(MAIN_AGENT_ID);
    if (existing !== undefined) attach(existing);
    const disposables: IDisposable[] = [
      agents.onDidCreate((context) => {
        if (context.agentId !== MAIN_AGENT_ID) return;
        const agent = agents.handleOf(MAIN_AGENT_ID);
        if (agent !== undefined) attach(agent);
      }),
      agents.onDidClose((context) => {
        if (context.agentId !== MAIN_AGENT_ID) return;
        mainAgentEvents?.dispose();
        mainAgentEvents = undefined;
        mainAgent = undefined;
      }),
      { dispose: () => mainAgentEvents?.dispose() },
    ];
    this.sessions.set(sessionId, { mount, disposables });
  }

  private unmountSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    session.mount.end('unmount');
    for (const disposable of session.disposables) disposable.dispose();
  }

  private track(
    telemetry: ITelemetryService,
    event: SurveyEventName,
    properties: FeedbackSurveyEvent,
  ): void {
    if (this.preview) {
      this.options.log?.('session rating preview event', { event, ...properties });
      return;
    }
    telemetry.track2(event, properties);
  }
}

function readEnvironment(agent: IAgentScopeHandle | undefined): RatingEnvironment {
  if (agent === undefined) {
    return {
      currentModel: '',
      cumulativeTokens: 0,
      contextTokens: 0,
      permissionMode: '',
      thinkingEffort: '',
    };
  }
  const context = agentContextOf(agent);
  const profile = agent.accessor.get(IAgentProfileService);
  const total = agent.accessor.get(ISessionUsageService).status(context).total;
  return {
    currentModel: profile.getModel(),
    cumulativeTokens:
      total === undefined
        ? 0
        : total.inputOther + total.output + total.inputCacheRead + total.inputCacheCreation,
    contextTokens: agent.accessor.get(ISessionTokenCountingService).statusSize(context),
    permissionMode: agent.accessor.get(IAgentPermissionModeService).mode,
    thinkingEffort: profile.getEffectiveThinkingLevel(),
  };
}
