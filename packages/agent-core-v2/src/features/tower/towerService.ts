import { join } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import type { AgentTaskInfo } from '#/agent/task/types';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { TowerModeInjection } from './injection/towerModeInjection';
import {
  TowerStore,
  WORKTREES_DIR,
  assertLocalBaseBranch,
  branchExists,
  checkoutNewLocalBranch,
  commitPaths,
  listBaseDirtyEntries,
  resolveTowerRepoRoot,
  TowerProtocolError,
} from './protocol/index';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  TOWER_TOOL_NAMES,
  TOWER_WORKER_PROFILE,
} from './tower';
import { isTowerFeatureAssembled } from './towerFeature';
import { TowerModeEnter, TowerModeExit, towerBaseKey, towerKey, towerOwnerKey } from './towerOps';

export const TOWER_MODE_TOOLS: readonly string[] = ['TowerInit', ...TOWER_TOOL_NAMES];

export class AgentTowerService extends Disposable implements IAgentTowerService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IFlagService private readonly flags: IFlagService,
    @ISessionManager private readonly sessions: ISessionManager,
    @IFeatureManager featureManager: IFeatureManager,
    @IConfigService config: IConfigService,
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this.agentState.contributeState(towerKey);
    this.agentState.contributeState(towerOwnerKey);
    this.agentState.contributeState(towerBaseKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('tower', async (_ctx, next) => {
        await this.exitForeignTower();
        this.restoreTowerTools();
        this.reconcileTowerProjection();
        await next();
      }),
    );
    if (featureManager !== undefined) {
      this._register(
        featureManager.onDidChangeUnits(() => {
          this.reconcileTowerProjection();
        }),
      );
    }
    if (config !== undefined) {
      this._register(
        config.onDidChangeConfiguration(() => {
          this.reconcileTowerProjection();
        }),
      );
    }
    this._register(
      eventBus.subscribe(AgentStatusUpdated, () => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        const active = this.profile.getActiveToolNames();
        if (active === undefined) return;
        if (TOWER_MODE_TOOLS.every((name) => active.includes(name))) return;
        for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: true }),
        );
      }),
    );
    this._register(new TowerModeInjection(reminder, this, context, this.flags));
    this._register(
      eventBus.subscribe(TaskTerminatedNotice, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        void this.recordTowerAgentDeath(event.info);
      }),
    );
    this._register(
      eventBus.subscribe(SubagentStarted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        void this.clearTowerAgentDeath(event.subagentId);
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!TOWER_MODE_TOOLS.includes(event.toolCall.name)) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'The tower experiment is disabled — tower tools are inert. Re-enable the experiment (a restart is required if it was just turned on) before driving the tower protocol.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'TodoList') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (this.profile.data().profileName !== TOWER_WORKER_PROFILE) return;
        const toolName = event.toolCall.name;
        if (toolName !== 'Write' && toolName !== 'Edit') return;

        const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
        const entry = await store
          .load()
          .then(
            (state) =>
              state.roster.agents.find((agent) => agent.agentId === this.agentCtx.agentId),
            () => undefined,
          );
        const slot = entry?.worktree;
        if (slot === undefined) return;
        const worktree = store.abs(join(WORKTREES_DIR, slot));

        const escapes = (event.execution.accesses ?? [])
          .filter(
            (access): access is ToolFileAccess =>
              access.kind === 'file' &&
              (access.operation === 'write' || access.operation === 'readwrite'),
          )
          .filter((access) => !isWithinDirectory(access.path, worktree));
        if (escapes.length === 0) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
                `${escapes.map((access) => access.path).join(', ')}. ` +
                'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
            ),
          ),
        );
      }),
    );
  }

  async enter(base?: string): Promise<void> {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.flags.enabled(TOWER_FLAG_ID)) return;
    if (!isTowerFeatureAssembled(this.flags)) return;
    if (base !== undefined) {
      await this.prepareUserBase(base);
    }
    if (this.isActive) {
      if (base !== undefined && base !== this.agentState.get(towerBaseKey)) {
        this.dispatchEnter(base);
      }
      return;
    }
    const owner = await this.resolveTowerOwner();
    if (owner !== undefined && owner !== this.sessionCtx.sessionId) {
      const ownerHandle = this.sessions.get(owner);
      if (ownerHandle !== undefined) {
        const activity = ownerHandle.accessor.get(ISessionActivityView).state();
        if (activity.busy || activity.pendingInteraction !== 'none') return;
        ownerHandle.accessor
          .get(IAgentLifecycleService)
          .handleOf('main')
          ?.accessor.get(IAgentTowerService)
          .exit();
      }
    }
    for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
    this.lastPublished = true;
    this.dispatchEnter(base);
  }

  get requestedBase(): string | undefined {
    return this.agentState.get(towerBaseKey) ?? undefined;
  }

  private async prepareUserBase(base: string): Promise<void> {
    const repoRoot = resolveTowerRepoRoot(this.sessionCtx.cwd);
    const store = new TowerStore(repoRoot);
    if (await store.isInitialized()) {
      const state = await store.load();
      if (state.base === base) {
        await assertLocalBaseBranch(repoRoot, base);
        return;
      }
      const open = state.missions.filter(
        (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
      );
      if (open.length > 0) {
        throw new TowerProtocolError(
          `tower workspace already records base "${state.base}" with ${String(open.length)} open mission(s) (${open.map((mission) => mission.id).join(', ')}) — merge or abandon them (or /tower teardown) before switching the tower to base "${base}"`,
        );
      }
      if (!(await branchExists(repoRoot, base))) {
        await this.createBaseBranch(repoRoot, base);
      }
      await store.rebase(base);
      return;
    }
    if (await branchExists(repoRoot, base)) {
      await store.init(this.sessionCtx.sessionId, base);
      return;
    }
    await this.createBaseBranch(repoRoot, base);
    await store.init(this.sessionCtx.sessionId, base);
  }

  private async createBaseBranch(repoRoot: string, base: string): Promise<void> {
    const dirty = await listBaseDirtyEntries(repoRoot);
    if (dirty.some((entry) => entry.unmerged)) {
      throw new TowerProtocolError(
        'the checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before starting a tower on a new base',
      );
    }
    await checkoutNewLocalBranch(repoRoot, base);
    if (dirty.length === 0) return;
    try {
      await commitPaths(
        repoRoot,
        dirty.map((entry) => entry.path),
        `tower: snapshot of uncommitted base checkout changes (base ${base})`,
      );
    } catch (error) {
      throw new TowerProtocolError(
        `created and switched to "${base}", but committing the checkout's uncommitted changes onto it failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `The changes are still uncommitted on "${base}" — commit or move them, then re-run /tower ${base}.`,
      );
    }
  }

  private dispatchEnter(base: string | undefined): void {
    void this.dispatcher.dispatch(
      new TowerModeEnter({
        agentId: this.agentCtx.agentId,
        sessionId: this.sessionCtx.sessionId,
        base,
      }),
    );
  }

  exit(): void {
    if (!this.agentState.get(towerKey)) return;
    this.lastPublished = false;
    void this.dispatcher.dispatch(new TowerModeExit({ agentId: this.agentCtx.agentId }));
  }

  get isActive(): boolean {
    return (
      this.agentCtx.agentId === 'main' &&
      this.flags.enabled(TOWER_FLAG_ID) &&
      isTowerFeatureAssembled(this.flags) &&
      this.agentState.get(towerKey)
    );
  }

  private async exitForeignTower(): Promise<void> {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) return;
    const owner = await this.resolveTowerOwner();
    if (owner === undefined || owner === this.sessionCtx.sessionId) return;
    if (this.sessions.get(owner) === undefined) return;
    void this.dispatcher.dispatch(new TowerModeExit({ agentId: this.agentCtx.agentId }));
  }

  private async resolveTowerOwner(): Promise<string | undefined> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const storeOwner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return storeOwner ?? this.agentState.get(towerOwnerKey);
  }

  private async recordTowerAgentDeath(info: AgentTaskInfo): Promise<void> {
    if (info.kind !== 'agent') return;
    if (info.agentId === undefined) return;
    if (info.status === 'completed') return;
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    await store.markAgentDied(info.agentId, info.status, info.stopReason).then(
      () => undefined,
      () => undefined,
    );
  }

  private async clearTowerAgentDeath(agentId: string): Promise<void> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    await store.clearAgentDied(agentId).then(
      () => undefined,
      () => undefined,
    );
  }

  private restoreTowerTools(): void {
    if (!this.flags.enabled(TOWER_FLAG_ID)) return;
    if (!this.isActive) return;
    if (this.agentCtx.agentId !== 'main') return;
    for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
    this.lastPublished = true;
    void this.dispatcher.dispatch(new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: true }));
  }

  private lastPublished: boolean | undefined;

  private reconcileTowerProjection(): void {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) {
      this.lastPublished = false;
      return;
    }
    const effective = this.isActive;
    if (this.lastPublished === effective) return;
    this.lastPublished = effective;
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({ agentId: this.agentCtx.agentId, towerMode: effective }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
