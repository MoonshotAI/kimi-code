import { join } from 'pathe';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { type CollectionView } from '#/_base/di/collection';
import { Emitter } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { permissionModeConfiguredKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { profileKey } from '#/agent/profile/profileOps';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  agentContextOf,
  IAgentScopeContext,
  makeAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import '#/agent/runtimeBinding/runtimeBindingService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IWireService } from '#/wire/wire';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  AgentRuntimeContributionPoint,
  type AgentCapability,
  type AgentRuntimeContribution,
  type AgentRuntimeDefinitionRecord,
  type AgentRuntimeSnapshot,
} from '#/agent/runtime/agentRuntime';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { ManagedAgent } from './managedAgent';
import {
  type AgentListFilter,
  type AgentScopeCreatedEvent,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentManager,
} from './agentManager';

let nextAgentId = 0;

export class AgentManagerService extends Disposable implements IAgentManager {
  declare readonly _serviceBrand: undefined;
  private readonly roster = new Map<string, ManagedAgent>();
  private readonly creating = new Map<string, Promise<AgentContext>>();
  private nextLifecycleGeneration = 0;
  private readonly records = new Map<string, AgentRuntimeDefinitionRecord>();
  private readonly recordGenerations = new Map<string, number>();
  private readonly contributions = new Map<AgentRuntimeContribution, AgentRuntimeDefinitionRecord>();
  private readonly onDidCreateEmitter = this._register(new Emitter<AgentContext>());
  private readonly onDidCreateScopeEmitter = this._register(new Emitter<AgentScopeCreatedEvent>());
  private readonly onWillCloseEmitter = this._register(new Emitter<AgentContext>());
  private readonly onDidCloseEmitter = this._register(new Emitter<AgentContext>());

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidCreateScope() {
    return this.onDidCreateScopeEmitter.event;
  }
  get onWillClose() {
    return this.onWillCloseEmitter.event;
  }
  get onDidClose() {
    return this.onDidCloseEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @AgentRuntimeContributionPoint contributionView: CollectionView<AgentRuntimeContribution>,
  ) {
    super();
    for (const contribution of contributionView.items) this.registerContribution(contribution);
    this._register(
      contributionView.onDidChange(({ added, removed }) => {
        for (const contribution of added) this.registerContribution(contribution);
        for (const contribution of removed) this.withdrawContribution(contribution);
      }),
    );
    this._register(
      toDisposable(() => {
        for (const managed of this.roster.values()) {
          void managed.runtimeSet.close().catch((error: unknown) => onUnexpectedError(error));
        }
        this.roster.clear();
      }),
    );
  }

  private registerContribution(contribution: AgentRuntimeContribution): void {
    if (this.contributions.has(contribution)) return;
    const generation = (this.recordGenerations.get(contribution.capability.id) ?? 0) + 1;
    this.recordGenerations.set(contribution.capability.id, generation);
    const record: AgentRuntimeDefinitionRecord = {
      capability: contribution.capability,
      definition: contribution.definition,
      generation,
      active: true,
    };
    this.contributions.set(contribution, record);
    this.records.set(contribution.capability.id, record);
    for (const managed of this.roster.values()) {
      if (!managed.closing) managed.runtimeSet.apply(record);
    }
  }

  private withdrawContribution(contribution: AgentRuntimeContribution): void {
    const record = this.contributions.get(contribution);
    if (record === undefined) return;
    this.contributions.delete(contribution);
    record.active = false;
    if (this.records.get(record.capability.id) === record) {
      this.records.delete(record.capability.id);
    }
    for (const managed of this.roster.values()) {
      managed.runtimeSet.retireDefinition(record);
    }
  }

  private activeRecords(): readonly AgentRuntimeDefinitionRecord[] {
    return [...this.records.values()];
  }

