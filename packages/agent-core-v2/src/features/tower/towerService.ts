import { isAbsolute, join, resolve } from 'node:path';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService, type LoopNotifyHandle } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { PromptSubmitted } from '#/agent/prompt/promptEvents';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/types';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IConfigService } from '#/app/config/config';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isUntitled } from '#/session/sessionMetadata/promptMetadata';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { TowerModeInjection } from './injection/towerModeInjection';
import {
  BROADCAST_NAME,
  STATE_FILE,
  TOWER_NAME,
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
  analyzeTowerBashCommand,
  commandNeedsTowerGuard,
  TOWER_BASH_GUARD_PARSE_OPTIONS,
  towerWorkspaceOwned,
} from './bashGuard';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  TOWER_TOOL_NAMES,
  TOWER_WORKER_PROFILE,
  type TowerEnterResult,
  type TowerExitReason,
} from './tower';
import { isTowerFeatureAssembled } from './towerFeature';
import { TowerInboxSent, TowerModeEnter, TowerModeExit, towerKey, towerOwnerKey } from './towerOps';

export const TOWER_MODE_TOOLS: readonly string[] = ['TowerInit', ...TOWER_TOOL_NAMES];
const TOWER_FLAG_VETO_TOOLS: ReadonlySet<string> = new Set([...TOWER_MODE_TOOLS, 'TowerComplete']);

export const TOWER_INBOX_WAKE_VARIANT = 'tower_inbox';

const WAKE_SUBJECT_PREVIEW_MAX = 120;
const WAKE_BATCH_LIMIT = 6;
const WAKE_DIGEST_LIMIT = 4;
const WAKE_TRACKED_KEY_LIMIT = 100;

interface InboxWakeItem {
  readonly key: string;
  readonly from: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly file?: string;
  readonly sentAt?: string;
  readonly missionId?: string;
}

interface InboxWakeBatch {
  readonly items: readonly InboxWakeItem[];
  readonly omitted: number;
}

