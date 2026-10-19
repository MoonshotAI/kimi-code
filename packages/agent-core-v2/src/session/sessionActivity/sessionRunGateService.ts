import { Disposable } from '#/_base/di/lifecycle';
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

import { ISessionRunGate } from './sessionRunGate';

export class SessionRunGateService extends Disposable implements ISessionRunGate {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
  }

  begin(): void {
    const sessionId = this.ctx.sessionId;
    this.sessionLocks.beginRun(sessionId);
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
    this.sessionLocks.endRun(sessionId);
    throw new Error2(
      SessionErrors.codes.SESSION_STALE,
      `Session "${sessionId}" was updated by another client; reload it before continuing`,
      { details: { sessionId } },
    );
  }

  tryHold(): boolean {
    try {
      this.sessionLocks.beginRun(this.ctx.sessionId);
      return true;
    } catch {
      return false;
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionRunGate,
  SessionRunGateService,
  ScopeActivation.OnDemand,
  'sessionActivity',
);
