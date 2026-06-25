/**
 * `agent-lifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes; persists records
 * through `records` and reads session context through `session-context`. Bound
 * at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import {
  type IScopeHandle,
  LifecycleScope,
  getScopedServiceDescriptors,
  registerScopedService,
} from '#/_base/di/scope';
import {
  IInstantiationService,
  type ServiceIdentifier,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { ISessionMetaStore } from '#/records/records';
import { ISessionContext } from '#/session-context/sessionContext';

import { type CreateAgentOptions, IAgentLifecycleService } from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IScopeHandle>();

  constructor(
    @ISessionContext _ctx: ISessionContext,
    @ISessionMetaStore _meta: ISessionMetaStore,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
  }

  create(opts: CreateAgentOptions): Promise<IScopeHandle> {
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
    const collection = new ServiceCollection();
    for (const entry of getScopedServiceDescriptors(LifecycleScope.Agent)) {
      collection.set(entry.id, entry.descriptor);
    }
    const child = this.instantiation.createChild(collection);
    const accessor: ServicesAccessor = {
      get: <T>(id: ServiceIdentifier<T>): T => child.invokeFunction((a) => a.get(id)),
    };
    const handle: IScopeHandle = { id: agentId, kind: LifecycleScope.Agent, accessor };
    this.handles.set(agentId, handle);
    return Promise.resolve(handle);
  }

  createMain(): Promise<IScopeHandle> {
    return this.create({ agentId: 'main' });
  }

  getHandle(agentId: string): IScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(): readonly IScopeHandle[] {
    return [...this.handles.values()];
  }

  remove(agentId: string): Promise<void> {
    this.handles.delete(agentId);
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agent-lifecycle');