export class AgentTowerService extends Disposable implements IAgentTowerService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IFlagService private readonly flags: IFlagService,
    @ISessionManager private readonly sessions: ISessionManager,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFeatureManager featureManager: IFeatureManager,
    @IConfigService config: IConfigService,
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @IEventBus eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentTaskService private readonly tasks: IAgentTaskService | undefined,
    @ISessionEventBus sessionBus: ISessionEventBus,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext | undefined,
  ) {
    super();
    this.agentState.contributeState(towerKey);
    this.agentState.contributeState(towerOwnerKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('tower', async (_ctx, next) => {
        await this.reconcileForeignTower();
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
    if (sessionBus !== undefined) {
      this._register(
        sessionBus.subscribe(TowerInboxSent, (event) => {
          this.onTowerInboxSent(event);
        }),
      );
    }
    this._register(
      eventBus.subscribe(TurnStarted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        if (event.agentId !== this.agentCtx.agentId) return;
        if (event.origin.kind !== 'injection' || event.origin.variant !== TOWER_INBOX_WAKE_VARIANT) {
          return;
        }
        this.wakeTurnId = event.turnId;
        this.wakeTurnBatch = this.inboxWakeLastNotified;
      }),
    );
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (event.agentId !== this.agentCtx.agentId) return;
        if (event.turnId === this.wakeTurnId) {
          this.wakeTurnId = undefined;
          if (!this.wakeAbortedForUserPrompt) this.wakeTurnBatch = undefined;
          return;
        }
        if (!this.wakeAbortedForUserPrompt) return;
        if (this.loop === undefined || this.loop.snapshot().queue.length > 0) return;
        this.wakeAbortedForUserPrompt = false;
        const batch = this.wakeTurnBatch;
        this.wakeTurnBatch = undefined;
        if (batch !== undefined) this.requeueInboxWake(batch);
        this.scheduleInboxWake();
      }),
    );
    this._register(
      eventBus.subscribe(PromptSubmitted, (event) => {
        if (this.agentCtx.agentId !== 'main') return;
        if (!this.isActive) return;
        if (event.agentId !== this.agentCtx.agentId) return;
        const turnId = this.wakeTurnId;
        if (turnId === undefined) return;
        queueMicrotask(() => {
          if (this.wakeDisposed || !this.isActive || this.loop === undefined) return;
          if (this.loop.cancel({ turnId }, userCancellationReason())) {
            this.wakeAbortedForUserPrompt = true;
          }
        });
      }),
    );
    this._register(
      toDisposable(() => {
        this.wakeDisposed = true;
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!TOWER_FLAG_VETO_TOOLS.has(event.toolCall.name)) return;
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
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'AgentSwarm') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'AgentSwarm is not available while tower mode is active — swarm and tower modes are mutually exclusive, and the tower fleet runs through TowerSpawn, one mission per worker in its own worktree. If the work genuinely needs a swarm instead, exit tower mode first.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name === 'CreateGoal') {
          event.veto(
            denyToolExecution(
              this.toolApproval.formatDenyMessage(
                'CreateGoal is not available while tower mode is active — tower mode and goals are mutually exclusive, and the previously active goal was paused when tower mode entered. If the work genuinely needs a goal instead, exit tower mode first.',
              ),
            ),
          );
          return;
        }
        if (event.toolCall.name !== 'UpdateGoal') return;
        const args = event.args;
        if (typeof args !== 'object' || args === null) return;
        if ((args as { readonly status?: unknown }).status !== 'active') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'Resuming a goal is not available while tower mode is active — tower mode and goals are mutually exclusive. If the work genuinely needs the goal instead, exit tower mode first.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (event.toolCall.name !== 'Agent') return;
        const args = event.args;
        if (typeof args !== 'object' || args === null) return;
        const resume = (args as { readonly resume?: unknown }).resume;
        if (typeof resume !== 'string') return;
        const resumeId = resume.trim();
        if (resumeId.length === 0) return;
        const mainCheckout = resolveTowerRepoRoot(this.sessionCtx.cwd);
        if (!(await towerWorkspaceOwned(join(mainCheckout, STATE_FILE)))) return;
        const store = new TowerStore(mainCheckout);
        const forbidden = await store.load().then(
          (state) => {
            const caller = store.resolveAgent(state, this.agentCtx.agentId);
            if (caller?.kind !== 'reviewer') return undefined;
            if (resumeId === 'main') return 'main';
            return store.resolveAgent(state, resumeId)?.name;
          },
          () => undefined,
        );
        if (forbidden === undefined) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `Reviewer agents cannot resume "${forbidden}" — main and every roster agent are orchestration identities; reviewers finish with TowerReview instead. Non-roster explore/plan subagents are still allowed.`,
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (!this.flags.enabled(TOWER_FLAG_ID)) return;
        if (!this.isActive) return;
        if (event.toolCall.name !== 'Agent') return;
        const args = event.args;
        if (typeof args !== 'object' || args === null) return;
        const resume = (args as { readonly resume?: unknown }).resume;
        if (typeof resume !== 'string') return;
        const resumeId = resume.trim();
        if (resumeId.length === 0) return;
        const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
        const resolved = await store.load().then(
          (state) => {
            const entry = store.resolveAgent(state, resumeId);
            if (entry === undefined) return undefined;
            const branch =
              entry.branch ??
              entry.reviewTarget ??
              state.missions.find((mission) => mission.id === entry.missionId)?.branch;
            return { entry, branch };
          },
          () => undefined,
        );
        if (resolved === undefined) return;
        if (resolved.branch !== undefined && this.isBranchLeased(resolved.branch)) {
          event.veto(
            denyToolExecution(
              this.toolApproval.formatDenyMessage(
                `Cannot resume tower agent "${resolved.entry.name}" while branch "${resolved.branch}" is leased by a merge/rebase — no agent was started; retry after that operation finishes`,
              ),
            ),
          );
          return;
        }
        if ((args as { readonly run_in_background?: unknown }).run_in_background === true) return;
        const backgroundAvailable =
          this.toolPolicy.isToolActive('TaskList') &&
          this.toolPolicy.isToolActive('TaskOutput') &&
          this.toolPolicy.isToolActive('TaskStop');
        if (!backgroundAvailable) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `Resuming tower agent "${resolved.entry.name}" in the foreground would freeze the tower until it finishes — pass run_in_background=true instead; its completion (and any inbox traffic) will wake you.`,
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
            (state) => store.resolveAgent(state, this.agentCtx.agentId),
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
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (event.toolCall.name !== 'Bash') return;
        const args = event.args;
        if (typeof args !== 'object' || args === null) return;
        const command = (args as { readonly command?: unknown }).command;
        if (typeof command !== 'string' || !commandNeedsTowerGuard(command)) return;
        const mainCheckout = resolveTowerRepoRoot(this.sessionCtx.cwd);
        if (!(await towerWorkspaceOwned(join(mainCheckout, STATE_FILE)))) return;
        const cwdArg = (args as { readonly cwd?: unknown }).cwd;
        const cwd =
          typeof cwdArg === 'string'
            ? this.resolveBashGuardCwd(cwdArg)
            : (this.workspaceCtx?.workDir ?? this.sessionCtx.cwd);
        const reason = analyzeTowerBashCommand({ command, cwd, mainCheckout }, (source) =>
          this.bashParser.parse(source, TOWER_BASH_GUARD_PARSE_OPTIONS),
        );
        if (reason === undefined) return;
        event.veto(denyToolExecution(this.toolApproval.formatDenyMessage(reason)));
      }),
    );
  }

  private resolveBashGuardCwd(cwdArg: string): string {
    if (this.workspaceCtx !== undefined) return this.workspaceCtx.resolve(cwdArg);
    return isAbsolute(cwdArg) ? resolve(cwdArg) : resolve(this.sessionCtx.cwd, cwdArg);
  }

  async enter(base?: string): Promise<TowerEnterResult> {
    const result = await this.resolveEnter(base);
    this.telemetry.track2('tower_mode_enter', {
      outcome: result.entered ? 'entered' : 'rejected',
      reason: result.entered ? undefined : result.reason,
    });
    return result;
  }

  private async resolveEnter(base?: string): Promise<TowerEnterResult> {
    if (this.agentCtx.agentId !== 'main') return { entered: false, reason: 'not-main-agent' };
    if (!this.flags.enabled(TOWER_FLAG_ID)) return { entered: false, reason: 'experiment-off' };
    if (!isTowerFeatureAssembled(this.flags)) return { entered: false, reason: 'feature-not-assembled' };
    const owner = await this.resolveTowerOwner();
    if (owner !== undefined && owner !== this.sessionCtx.sessionId) {
      const ownerHandle = this.sessions.get(owner);
      if (ownerHandle !== undefined) {
        const activity = ownerHandle.accessor.get(ISessionActivityView).state();
        if (activity.busy || activity.pendingInteraction !== 'none') {
          const ownerTitle = await this.resolveOwnerTitle(ownerHandle);
          return { entered: false, reason: 'owned-by-live-session', owner, ownerTitle };
        }
        await ownerHandle.accessor
          .get(IAgentLifecycleService)
          .handleOf('main')
          ?.accessor.get(IAgentTowerService)
          .exit('takeover');
      }
    }
    if (base !== undefined) {
      await this.prepareUserBase(base);
    }
    if (this.isActive) {
      return { entered: true };
    }
    await this.adoptTowerRoster();
    for (const name of TOWER_MODE_TOOLS) this.profile.addActiveTool(name);
    this.lastPublished = true;
    this.dispatchEnter();
    return { entered: true };
  }

  private async prepareUserBase(base: string): Promise<void> {
    const repoRoot = resolveTowerRepoRoot(this.sessionCtx.cwd);
    const store = new TowerStore(repoRoot);
    await store.ensureRepository(base);
    if (await store.isInitialized()) {
      const state = await store.load();
      if (state.base === base) {
        await assertLocalBaseBranch(repoRoot, base);
        return;
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

  private dispatchEnter(): void {
    void this.dispatcher.dispatch(
      new TowerModeEnter({
        agentId: this.agentCtx.agentId,
        sessionId: this.sessionCtx.sessionId,
      }),
    );
  }

  async exit(reason: TowerExitReason = 'user'): Promise<void> {
    if (!this.agentState.get(towerKey)) return;
    this.lastPublished = false;
    this.dropInboxWake();
    void this.dispatcher.dispatch(new TowerModeExit({ agentId: this.agentCtx.agentId }));
    this.telemetry.track2('tower_mode_exit', { reason });
    await this.releaseTowerOwnership();
  }

  private dropInboxWake(): void {
    this.inboxWakeGeneration += 1;
    this.inboxWakeDiscarding = true;
    try {
      this.inboxWakeHandle?.drop();
    } finally {
      this.inboxWakeDiscarding = false;
    }
    this.inboxWakeHandle = undefined;
    this.inboxWakePending = false;
    this.inboxWakeItems = [];
    this.inboxWakeOmitted = 0;
    this.inboxWakeRecentKeys.clear();
    this.inboxWakeLastNotified = undefined;
    this.wakeTurnBatch = undefined;
    this.wakeTurnId = undefined;
    this.wakeAbortedForUserPrompt = false;
  }

  private async adoptTowerRoster(): Promise<void> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    try {
      await store.adopt(this.sessionCtx.sessionId);
    } catch (error) {
      throw new TowerProtocolError(
        `failed to adopt the tower workspace roster: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async releaseTowerOwnership(): Promise<void> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    await store.release(this.sessionCtx.sessionId).then(
      () => undefined,
      (error: unknown) => {
        this.log.warn(
          `failed to release tower workspace ownership: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  get isActive(): boolean {
    return (
      this.agentCtx.agentId === 'main' &&
      this.flags.enabled(TOWER_FLAG_ID) &&
      isTowerFeatureAssembled(this.flags) &&
      this.agentState.get(towerKey)
    );
  }

  private readonly branchLeases = new Set<string>();

  isBranchLeased(branch: string): boolean {
    return this.branchLeases.has(branch);
  }

  async withBranchLease<T>(branch: string, execute: () => Promise<T>): Promise<T> {
    if (this.branchLeases.has(branch)) {
      throw new TowerProtocolError(
        `branch "${branch}" is leased by another tower merge/rebase — not waiting; retry after that operation finishes`,
      );
    }
    this.branchLeases.add(branch);
    try {
      return await execute();
    } finally {
      this.branchLeases.delete(branch);
    }
  }

  private async reconcileForeignTower(): Promise<void> {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.agentState.get(towerKey)) return;
    const owner = await this.resolveTowerOwner();
    if (owner === undefined || owner === this.sessionCtx.sessionId) return;
    if (this.sessions.get(owner) === undefined) {
      try {
        await this.adoptTowerRoster();
      } catch (error) {
        this.log.warn(
          `failed to adopt tower workspace roster on restore: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.exit('foreign-reconcile');
      }
      return;
    }
    void this.exit('foreign-reconcile');
  }

  private async resolveTowerOwner(): Promise<string | undefined> {
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const storeOwner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return storeOwner ?? this.agentState.get(towerOwnerKey);
  }

  private async resolveOwnerTitle(ownerHandle: ISessionScopeHandle): Promise<string | undefined> {
    try {
      const meta = await ownerHandle.accessor.get(ISessionMetadata).read();
      return isUntitled(meta.title) ? undefined : meta.title;
    } catch {
      return undefined;
    }
  }

  private async recordTowerAgentDeath(info: AgentTaskInfo): Promise<void> {
    if (info.kind !== 'agent') return;
    if (info.agentId === undefined) return;
    if (info.status === 'completed') return;
    if (!this.isActive) return;
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const foreignOwner = await this.resolveForeignStoreOwner(store);
    if (foreignOwner !== undefined) {
      this.log.info('tower: skipping roster agent death mark — tower store is owned by another session', {
        event: 'TaskTerminatedNotice',
        agentId: info.agentId,
        sessionId: this.sessionCtx.sessionId,
        owner: foreignOwner,
        pid: process.pid,
      });
      return;
    }
    this.log.info('tower: marking roster agent died', {
      event: 'TaskTerminatedNotice',
      agentId: info.agentId,
      taskId: info.taskId,
      status: info.status,
      stopReason: info.stopReason,
      sessionId: this.sessionCtx.sessionId,
      pid: process.pid,
    });
    await store.markAgentDied(info.agentId, info.status, info.stopReason, this.sessionCtx.sessionId).then(
      () => undefined,
      () => undefined,
    );
  }

  private async clearTowerAgentDeath(agentId: string): Promise<void> {
    if (!this.isActive) return;
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const foreignOwner = await this.resolveForeignStoreOwner(store);
    if (foreignOwner !== undefined) {
      this.log.info('tower: skipping roster agent death clear — tower store is owned by another session', {
        event: 'SubagentStarted',
        agentId,
        sessionId: this.sessionCtx.sessionId,
        owner: foreignOwner,
        pid: process.pid,
      });
      return;
    }
    this.log.info('tower: clearing roster agent death mark', {
      event: 'SubagentStarted',
      agentId,
      sessionId: this.sessionCtx.sessionId,
      pid: process.pid,
    });
    await store.clearAgentDied(agentId, this.sessionCtx.sessionId).then(
      () => undefined,
      () => undefined,
    );
  }

  private async resolveForeignStoreOwner(store: TowerStore): Promise<string | undefined> {
    const owner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return owner !== undefined && owner !== this.sessionCtx.sessionId ? owner : undefined;
  }

  private inboxWakeItems: InboxWakeItem[] = [];
  private inboxWakeOmitted = 0;
  private inboxWakeLegacySequence = 0;
  private inboxWakeGeneration = 0;
  private readonly inboxWakeRecentKeys = new Set<string>();
  private inboxWakeScheduled = false;
  private inboxWakePending = false;
  private inboxWakeHandle: LoopNotifyHandle | undefined;
  private inboxWakeLastNotified: InboxWakeBatch | undefined;
  private inboxWakeDiscarding = false;
  private wakeDisposed = false;
  private wakeTurnId: number | undefined;
  private wakeTurnBatch: InboxWakeBatch | undefined;
  private wakeAbortedForUserPrompt = false;

  private onTowerInboxSent(event: TowerInboxSent): void {
    if (this.agentCtx.agentId !== 'main') return;
    if (!this.isActive) return;
    if (event.from === TOWER_NAME) return;
    if (event.to !== TOWER_NAME && event.to !== BROADCAST_NAME) return;
    let key: string;
    if (event.messageId !== undefined) {
      key = `id:${event.messageId}`;
    } else if (event.file !== undefined) {
      key = `file:${event.file}`;
    } else {
      this.inboxWakeLegacySequence += 1;
      key = `legacy:${String(this.inboxWakeLegacySequence)}`;
    }
    this.enqueueInboxWake({
      key,
      from: event.from,
      subject: event.subject,
      messageId: event.messageId,
      file: event.file,
      sentAt: event.sentAt,
      missionId: event.missionId,
    });
    this.scheduleInboxWake();
  }

  private enqueueInboxWake(item: InboxWakeItem, replay = false): void {
    if (this.inboxWakeItems.some((candidate) => candidate.key === item.key)) return;
    if (!replay && this.inboxWakeRecentKeys.has(item.key)) return;
    this.inboxWakeRecentKeys.add(item.key);
    if (this.inboxWakeRecentKeys.size > WAKE_TRACKED_KEY_LIMIT) {
      const oldest = this.inboxWakeRecentKeys.values().next().value;
      if (oldest !== undefined) this.inboxWakeRecentKeys.delete(oldest);
    }
    this.inboxWakeItems.push(item);
    if (this.inboxWakeItems.length > WAKE_BATCH_LIMIT) {
      this.inboxWakeItems.shift();
      this.inboxWakeOmitted += 1;
    }
  }

  private requeueInboxWake(batch: InboxWakeBatch): void {
    for (const item of batch.items) this.enqueueInboxWake(item, true);
    this.inboxWakeOmitted += batch.omitted;
  }

  private scheduleInboxWake(): void {
    if (this.inboxWakeScheduled || this.inboxWakePending || this.inboxWakeItems.length === 0) {
      return;
    }
    this.inboxWakeScheduled = true;
    queueMicrotask(() => {
      void this.flushInboxWake();
    });
  }

  private async flushInboxWake(): Promise<void> {
    this.inboxWakeScheduled = false;
    if (this.wakeDisposed || !this.isActive || this.loop === undefined) {
      this.inboxWakeItems = [];
      this.inboxWakeOmitted = 0;
      return;
    }
    if (this.inboxWakeItems.length === 0) return;
    const batch: InboxWakeBatch = {
      items: this.inboxWakeItems,
      omitted: this.inboxWakeOmitted,
    };
    this.inboxWakeItems = [];
    this.inboxWakeOmitted = 0;
    this.inboxWakeLastNotified = batch;
    this.inboxWakePending = true;
    const generation = this.inboxWakeGeneration;
    const text = await this.renderInboxWake(batch);
    if (
      generation !== this.inboxWakeGeneration ||
      this.wakeDisposed ||
      !this.isActive ||
      this.loop === undefined
    ) {
      if (generation === this.inboxWakeGeneration) this.inboxWakePending = false;
      return;
    }
    this.inboxWakeHandle = this.loop.notify({
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        toolCalls: [],
        origin: { kind: 'injection', variant: TOWER_INBOX_WAKE_VARIANT },
      },
      turnScoped: false,
      onConsume: () => {
        this.inboxWakeHandle = undefined;
        this.inboxWakePending = false;
        if (this.inboxWakeItems.length > 0) this.scheduleInboxWake();
      },
      onDrop: () => {
        this.inboxWakeHandle = undefined;
        this.inboxWakePending = false;
        if (this.inboxWakeDiscarding || this.wakeDisposed || !this.isActive) return;
        this.requeueInboxWake(batch);
        this.scheduleInboxWake();
      },
    });
  }

  private async renderInboxWake(batch: InboxWakeBatch): Promise<string> {
    const count = batch.items.length + batch.omitted;
    const countText =
      count === 1 ? '1 new tower inbox message' : `${String(count)} new tower inbox messages`;
    const lines = [
      `${countText} — ${String(batch.items.length)} reference(s), omitted=${String(batch.omitted)}. Read and route with TowerInbox; this wake does not acknowledge them.`,
    ];
    for (const item of batch.items) {
      const subject =
        item.subject.length > WAKE_SUBJECT_PREVIEW_MAX
          ? `${item.subject.slice(0, WAKE_SUBJECT_PREVIEW_MAX)}…`
          : item.subject;
      const references = [
        item.messageId !== undefined ? `messageId=${item.messageId}` : undefined,
        item.file !== undefined ? `file=${item.file}` : undefined,
        item.sentAt !== undefined ? `sentAt=${item.sentAt}` : undefined,
        item.missionId !== undefined ? `mission=${item.missionId}` : undefined,
      ].filter((reference) => reference !== undefined);
      lines.push(
        `- ${item.from}: "${subject}"${references.length > 0 ? ` (${references.join(', ')})` : ''}`,
      );
    }
    lines.push(...(await this.renderInboxWakeDigests(batch.items)));
    return lines.join('\n');
  }

  private async renderInboxWakeDigests(items: readonly InboxWakeItem[]): Promise<string[]> {
    const missionIds = [...new Set(items.flatMap((item) => item.missionId ?? []))];
    const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
    const state = await store.load().then(
      (loaded) => loaded,
      () => undefined,
    );
    const lines: string[] = [];
    if (state?.recoveredAt !== undefined) {
      lines.push(
        `⚠️ Tower state was recovered after a loss at ${state.recoveredAt} — missions, roster, and protocol history before that point are gone. Report the loss to the user instead of continuing silently.`,
      );
    }
    if (missionIds.length === 0) return lines;
    lines.push('Gate digest:');
    if (state === undefined) {
      for (const missionId of missionIds.slice(0, WAKE_DIGEST_LIMIT)) {
        lines.push(`- ${missionId}: gate=unavailable`);
      }
    } else {
      const activeAgentIds = this.activeAgentIds();
      for (const missionId of missionIds.slice(0, WAKE_DIGEST_LIMIT)) {
        const mission = state.missions.find((candidate) => candidate.id === missionId);
        if (mission === undefined) {
          lines.push(`- ${missionId}: gate=mission-missing`);
          continue;
        }
        if (mission.status === 'merged' || mission.status === 'abandoned') {
          lines.push(`- ${missionId}: gate=${mission.status}`);
          continue;
        }
        try {
          const gate = await store.missionGate(state, mission, { activeAgentIds });
          lines.push(
            gate.ready
              ? `- ${missionId}: gate=READY reasons=none${gate.reviewBinding === undefined ? '' : ` binding=${gate.reviewBinding}`}`
              : `- ${missionId}: gate=BLOCKED reasons=${gate.blocks.map((block) => block.reason).join(',')}`,
          );
        } catch {
          lines.push(`- ${missionId}: gate=unavailable`);
        }
      }
    }
    if (missionIds.length > WAKE_DIGEST_LIMIT) {
      lines.push(`- digest-omitted=${String(missionIds.length - WAKE_DIGEST_LIMIT)}`);
    }
    return lines;
  }

  private activeAgentIds(): ReadonlySet<string> | undefined {
    if (this.tasks === undefined) return undefined;
    return new Set(
      this.tasks
        .list(true)
        .flatMap((task) =>
          task.kind === 'agent' && task.agentId !== undefined ? [task.agentId] : [],
        ),
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
    if (!effective) this.dropInboxWake();
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
