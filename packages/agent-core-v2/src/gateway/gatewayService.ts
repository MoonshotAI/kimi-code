/**
 * `gateway` domain (L7) — `IScopeRegistry` / `IRestGateway` / `IWSGateway` /
 * `IWSBroadcastService` implementation.
 *
 * Owns the session scope registry and the REST/WS entry points; resolves agents
 * through `agent-lifecycle`, drives turns through `turn`, and subscribes to
 * broadcasts through `event`. Bound at Core scope.
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
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEventService } from '#/event/event';
import { ITurnService } from '#/turn/turn';

import {
  type CreateSessionOptions,
  IRestGateway,
  IScopeRegistry,
  IWSBroadcastService,
  IWSGateway,
} from './gateway';

export class ScopeRegistry implements IScopeRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, IScopeHandle>();

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  createSession(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const collection = new ServiceCollection();
    for (const entry of getScopedServiceDescriptors(LifecycleScope.Session)) {
      collection.set(entry.id, entry.descriptor);
    }
    const child = this.instantiation.createChild(collection);
    const accessor: ServicesAccessor = {
      get: <T>(id: ServiceIdentifier<T>): T => child.invokeFunction((a) => a.get(id)),
    };
    const handle: IScopeHandle = { id: opts.sessionId, kind: LifecycleScope.Session, accessor };
    this.sessions.set(opts.sessionId, handle);
    return Promise.resolve(handle);
  }

  get(sessionId: string): IScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }
}

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(@IScopeRegistry private readonly scopes: IScopeRegistry) {}

  private turn(sessionId: string, agentId: string): ITurnService {
    const session = this.scopes.get(sessionId);
    if (session === undefined) throw new Error(`unknown session '${sessionId}'`);
    const agents = session.accessor.get(IAgentLifecycleService);
    const agent = agents.getHandle(agentId);
    if (agent === undefined) throw new Error(`unknown agent '${agentId}'`);
    return agent.accessor.get(ITurnService);
  }

  prompt(sessionId: string, agentId: string, input: string): Promise<void> {
    return this.turn(sessionId, agentId).prompt(input);
  }
  steer(sessionId: string, agentId: string, content: string): Promise<void> {
    this.turn(sessionId, agentId).steer(content);
    return Promise.resolve();
  }
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void> {
    this.turn(sessionId, agentId).cancel(reason);
    return Promise.resolve();
  }
  getStatus(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.scopes.get(sessionId) !== undefined);
  }
}

export class WSGateway implements IWSGateway {
  declare readonly _serviceBrand: undefined;
  private readonly connections = new Set<string>();

  constructor(
    @IScopeRegistry _scopes: IScopeRegistry,
    @IEventService _event: IEventService,
  ) {}

  connect(connectionId: string): void {
    this.connections.add(connectionId);
  }
  broadcast(_sessionId: string, _event: unknown): void {
  }
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  declare readonly _serviceBrand: undefined;

  constructor(@IEventService event: IEventService) {
    super();
    event.subscribe(() => {
    });
  }
}

registerScopedService(LifecycleScope.Core, IScopeRegistry, ScopeRegistry, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.Core, IRestGateway, RestGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.Core, IWSGateway, WSGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.Core, IWSBroadcastService, WSBroadcastService, InstantiationType.Delayed, 'gateway');
