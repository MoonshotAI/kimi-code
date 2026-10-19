import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ISessionActivityView } from './sessionActivity';
import { ISessionLockReleaseService } from './sessionLockRelease';

const SESSION_LOCK_RELEASE_DELAY_MS = 3000;

export class SessionLockReleaseService extends Disposable implements ISessionLockReleaseService {
  declare readonly _serviceBrand: undefined;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private releasing = false;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionActivityView private readonly activity: ISessionActivityView,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
  ) {
    super();
    this._register(this.activity.onDidChange(() => this.schedule()));
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
    this.schedule();
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.activity.state().busy) return;
    if (!this.sessionLocks.held(this.ctx.sessionId)) return;
    this.timer = setTimeout(() => {
      void this.releaseWhenIdle();
    }, SESSION_LOCK_RELEASE_DELAY_MS);
  }

  private async releaseWhenIdle(): Promise<void> {
    if (this.releasing) return;
    this.releasing = true;
    try {
      if (this.activity.state().busy) return;
      await this.appendLogStore.flush().catch(() => undefined);
      if (this.activity.state().busy) return;
      this.sessionLocks.release(this.ctx.sessionId);
    } finally {
      this.releasing = false;
      if (!this.activity.state().busy && this.sessionLocks.held(this.ctx.sessionId)) {
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
  ISessionLockReleaseService,
  SessionLockReleaseService,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
