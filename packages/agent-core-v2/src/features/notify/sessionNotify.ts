import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { notifyUserAvailable } from './notifyUserAvailability';

export interface ISessionNotify {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly enabled: boolean;
}

export const ISessionNotify = createDecorator<ISessionNotify>('sessionNotify');

export class SessionNotify implements ISessionNotify {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  enabled = false;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @IAppendLogStore private readonly journal: IAppendLogStore,
    @IFlagService flags: IFlagService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    this.ready = this.load(notifyUserAvailable(flags, bootstrap));
  }

  private async load(initial: boolean): Promise<void> {
    const scope = this.context.scope('notify');
    const stored = await this.store.get<{ enabled: boolean }>(scope, 'state.json');
    if (stored !== undefined && typeof stored.enabled === 'boolean') {
      this.enabled = stored.enabled;
      return;
    }
    let enabled = initial;
    for await (const record of this.journal.read<WireRecord>(
      this.context.scope('agents/main'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      if (record.type !== 'profile.bind' || typeof record['systemPrompt'] !== 'string') continue;
      enabled =
        record['systemPrompt'].includes('When `NotifyUser` is available, use it proactively') ||
        record['systemPrompt'].includes(
          'The `NotifyUser` tool is your channel to the user while you work',
        );
      break;
    }
    await this.store.set(scope, 'state.json', { enabled });
    this.enabled = enabled;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionNotify,
  SessionNotify,
  ScopeActivation.OnDemand,
  'notify',
);
