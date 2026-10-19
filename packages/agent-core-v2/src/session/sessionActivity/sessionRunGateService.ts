import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';
import { LifecycleScope } from '#/app/scopes';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { SessionErrors } from '#/session/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

import { ISessionActivityView } from './sessionActivity';
import { ISessionRunGate } from './sessionRunGate';

const SESSION_LOCK_RELEASE_DELAY_MS = 3000;

export class SessionRunGateService extends Disposable implements ISessionRunGate {
  declare readonly _serviceBrand: undefined;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private releasing = false;
  private activityView: ISessionActivityView | undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this._register(
      this.sessionLocks.onDidHold((event) => {
        if (event.sessionId === this.ctx.sessionId) this.schedule();
      }),
    );
    this._register(
      toDisposable(() => {
        this.cancelTimer();
        this.sessionLocks.release(this.ctx.sessionId);
      }),
    );
  }

  begin(): void {
    const sessionId = this.ctx.sessionId;
    this.sessionLocks.hold(sessionId);
    const agents = this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentLifecycleService),
    );
    const stale = agents
      .list()
      .some((agent) =>
        this.appendLogStore.externallyModified(
          this.ctx.scope(`agents/${agent.agentId}`),
          AGENT_WIRE_RECORD_KEY,
        ),
      );
    if (!stale) return;
    this.sessionLocks.release(sessionId);
    throw new Error2(
      SessionErrors.codes.SESSION_STALE,
      `Session "${sessionId}" was updated by another client; reload it before continuing`,
      { details: { sessionId } },
    );
  }

  tryHold(): boolean {
    return this.sessionLocks.tryHold(this.ctx.sessionId);
  }

  private activity(): ISessionActivityView {
    if (this.activityView !== undefined) return this.activityView;
    this.activityView = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionActivityView),
    );
    this._register(this.activityView.onDidChange(() => this.schedule()));
    return this.activityView;
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.activity().state().busy) return;
    if (!this.sessionLocks.held(this.ctx.sessionId)) return;
    this.timer = setTimeout(() => {
      void this.releaseWhenIdle();
    }, SESSION_LOCK_RELEASE_DELAY_MS);
  }

  private async releaseWhenIdle(): Promise<void> {
    if (this.releasing) return;
    this.releasing = true;
    try {
      if (this.activity().state().busy) return;
      await this.appendLogStore.flush().catch(() => undefined);
      if (this.activity().state().busy) return;
      this.sessionLocks.release(this.ctx.sessionId);
    } finally {
      this.releasing = false;
      if (!this.activity().state().busy && this.sessionLocks.held(this.ctx.sessionId)) {
        this.schedule();
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionRunGate,
  SessionRunGateService,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
