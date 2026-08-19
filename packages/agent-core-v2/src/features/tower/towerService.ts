import { join } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { TowerModeInjection } from './injection/towerModeInjection';
import {
  TowerStore,
  WORKTREES_DIR,
  resolveTowerRepoRoot,
} from './protocol/index';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  TOWER_TOOL_NAMES,
  TOWER_WORKER_PROFILE,
} from './tower';
import { TowerModeEnter, TowerModeExit, towerKey } from './towerOps';

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
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
  ) {
    super();
    this.agentState.contributeState(towerKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('tower', async (_ctx, next) => {
        this.restoreTowerTools();
        await next();
      }),
    );
    this._register(new TowerModeInjection(injector, this, context, this.agentState));
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
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
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

  enter(): void {
    if (!this.flags.enabled(TOWER_FLAG_ID)) return;
    if (this.isActive) return;
    void this.dispatcher.dispatch(new TowerModeEnter({}));
    if (this.agentCtx.agentId === 'main') {
      for (const name of TOWER_TOOL_NAMES) this.profile.addActiveTool(name);
    }
  }

  exit(): void {
    if (!this.isActive) return;
    void this.dispatcher.dispatch(new TowerModeExit({}));
  }

  get isActive(): boolean {
    return this.agentState.get(towerKey);
  }

  private restoreTowerTools(): void {
    if (!this.isActive) return;
    if (this.agentCtx.agentId !== 'main') return;
    for (const name of TOWER_TOOL_NAMES) this.profile.addActiveTool(name);
    void this.dispatcher.dispatch(new AgentStatusUpdated({ towerMode: true }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
