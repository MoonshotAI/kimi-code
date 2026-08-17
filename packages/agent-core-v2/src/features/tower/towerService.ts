/**
 * `tower` domain — `IAgentTowerService` implementation.
 *
 * Tracks tower-mode enter/exit in the `wire` `TowerModel` (mutated only
 * through the `tower_mode.enter` / `tower_mode.exit` Ops, read through
 * `wire.getModel`), and derives the `towerMode` slice of
 * `agent.status.updated` from the Ops' `toEvent`. Also carries the
 * tower-mode harness constraints as `onBeforeExecuteTool` veto listeners.
 * The first denies `TodoList` while tower mode is active: mission state
 * lives in the tower protocol, and todo semantics ("keep exactly one task
 * in_progress") would serialize a fleet that exists to run in parallel —
 * tower mode is per-agent, so this only ever fires for the tower itself and
 * workers keep their TodoList. The second is the tower-worker write guard
 * (port of v1's `tower-worker-write-guard-deny`
 * policy): a `tower-worker`-profile agent's Write/Edit is confined to the
 * worktree its roster entry records (`.tower/worktrees/<slot>` under the
 * repo root, resolved through the `tower` protocol store from
 * `sessionContext.cwd`); any declared write access outside it is vetoed with
 * the v1 message verbatim. v1 keyed the confinement on the worker's cwd
 * override, which was always set; v2 has no per-agent cwd, so a worker
 * without a roster entry (or with no readable `.tower` state) is simply
 * outside the protocol and the guard abstains. `AskUserQuestion` is
 * deliberately not vetoed here: the tower (the main agent) may ask the human
 * to clarify requirements, while workers and reviewers cannot ask at all —
 * their `tower-worker` profile does not list the tool. Bound at Agent scope.
 */

import { join } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { LifecycleScope } from '#/app/scopes';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  TowerStore,
  WORKTREES_DIR,
  resolveTowerRepoRoot,
} from './protocol/index';
import { IAgentTowerService, TOWER_WORKER_PROFILE } from './tower';
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
  ) {
    super();
    this.agentState.contributeState(towerKey);
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
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

  enter(): void {
    if (this.isActive) return;
    void this.dispatcher.dispatch(new TowerModeEnter({}));
  }

  exit(): void {
    if (!this.isActive) return;
    void this.dispatcher.dispatch(new TowerModeExit({}));
  }

  get isActive(): boolean {
    return this.agentState.get(towerKey);
  }
}

// The tower-mode write guard must be live from agent-scope creation, so this
// service stays on the static import=register channel instead of the Feature
// seam: a feature-contributed OnScopeCreated agent service materializes
// through the ScopeUnits cascade, which can run before the scope's static
// registrations (IEventBus) are visible.
registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
