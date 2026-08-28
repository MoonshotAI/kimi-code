import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { type AgentHost, IAgentHostService } from '#/agent/host/agentHost';
import { ITaskService } from '#/app/task/task';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { IAgentTaskService } from './task';
import { AgentTaskService } from './taskService';

export interface ISessionTaskService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentTaskService;
}

export const ISessionTaskService: ServiceIdentifier<ISessionTaskService> =
  createDecorator<ISessionTaskService>('sessionTaskService');

interface TaskImplEntry {
  readonly host: AgentHost;
  readonly impl: IAgentTaskService;
}

export class SessionTaskService extends Disposable implements ISessionTaskService {
  declare readonly _serviceBrand: undefined;
  private readonly impls = new Map<string, TaskImplEntry>();

  constructor(
    @IAgentHostService private readonly hosts: IAgentHostService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly byteStore: IFileSystemStorageService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @ITaskService private readonly taskService: ITaskService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.agentLifecycle.onDidClose((agent) => this.discard(agent)));
    this._register(
      toDisposable(() => {
        for (const entry of this.impls.values()) disposeImpl(entry.impl);
        this.impls.clear();
      }),
    );
    for (const agent of this.agentLifecycle.list()) this.attach(agent);
  }

  attach(agent: AgentContext): void {
    const host = this.hosts.of(agent);
    const existing = this.impls.get(agent.agentId);
    if (existing !== undefined && existing.host === host) return;
    if (existing !== undefined) disposeImpl(existing.impl);
    const impl = new AgentTaskService(
      host.telemetry,
      this.config,
      this.atomicDocs,
      this.byteStore,
      this.sessionCtx,
      host.scopeContext,
      this.taskService,
      host.eventBus,
      host.dispatcher,
      this.agentLifecycle,
      this.log,
      host.state,
    );
    this.impls.set(agent.agentId, { host, impl });
  }

  of(agent: AgentContext): IAgentTaskService {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) {
      throw new Error(`Agent task service for '${agent.agentId}' is unavailable`);
    }
    return entry.impl;
  }

  private discard(agent: AgentContext): void {
    const entry = this.impls.get(agent.agentId);
    if (entry === undefined) return;
    this.impls.delete(agent.agentId);
    disposeImpl(entry.impl);
  }
}

function disposeImpl(impl: IAgentTaskService): void {
  (impl as Partial<IDisposable>).dispose?.();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTaskService,
  SessionTaskService,
  ScopeActivation.OnScopeCreated,
  'sessionTask',
);
