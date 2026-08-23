import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import {
  ISessionToolPolicy,
  type SessionToolPolicyChangedEvent,
} from './sessionToolPolicy';

interface SessionToolPolicyState {
  readonly disabledTools: readonly string[];
}

export const sessionToolPolicyStateKey = defineState<SessionToolPolicyState>('sessionToolPolicy.state', () => ({
  disabledTools: [],
}));

const STATE_KEY = 'state.json';

export class SessionToolPolicyService extends Disposable implements ISessionToolPolicy {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<SessionToolPolicyChangedEvent>;

  private readonly changeEmitter = this._register(
    new AsyncEmitter<SessionToolPolicyChangedEvent>(),
  );
  private readonly scope: string;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext sessionContext: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
  ) {
    super();
    this.states.contributeState(sessionToolPolicyStateKey);
    this.scope = sessionContext.scope('tool-policy');
    this.onDidChange = this.changeEmitter.event;
    this.ready = this.load();
  }

  private get state(): SessionToolPolicyState {
    return this.states.get(sessionToolPolicyStateKey);
  }

  private set state(value: SessionToolPolicyState) {
    this.states.set(sessionToolPolicyStateKey, value);
  }

  disabledTools(): readonly string[] {
    return this.state.disabledTools;
  }

  setDisabledTools(names: readonly string[]): Promise<void> {
    const run = this.updateQueue.then(() => this.replace(names));
    this.updateQueue = run.catch(() => {});
    return run;
  }

  private async load(): Promise<void> {
    const stored = await this.store.get<SessionToolPolicyState>(this.scope, STATE_KEY);
    if (stored !== undefined) {
      this.state = { disabledTools: [...new Set(stored.disabledTools)] };
    }
  }

  private async replace(names: readonly string[]): Promise<void> {
    await this.ready;
    const disabledTools = [...new Set(names)];
    if (
      disabledTools.length === this.state.disabledTools.length &&
      disabledTools.every((name, index) => name === this.state.disabledTools[index])
    ) {
      return;
    }
    const nextState = { disabledTools };
    await this.store.set(this.scope, STATE_KEY, nextState);
    this.state = nextState;
    await this.changeEmitter.fireAsync({}, new AbortController().signal);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionToolPolicy,
  SessionToolPolicyService,
  ScopeActivation.OnScopeCreated,
  'sessionToolPolicy',
);
