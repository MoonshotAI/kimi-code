import { normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { sameDir } from '#/_base/utils/workdir-slug';
import { IAgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifier';
import { changeNotifierSnapshotKey } from '#/agent/changeNotifier/changeNotifierOps';
import { isCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import type { WorkdirMoveBaseline } from '#/agent/environmentBinding/environmentBindingOps';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  extractAgentsMdPathsFromSystemPrompt,
  findProjectRoot,
  loadAgentsMdForRoots,
  splitAgentsMdFiles,
} from '#/agent/profile/context';
import type { ProfileData } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type {
  ContextInjectionContext,
  ContextInjectionResult,
} from '#/features/reminder/types';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import {
  IAgentWorkdirMoveService,
  WORKDIR_MOVED_REMINDER_VARIANT,
  type PreparedWorkdirRelocation,
  type PrepareWorkdirRelocationInput,
  type WorkdirMovedDisclosure,
} from './workdirMove';
import { workdirMoveStateKey, type WorkdirMoveState } from './workdirMoveOps';
import {
  buildWorkdirMovedReminder,
  extractProjectAgentsMdFiles,
  globalAgentsMdPaths,
  overlaySnapshotHashes,
  selectWorkdirMoveBaseline,
} from './workdirMoveReminder';

export class AgentWorkdirMoveService extends Disposable implements IAgentWorkdirMoveService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @IAgentEnvironmentBindingService private readonly environmentBinding: IAgentEnvironmentBindingService,
    @IAgentChangeNotifierService private readonly changeNotifier: IAgentChangeNotifierService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IHostFileSystem private readonly localFs: IHostFileSystem,
    @IHostEnvironment private readonly localEnvironment: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this.states.contributeState(workdirMoveStateKey);
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      this._register(
        this.reminder.register<WorkdirMovedDisclosure>(
          WORKDIR_MOVED_REMINDER_VARIANT,
          (context) => this.provideReminder(context),
        ),
      );
    }
  }

  private get state(): WorkdirMoveState {
    return this.states.get(workdirMoveStateKey);
  }

  get originCwd(): string | undefined {
    return this.state.originCwd;
  }

  async prepareRelocation(input: PrepareWorkdirRelocationInput): Promise<PreparedWorkdirRelocation> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return {};
    const profileData = this.loop.data();
    if (profileData.profileName === undefined && profileData.systemPrompt === '') {
      return {};
    }

    const previousOriginCwd = this.state.originCwd;
    const previousPendingBaseline = this.state.pendingBaseline;
    const snapshotFiles = this.readSnapshotFiles();
    const globals = globalAgentsMdPaths(this.localEnvironment.homeDir, this.bootstrap.homeDir);
    const [oldCheckoutRoot, nextAgentsMd] = await Promise.all([
      findProjectRoot({ fs: this.localFs }, input.oldWorkDir),
      loadAgentsMdForRoots(
        { fs: this.localFs, homeDir: this.localEnvironment.homeDir },
        this.bootstrap.homeDir,
        [input.nextWorkDir],
        this.localFs,
      ),
    ]);

    await this.changeNotifier.syncAgentsMdSnapshot(nextAgentsMd);

    const originCwd =
      previousOriginCwd ??
      nonEmptyCwd(profileData.environmentDisclosure?.cwd) ??
      normalize(input.oldWorkDir);

    const lastDisclosure = this.latestDisclosure();
    const oldWasDisclosed =
      lastDisclosure !== undefined
        ? sameDir(lastDisclosure.cwd, input.oldWorkDir)
        : previousPendingBaseline === undefined;

    if (!oldWasDisclosed && previousPendingBaseline !== undefined) {
      return {
        originCwd,
        pendingBaseline: previousPendingBaseline,
        previousOriginCwd,
        previousPendingBaseline,
      };
    }

    const baseProjectFiles =
      lastDisclosure !== undefined && sameDir(lastDisclosure.cwd, input.oldWorkDir)
        ? lastDisclosure.projectAgentsMd
        : this.promptProjectBeliefs(profileData, oldCheckoutRoot, globals);

    const pendingBaseline: WorkdirMoveBaseline = {
      cwd: normalize(input.oldWorkDir),
      checkoutRoot: oldCheckoutRoot,
      projectAgentsMd: overlaySnapshotHashes(
        baseProjectFiles,
        snapshotFiles,
        oldCheckoutRoot,
        globals,
      ),
    };

    return {
      originCwd,
      pendingBaseline,
      previousOriginCwd,
      previousPendingBaseline,
    };
  }

  async restoreAgentsMdSnapshot(workDir: string): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    const loaded = await loadAgentsMdForRoots(
      { fs: this.localFs, homeDir: this.localEnvironment.homeDir },
      this.bootstrap.homeDir,
      [workDir],
      this.localFs,
    );
    await this.changeNotifier.syncAgentsMdSnapshot(loaded);
  }

  private async provideReminder(
    context: ContextInjectionContext<WorkdirMovedDisclosure>,
  ): Promise<ContextInjectionResult<WorkdirMovedDisclosure> | undefined> {
    if (this.environmentBinding.current.environmentId !== LOCAL_ENVIRONMENT_ID) {
      return undefined;
    }
    const profileData = this.loop.data();
    if (profileData.profileName === undefined && profileData.systemPrompt === '') {
      return undefined;
    }
    const state = this.state;
    if (state.originCwd === undefined && state.pendingBaseline === undefined) {
      return undefined;
    }

    const currentCwd = normalize(this.environment.workspaceRoots().workDir);
    const globals = globalAgentsMdPaths(this.localEnvironment.homeDir, this.bootstrap.homeDir);
    const originCwd =
      state.originCwd ??
      nonEmptyCwd(profileData.environmentDisclosure?.cwd) ??
      currentCwd;
    const originCheckoutRoot =
      state.pendingBaseline !== undefined && sameDir(state.pendingBaseline.cwd, originCwd)
        ? state.pendingBaseline.checkoutRoot
        : await findProjectRoot({ fs: this.localFs }, originCwd);

    const promptBaseline: WorkdirMoveBaseline = {
      cwd: originCwd,
      checkoutRoot: originCheckoutRoot,
      projectAgentsMd: this.promptProjectBeliefs(profileData, originCheckoutRoot, globals),
    };

    const hasCompactionSummary = this.loop.history().some(isCompactionSummaryMessage);
    const baseline = selectWorkdirMoveBaseline({
      state,
      lastDisclosure: context.lastDisclosure,
      hasCompactionSummary,
      promptBaseline,
    });
    if (baseline === undefined || sameDir(baseline.cwd, currentCwd)) {
      return undefined;
    }

    const [currentCheckoutRoot, fresh] = await Promise.all([
      findProjectRoot({ fs: this.localFs }, currentCwd),
      loadAgentsMdForRoots(
        { fs: this.localFs, homeDir: this.localEnvironment.homeDir },
        this.bootstrap.homeDir,
        [currentCwd],
        this.localFs,
      ),
    ]);
    const currentProjectFiles = extractProjectAgentsMdFiles(
      fresh.files,
      currentCheckoutRoot,
      globals,
    );

    return buildWorkdirMovedReminder({
      baseline,
      currentCwd,
      currentCheckoutRoot,
      currentProjectFiles,
    });
  }

  private promptProjectBeliefs(
    profileData: ProfileData,
    checkoutRoot: string,
    globals: ReadonlySet<string>,
  ) {
    const paths =
      profileData.agentsMdPaths ?? extractAgentsMdPathsFromSystemPrompt(profileData.systemPrompt);
    const files = splitAgentsMdFiles(profileData.systemPrompt, paths);
    return extractProjectAgentsMdFiles(files, checkoutRoot, globals).map(
      ({ relativePath, path, hash }) => ({ relativePath, path, hash }),
    );
  }

  private latestDisclosure(): WorkdirMovedDisclosure | undefined {
    const history = this.loop.history();
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const origin = history[index]?.origin;
      if (origin?.kind === 'injection' && origin.variant === WORKDIR_MOVED_REMINDER_VARIANT) {
        return origin.disclosure as WorkdirMovedDisclosure | undefined;
      }
    }
    return undefined;
  }

  private readSnapshotFiles(): Readonly<Record<string, string>> | undefined {
    try {
      return this.states.get(changeNotifierSnapshotKey).agentsMdFiles;
    } catch {
      return undefined;
    }
  }
}

function nonEmptyCwd(cwd: string | undefined): string | undefined {
  return cwd !== undefined && cwd !== '' ? normalize(cwd) : undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWorkdirMoveService,
  AgentWorkdirMoveService,
  ScopeActivation.OnScopeCreated,
  'workdirMove',
);