  async create(opts: CreateAgentOptions = {}): Promise<AgentContext> {
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.roster.get(opts.agentId);
      if (existing !== undefined && !existing.closing) return existing.context;
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.roster.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<AgentContext> {
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const generation = ++this.nextLifecycleGeneration;
    const scopeContext = makeAgentScopeContext({ agentId, agentScope, generation });
    const agent = scopeContext.agentContext;
    const eventBus = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionEventBus) as ISessionEventBus | undefined,
    );
    eventBus?.activateAgent(agent);
    let managed: ManagedAgent | undefined;
    try {
      const handle = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Agent,
        agentId,
        {
          seeds: [
            [IAgentScopeContext, scopeContext],
            [ITelemetryService, this.telemetry.withContext({ agent_id: agentId })],
            [IAgentRuntimeBindingSeed, {
              _serviceBrand: undefined,
              binding: { workspaceId: this.ctx.workspaceId, runtimeId: opts.runtimeId ?? 'local' },
            }],
          ],
          configureContainer: (container) => {
            this.adopt({
              id: agentId,
              kind: LifecycleScope.Agent,
              accessor: {
                get: (id) => container.invokeFunction((accessor) => accessor.get(id)),
              },
              dispose: () => { container.dispose(); },
            });
            managed = this.roster.get(agentId);
          },
        },
      ) as IAgentScopeHandle;
      managed!.active = true;
      await handle.accessor.get(IWireService).seal();
      managed!.attachDurableRuntimes();
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: agentId === 'main' ? 'main' : 'sub',
        parentAgentId: agentId === 'main' ? undefined : 'main',
        forkedFrom: opts.forkedFrom,
        labels: opts.labels,
      });
      this.onDidCreateEmitter.fire(agent);
      this.onDidCreateScopeEmitter.fire({ context: agent, handle });
      await handle.accessor.get(IEventDispatcher).restore();
      await this.bindBootstrap(handle, opts);
      await handle.accessor.get(IAgentToolActivationService).activate();
      return agent;
    } catch (error) {
      if (managed !== undefined) {
        managed.closing = true;
        if (this.roster.get(agentId) === managed) this.roster.delete(agentId);
        await managed.runtimeSet.close().catch(() => undefined);
        managed.killSpace();
        try {
          managed.handle.dispose();
        } catch { }
      }
      eventBus?.deactivateAgent(agent);
      this.onDidCloseEmitter.fire(agent);
      throw error;
    }
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = handle.accessor
      .get(IAgentStateService)
      .get(permissionModeConfiguredKey);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
  }

  async fork(sourceContext: AgentContext, opts?: ForkAgentOptions): Promise<AgentContext> {
    const sourceManaged = this.managedFor(sourceContext);
    if (sourceManaged === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Source agent "${sourceContext.agentId}" does not exist`,
        { details: { agentId: sourceContext.agentId } },
      );
    }
    if (opts?.agentId !== undefined && this.get(opts.agentId) !== undefined) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${opts.agentId}" already exists`, {
        details: { agentId: opts.agentId },
      });
    }
    const source = sourceManaged.handle;
    const childContext = await this.create({
      agentId: opts?.agentId,
      runtimeId: source.accessor.get(IAgentRuntimeBindingService).current.runtimeId,
      forkedFrom: source.id,
    });
    const child = this.requireManaged(childContext).handle;

    const sourceData = source.accessor.get(IAgentProfileService).data();
    const childProfile = child.accessor.get(IAgentProfileService);
    const override = opts?.binding;
    if (override?.profile !== undefined) {
      await childProfile.bind({
        profile: override.profile,
        model: override.model ?? sourceData.modelAlias,
        thinking: override?.thinking ?? sourceData.thinkingLevel,
      });
    } else {
      childProfile.applyBindingSnapshot(sourceData);
      if (override?.model !== undefined) await childProfile.setModel(override.model);
      if (override?.thinking !== undefined) childProfile.setThinking(override.thinking);
    }

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.append(...sourceMessages);
    }
    return childContext;
  }

  get(agentId: string): AgentContext | undefined {
    const managed = this.roster.get(agentId);
    if (managed === undefined || managed.closing || !managed.active) return undefined;
    return managed.context;
  }

  list(filter?: AgentListFilter): readonly AgentContext[] {
    const all = [...this.roster.values()]
      .filter((managed) => managed.active && !managed.closing)
      .map((managed) => managed.context);
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((context) => context.agentId.startsWith(prefix));
  }

  resolve<T>(agent: AgentContext, capability: AgentCapability<T>): T {
    return this.requireManaged(agent).runtimeSet.resolve(capability);
  }

  inspect(agent: AgentContext): AgentRuntimeSnapshot {
    const managed = this.requireManaged(agent);
    return {
      identity: { agentId: agent.agentId, generation: agent.generation },
      contributions: managed.runtimeSet.inspect(),
    };
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const managed of this.roster.values()) {
      if (managed.closing || !managed.active) continue;
      const handle = managed.handle;
      if (
        handle.accessor.get(IAgentStateService).get(profileKey).profileName ===
        TOWER_WORKER_PROFILE
      ) {
        continue;
      }
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  handleOf(agentId: string): IAgentScopeHandle | undefined {
    const managed = this.roster.get(agentId);
    if (managed === undefined || managed.closing || !managed.active) return undefined;
    return managed.handle;
  }

  adopt(handle: IAgentScopeHandle): AgentContext {
    const agent = agentContextOf(handle);
    const existing = this.roster.get(agent.agentId);
    if (existing !== undefined) {
      if (!existing.closing && existing.context === agent) return existing.context;
      if (!existing.closing) {
        throw new Error(`Agent "${agent.agentId}" is already managed by a different context`);
      }
    }
    const managed = new ManagedAgent(agent, handle, this.activeRecords());
    this.roster.set(agent.agentId, managed);
    return agent;
  }

  attachRuntimes(agent: AgentContext): void {
    const managed = this.requireManaged(agent);
    managed.attachDurableRuntimes();
    if (!managed.active) {
      managed.active = true;
      this.onDidCreateEmitter.fire(agent);
      this.onDidCreateScopeEmitter.fire({ context: agent, handle: managed.handle });
    }
  }

  async remove(agent: AgentContext): Promise<void> {
    const managed = this.roster.get(agent.agentId);
    if (managed === undefined || managed.context !== agent || managed.closing) return;
    managed.closing = true;
    this.onWillCloseEmitter.fire(agent);
    const handle = managed.handle;
    await handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed');
    const loop = handle.accessor.get(IAgentLoopService);
    const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
    const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
    const reason = abortError('Agent removed');
    const prompt = handle.accessor.get(IAgentPromptService);
    for (const turnId of loop.status().pendingTurnIds) {
      loop.cancel(turnId, reason);
    }
    loop.cancel(undefined, reason);
    if (compaction !== null && !compaction.abortController.signal.aborted) {
      compaction.abortController.abort(reason);
    }
    await Promise.all([loop.settled(), compactionSettled, prompt.drain(reason)]);
    await managed.runtimeSet.close();
    managed.killSpace();
    handle.dispose();
    this.instantiation.invokeFunction((accessor) =>
      (accessor.get(ISessionEventBus) as ISessionEventBus | undefined)?.deactivateAgent(agent),
    );
    if (this.roster.get(agent.agentId) === managed) this.roster.delete(agent.agentId);
    this.onDidCloseEmitter.fire(agent);
  }

  private managedFor(agent: AgentContext): ManagedAgent | undefined {
    const managed = this.roster.get(agent.agentId);
    if (managed === undefined || managed.context !== agent || managed.closing) return undefined;
    return managed;
  }

  private requireManaged(agent: AgentContext): ManagedAgent {
    const managed = this.managedFor(agent);
    if (managed === undefined) {
      throw new Error(
        `Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`,
      );
    }
    return managed;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentManager,
  AgentManagerService,
  ScopeActivation.OnScopeCreated,
  'agentManager',
);
