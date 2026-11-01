import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { watchCandidates } from '#human/utils/watch';

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
export const workspaceDirsRegistryDirsKey = defineState<readonly string[]>(
  'workspaceDirs.registryDirs',
  () => [],
);
export const workspaceDirsPrimaryByWorkspaceKey = defineState<Readonly<Record<string, string>>>(
  'workspaceDirs.primaryByWorkspace',
  () => ({}),
);

export class WorkspaceDirsService implements IWorkspaceDirs {
  declare readonly _serviceBrand: undefined;

  private readonly disposables = new DisposableStore();
  private projectRoot: string;
  private configPath: string;
  private readonly legacyProjectConfig: boolean;
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private mutationTail: Promise<void> = Promise.resolve();
  private changeBatchDepth = 0;
  private changePending = false;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IWorkspacePersistence private readonly workspaceStore: IWorkspacePersistence,
    @ILogService private readonly log: ILogService,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
  ) {
    this.states.contributeState(workspaceDirsFileDirsKey);
    this.states.contributeState(workspaceDirsEphemeralDirsKey);
    this.states.contributeState(workspaceDirsRegistryDirsKey);
    this.states.contributeState(workspaceDirsPrimaryByWorkspaceKey);
    this.projectRoot = workspace.cwd;
    this.configPath = '';
    this.legacyProjectConfig = workspace.meta.kind !== 'managed';
    this.ready = this.enqueue(() =>
      this.batchChanges(async () => {
        if (this.legacyProjectConfig) await this.reloadFromDisk();
        await this.reloadFromRegistry();
      }),
    );
    if (this.legacyProjectConfig) void this.ready.then(() => this.watchLocalToml());
    this._register(
      this.workspaceStore.onDidChange(() => {
        void this.enqueue(() => this.reloadFromRegistry()).catch((error) => {
          this.log.warn(`workspace registry reload failed: ${String(error)}`);
        });
      }),
    );
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

  private get registryDirs(): readonly string[] {
    return this.states.get(workspaceDirsRegistryDirsKey);
  }

  private set registryDirs(value: readonly string[]) {
    this.states.set(workspaceDirsRegistryDirsKey, value);
  }

  get primaryByWorkspace(): Readonly<Record<string, string>> {
    return this.states.get(workspaceDirsPrimaryByWorkspaceKey);
  }

  private set primaryByWorkspace(value: Readonly<Record<string, string>>) {
    this.states.set(workspaceDirsPrimaryByWorkspaceKey, value);
  }

  get sharedAdditionalDirs(): readonly string[] {
    return [...new Set([...this.fileDirs, ...this.registryDirs])];
  }

  get additionalDirs(): readonly string[] {
    return [...new Set([...this.sharedAdditionalDirs, ...this.ephemeralDirs])];
  }

  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult> {
    return this.enqueue(() => this.applyAddDir(input));
  }

  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void> {
    if (dirs.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      const resolved = await this.localConfig.resolveAdditionalDirs(baseDir, dirs);
      if (this.unionEphemeral(resolved)) this.fireChange();
    });
  }

  reload(): Promise<void> {
    return this.enqueue(() =>
      this.batchChanges(async () => {
        if (this.legacyProjectConfig) await this.reloadFromDisk();
        await this.reloadFromRegistry();
      }),
    );
  }

  sessionInfo(): ISessionWorkspaceInfo {
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

  private async applyAddDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult> {
    const persist = input.persist ?? true;
    const onDisk = await this.localConfig.readAdditionalDirs(this.workspace.cwd);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;

    if (persist) {
      const resolved = await this.localConfig.resolveAdditionalDirs(this.workspace.cwd, [
        input.path,
      ]);
      const dir = resolved[0];
      if (dir === undefined) {
        throw new Error(`additional dir ${input.path} did not resolve`);
      }
      const existing = await this.workspaces.get(this.workspace.workspaceId);
      const target = existing ?? (await this.workspaces.createOrTouch(this.workspace.cwd));
      const dirKey = workspaceRootKey(dir);
      const inSet =
        workspaceRootKey(target.root) === dirKey ||
        target.additionalDirs.some((kept) => workspaceRootKey(kept) === dirKey);
      if (!inSet) {
        await this.workspaces.update(target.id, {
          additionalDirs: [...target.additionalDirs, dir],
        });
        await this.reloadFromRegistry();
      }
      return {
        projectRoot: onDisk.projectRoot,
        configPath: onDisk.configPath,
        additionalDirs: this.additionalDirs,
        persisted: true,
      };
    }

    const resolved = await this.localConfig.resolveAdditionalDirs(this.workspace.cwd, [
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
    const onDisk = await this.localConfig.readAdditionalDirs(this.workspace.cwd);
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
    const registered = await this.workspaces.list();
    const current = this.workspace.meta.kind === 'managed'
      ? undefined
      : await this.workspaces.get(this.workspace.workspaceId);
    const entries =
      this.workspace.meta.kind === 'managed'
        ? registered.filter((entry) => entry.id === this.workspace.workspaceId)
        : current === undefined
          ? registered
          : [current, ...registered.filter((entry) => entry.id !== current.id)];
    const cwdKey = workspaceRootKey(this.workspace.cwd);
    const dirs: string[] = [];
    const primary: Record<string, string> = {};
    for (const entry of entries) {
      const set = [entry.root, ...entry.additionalDirs];
      if (!set.some((dir) => workspaceRootKey(dir) === cwdKey)) continue;
      primary[entry.id] = entry.root;
      for (const dir of set) {
        if (workspaceRootKey(dir) === cwdKey) continue;
        if (dirs.some((kept) => workspaceRootKey(kept) === workspaceRootKey(dir))) continue;
        dirs.push(dir);
      }
    }
    const beforeDirs = this.sharedAdditionalDirs;
    const beforePrimary = this.primaryByWorkspace;
    this.registryDirs = dirs;
    this.primaryByWorkspace = primary;
    if (
      !sameStringList(beforeDirs, this.sharedAdditionalDirs) ||
      !samePrimaryByWorkspace(beforePrimary, primary)
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

  private _register<T extends IDisposable>(disposable: T): T {
    return this.disposables.add(disposable);
  }

  async dispose(): Promise<void> {
    this.disposables.dispose();
    let pending: Promise<void>;
    do {
      pending = this.mutationTail;
      await pending;
    } while (pending !== this.mutationTail);
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

function samePrimaryByWorkspace(
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
        workspaceRootKey(aRoot) === workspaceRootKey(bRoot)
      );
    })
  );
}

