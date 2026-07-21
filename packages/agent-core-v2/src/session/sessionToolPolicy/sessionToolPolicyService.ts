/**
 * `sessionToolPolicy` domain (L3) — persisted session tool-policy service.
 *
 * Stores the client-managed denylist as one atomic document below the session
 * scope and serializes replacements. A successful replacement awaits all
 * registered Agent prompt refreshes before returning. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event } from '#/_base/event';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  ISessionToolPolicy,
  type SessionToolPolicyChangedEvent,
} from './sessionToolPolicy';

interface SessionToolPolicyState {
  readonly disabledTools: readonly string[];
}

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
  private state: SessionToolPolicyState = { disabledTools: [] };

  constructor(
    @ISessionContext sessionContext: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
  ) {
    super();
    this.scope = sessionContext.scope('tool-policy');
    this.onDidChange = this.changeEmitter.event;
    this.ready = this.load();
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
  InstantiationType.Eager,
  'sessionToolPolicy',
);
