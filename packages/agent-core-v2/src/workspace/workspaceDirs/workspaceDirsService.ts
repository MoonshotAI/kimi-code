/**
 * `workspaceDirs` domain — `IWorkspaceDirs` implementation.
 *
 * Holds the handler-shared additional-directory set as
 * `fileDirs ∪ ephemeralDirs`: `fileDirs` is the project-local
 * `.kimi-code/local.toml` set (loaded once per handler through
 * `projectLocalConfig`, reloaded debounced when the fs watch sees the file
 * change — including writes from OTHER processes), `ephemeralDirs` is the
 * in-memory union of non-persisted `addDir` calls and caller-provided dirs
 * from session create/resume options (it dies with the handler). Every
 * mutation serializes on one tail queue; the change event fires only when
 * the combined list actually changed. The set reaches every session of the
 * handler through the `ISessionWorkspaceInfo` seed (`sessionInfo()`), a
 * live read view over this service. The plain-data state (`fileDirs`,
 * `ephemeralDirs`) is registered into `workspaceState`
 * (`IWorkspaceStateService`) and read/written through it. Bound at
 * Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import {
  IWorkspaceDirs,
  type WorkspaceAddDirInput,
  type WorkspaceAdditionalDirsResult,
} from './workspaceDirs';

const WATCH_DEBOUNCE_MS = 200;

export const workspaceDirsFileDirsKey = defineState<readonly string[]>(
  'workspaceDirs.fileDirs',
  () => [],
);
export const workspaceDirsEphemeralDirsKey = defineState<readonly string[]>(
  'workspaceDirs.ephemeralDirs',
  () => [],
);

export class WorkspaceDirsService extends Disposable implements IWorkspaceDirs {
  declare readonly _serviceBrand: undefined;

  private projectRoot: string;
  private configPath: string;
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @ILogService private readonly log: ILogService,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
  ) {
    super();
    this.states.register(workspaceDirsFileDirsKey);
    this.states.register(workspaceDirsEphemeralDirsKey);
    this.projectRoot = workspace.cwd;
    this.configPath = '';
    this.ready = this.enqueue(() => this.reloadFromDisk());
    void this.ready.then(() => this.watchLocalToml());
  }

  private get fileDirs(): readonly string[] {
    return this.states.get(workspaceDirsFileDirsKey);
  }

  private set fileDirs(value: readonly string[]) {
    this.states.set(workspaceDirsFileDirsKey, value);
  }

  private get ephemeralDirs(): readonly string[] {
    return this.states.get(workspaceDirsEphemeralDirsKey);
  }

  private set ephemeralDirs(value: readonly string[]) {
    this.states.set(workspaceDirsEphemeralDirsKey, value);
  }

  get additionalDirs(): readonly string[] {
    return [...new Set([...this.fileDirs, ...this.ephemeralDirs])];
  }

  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult> {
    return this.enqueue(() => this.applyAddDir(input));
  }

  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void> {
    if (dirs.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      const resolved = await this.localConfig.resolveAdditionalDirs(baseDir, dirs);
      if (this.unionEphemeral(resolved)) {
        this.onDidChangeEmitter.fire();
      }
    });
  }

  sessionInfo(): ISessionWorkspaceInfo {
    const currentDirs = (): readonly string[] => this.additionalDirs;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get additionalDirs() {
        return currentDirs();
      },
    };
  }

  private async applyAddDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult> {
    const persist = input.persist ?? true;

    if (persist) {
      const persisted = await this.localConfig.appendAdditionalDir(
        this.workspace.cwd,
        input.path,
      );
      this.projectRoot = persisted.projectRoot;
      this.configPath = persisted.configPath;
      const changed = this.setFileDirs(persisted.additionalDirs);
      if (changed) {
        this.onDidChangeEmitter.fire();
      }
      return {
        projectRoot: persisted.projectRoot,
        configPath: persisted.configPath,
        additionalDirs: this.additionalDirs,
        persisted: true,
      };
    }

    const onDisk = await this.localConfig.readAdditionalDirs(this.workspace.cwd);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;
    const resolved = await this.localConfig.resolveAdditionalDirs(this.workspace.cwd, [
      input.path,
    ]);
    const changed = this.unionEphemeral(resolved);
    if (changed) {
      this.onDidChangeEmitter.fire();
    }
    return {
      projectRoot: onDisk.projectRoot,
      configPath: onDisk.configPath,
      additionalDirs: this.additionalDirs,
      persisted: false,
    };
  }

  private async reloadFromDisk(): Promise<void> {
    const onDisk = await this.localConfig.readAdditionalDirs(this.workspace.cwd);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;
    if (this.setFileDirs(onDisk.additionalDirs)) {
      this.onDidChangeEmitter.fire();
    }
  }

  private setFileDirs(dirs: readonly string[]): boolean {
    const before = this.additionalDirs;
    this.fileDirs = dirs;
    return !sameStringList(before, this.additionalDirs);
  }

  private unionEphemeral(dirs: readonly string[]): boolean {
    const before = this.additionalDirs;
    this.ephemeralDirs = [...new Set([...this.ephemeralDirs, ...dirs])];
    return !sameStringList(before, this.additionalDirs);
  }

  private watchLocalToml(): void {
    try {
      const handle = this.fsWatch.watch(this.projectRoot, {
        recursive: true,
        ignored: subtreeWatchFilter(this.projectRoot, [this.configPath]),
      });
      this._register(handle);
      this._register(
        handle.onDidChange(() => {
          this.watchDebounce.cancelAndSet(() => {
            void this.enqueue(() => this.reloadFromDisk()).catch((error) => {
              this.log.warn(`local.toml reload failed: ${String(error)}`);
            });
          }, WATCH_DEBOUNCE_MS);
        }),
      );
    } catch (error) {
      this.log.warn(`cannot watch project-local config ${this.configPath}: ${String(error)}`);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(work, work);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceDirs,
  WorkspaceDirsService,
  ScopeActivation.OnScopeCreated,
  'workspaceDirs',
);
