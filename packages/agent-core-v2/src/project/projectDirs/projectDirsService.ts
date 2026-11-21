import { DisposableStore, MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { SerialQueue } from '#/_base/utils/serialQueue';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { sameDir } from '#/_base/utils/workdir-slug';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IProjectService } from '#/app/project/project';
import { IProjectPersistence } from '#/app/project/projectPersistence';
import type { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';
import { IProjectStateService } from '#/project/state/projectState';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { watchCandidates } from '#human/utils/watch';

import { registryDirSet } from './registryDirSet';
import {
  IProjectDirs,
  type ProjectAddDirInput,
  type ProjectAdditionalDirsResult,
} from './projectDirs';

const WATCH_DEBOUNCE_MS = 200;

export const projectDirsFileDirsKey = defineState<readonly string[]>(
  'workspaceDirs.fileDirs',
  () => [],
);
export const projectDirsEphemeralDirsKey = defineState<readonly string[]>(
  'workspaceDirs.ephemeralDirs',
  () => [],
);
export const projectDirsRegistryDirsKey = defineState<readonly string[]>(
  'workspaceDirs.registryDirs',
  () => [],
);
export const projectDirsPrimaryByProjectKey = defineState<Readonly<Record<string, string>>>(
  'workspaceDirs.primaryByWorkspace',
  () => ({}),
);

export class ProjectDirsService implements IProjectDirs {
  declare readonly _serviceBrand: undefined;

  private readonly disposables = new DisposableStore();
  private projectRoot: string;
  private configPath: string;
  private readonly legacyProjectConfig: boolean;
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly localConfigWatcher = this._register(new MutableDisposable<IDisposable>());
  private readonly mutations = new SerialQueue();
  private registryReloadQueued = false;
  private changeBatchDepth = 0;
  private changePending = false;

  constructor(
    @IProjectContext private readonly project: IProjectContext,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @IProjectService private readonly projects: IProjectService,
    @IProjectPersistence private readonly projectStore: IProjectPersistence,
    @ILogService private readonly log: ILogService,
    @IProjectStateService private readonly states: IProjectStateService,
    private readonly environmentId = LOCAL_ENVIRONMENT_ID,
    private readonly followsPrimary = environmentId === LOCAL_ENVIRONMENT_ID,
  ) {
    this.states.contributeState(projectDirsFileDirsKey);
    this.states.contributeState(projectDirsEphemeralDirsKey);
    this.states.contributeState(projectDirsRegistryDirsKey);
    this.states.contributeState(projectDirsPrimaryByProjectKey);
    this.projectRoot = project.cwd;
    this.configPath = '';
    this.legacyProjectConfig = project.meta.kind !== 'managed';
    this.ready = this.mutations.run(() => this.reloadWorkspace(true));
    this._register(
      this.projectStore.onDidChange(() => {
        if (this.registryReloadQueued) return;
        this.registryReloadQueued = true;
        void this.mutations.run(async () => {
          this.registryReloadQueued = false;
          await this.reloadWorkspace();
        }).catch((error) => {
          this.log.warn(`workspace registry reload failed: ${String(error)}`);
        });
      }),
    );
  }

  private get fileDirs(): readonly string[] {
    return this.states.get(projectDirsFileDirsKey);
  }

  private set fileDirs(value: readonly string[]) {
    this.states.set(projectDirsFileDirsKey, value);
  }

  private get ephemeralDirs(): readonly string[] {
    return this.states.get(projectDirsEphemeralDirsKey);
  }

  private set ephemeralDirs(value: readonly string[]) {
    this.states.set(projectDirsEphemeralDirsKey, value);
  }

  private get registryDirs(): readonly string[] {
    return this.states.get(projectDirsRegistryDirsKey);
  }

  private set registryDirs(value: readonly string[]) {
    this.states.set(projectDirsRegistryDirsKey, value);
  }

  get primaryByWorkspace(): Readonly<Record<string, string>> {
    return this.states.get(projectDirsPrimaryByProjectKey);
  }

  private set primaryByWorkspace(value: Readonly<Record<string, string>>) {
    this.states.set(projectDirsPrimaryByProjectKey, value);
  }

  get primary(): string {
    if (this.environmentId !== LOCAL_ENVIRONMENT_ID || !this.followsPrimary) return this.project.cwd;
    return this.primaryByWorkspace[this.project.workspaceId] ?? this.project.meta.root;
  }

  get sharedAdditionalDirs(): readonly string[] {
    return [...new Set([...this.fileDirs, ...this.registryDirs])];
  }

  get additionalDirs(): readonly string[] {
    return [...new Set([...this.sharedAdditionalDirs, ...this.ephemeralDirs])];
  }

  addDir(input: ProjectAddDirInput): Promise<ProjectAdditionalDirsResult> {
    return this.mutations.run(() => this.applyAddDir(input));
  }

  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void> {
    if (dirs.length === 0) return Promise.resolve();
    return this.mutations.run(async () => {
      const resolved = await this.localConfig.resolveAdditionalDirs(baseDir, dirs);
      if (this.unionEphemeral(resolved)) this.fireChange();
    });
  }

  reload(): Promise<void> {
    return this.mutations.run(() => this.reloadWorkspace(true));
  }

  private async reloadWorkspace(reloadLocal = false): Promise<void> {
    await this.batchChanges(async () => {
      const previousPrimary = this.primary;
      await this.reloadFromRegistry();
      if (!this.legacyProjectConfig) return;
      const primaryChanged = previousPrimary !== this.primary;
      if (reloadLocal || primaryChanged || this.localConfigWatcher.value === undefined) {
        await this.reloadFromDisk();
      }
      if (primaryChanged || this.localConfigWatcher.value === undefined) {
        this.watchLocalToml();
      }
    });
  }

  sessionInfo(): ISessionProjectInfo {
    const currentDirs = (): readonly string[] => this.additionalDirs;
    const currentPrimary = (): Readonly<Record<string, string>> => this.primaryByWorkspace;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get additionalDirs() {
        return currentDirs();
      },
      get primaryByWorkspace() {
        return currentPrimary();
      },
    };
  }

  private async applyAddDir(input: ProjectAddDirInput): Promise<ProjectAdditionalDirsResult> {
    const persist = input.persist ?? true;
    const onDisk = await this.localConfig.readAdditionalDirs(this.primary);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;

    if (persist) {
      const resolved = await this.localConfig.resolveAdditionalDirs(this.primary, [
        input.path,
      ]);
      const dir = resolved[0];
      if (dir === undefined) {
        throw new Error(`additional dir ${input.path} did not resolve`);
      }
      const existing = await this.projects.get(this.project.workspaceId);
      const target = existing ?? (await this.projects.reviveImplicit(this.project.workspaceId, this.project.cwd));
      const inSet = [target.root, ...target.additionalDirs].some((kept) => sameDir(kept, dir));
      if (!inSet) {
        await this.projects.update(target.id, {
          additionalDirs: [...target.additionalDirs, dir],
        });
        await this.reloadWorkspace(true);
      }
      return {
        projectRoot: onDisk.projectRoot,
        configPath: onDisk.configPath,
        additionalDirs: this.additionalDirs,
        persisted: true,
      };
    }

    const resolved = await this.localConfig.resolveAdditionalDirs(this.primary, [
      input.path,
    ]);
    const changed = this.unionEphemeral(resolved);
    if (changed) this.fireChange();
    return {
      projectRoot: onDisk.projectRoot,
      configPath: onDisk.configPath,
      additionalDirs: this.additionalDirs,
      persisted: false,
    };
  }

  private async reloadFromDisk(): Promise<void> {
    const onDisk = await this.localConfig.readAdditionalDirs(this.primary);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;
    if (this.setFileDirs(onDisk.additionalDirs)) this.fireChange();
  }

  private setFileDirs(dirs: readonly string[]): boolean {
    const before = this.sharedAdditionalDirs;
    this.fileDirs = dirs;
    return !sameStringList(before, this.sharedAdditionalDirs);
  }

  private async reloadFromRegistry(): Promise<void> {
    const registered = await this.projects.list();
    const managed = this.project.meta.kind === 'managed';
    const next = registryDirSet({
      project: managed
        ? registered.find((entry) => entry.id === this.project.workspaceId)
        : await this.projects.get(this.project.workspaceId),
      others: managed ? [] : registered,
      cwd: this.project.cwd,
      local: this.environmentId === LOCAL_ENVIRONMENT_ID,
      followsPrimary: this.followsPrimary,
    });
    const beforeDirs = this.sharedAdditionalDirs;
    const beforePrimary = this.primaryByWorkspace;
    this.registryDirs = next.registryDirs;
    this.primaryByWorkspace = next.primaryByWorkspace;
    if (
      !sameStringList(beforeDirs, this.sharedAdditionalDirs) ||
      !samePrimaryByProject(beforePrimary, next.primaryByWorkspace)
    ) {
      this.fireChange();
    }
  }

  private unionEphemeral(dirs: readonly string[]): boolean {
    const before = this.additionalDirs;
    this.ephemeralDirs = [...new Set([...this.ephemeralDirs, ...dirs])];
    return !sameStringList(before, this.additionalDirs);
  }

  private fireChange(): void {
    if (this.changeBatchDepth > 0) {
      this.changePending = true;
      return;
    }
    this.onDidChangeEmitter.fire();
  }

  private async batchChanges(work: () => Promise<void>): Promise<void> {
    this.changeBatchDepth += 1;
    try {
      await work();
    } finally {
      this.changeBatchDepth -= 1;
      if (this.changeBatchDepth === 0 && this.changePending) {
        this.changePending = false;
        this.onDidChangeEmitter.fire();
      }
    }
  }

  private watchLocalToml(): void {
    try {
      const handle = watchCandidates(this.projectRoot, [this.configPath], {
        ignored: subtreeWatchFilter(this.projectRoot, [this.configPath]),
      });
      const subscription = handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => {
          void this.mutations.run(() => this.reloadFromDisk()).catch((error) => {
            this.log.warn(`local.toml reload failed: ${String(error)}`);
          });
        }, WATCH_DEBOUNCE_MS);
      });
      const watchers = new DisposableStore();
      watchers.add(handle);
      watchers.add(subscription);
      this.localConfigWatcher.value = watchers;
    } catch (error) {
      this.log.warn(`cannot watch project-local config ${this.configPath}: ${String(error)}`);
    }
  }

  private _register<T extends IDisposable>(disposable: T): T {
    return this.disposables.add(disposable);
  }

  async dispose(): Promise<void> {
    this.disposables.dispose();
    await this.mutations.drain();
  }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function samePrimaryByProject(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aIds = Object.keys(a);
  const bIds = Object.keys(b);
  return (
    aIds.length === bIds.length &&
    aIds.every((id) => {
      const aRoot = a[id];
      const bRoot = b[id];
      return (
        bRoot !== undefined &&
        aRoot !== undefined &&
        sameDir(aRoot, bRoot)
      );
    })
  );
}

