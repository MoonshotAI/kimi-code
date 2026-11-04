import { isAbsolute, resolve } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IEnvironmentService } from '#/app/environment/environment';
import { IWorkspaceService, type Workspace, type WorkspaceEnvironmentDir, workspaceDirectories } from '#/app/workspace/workspace';
import type { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { normalizeRemoteCwd, requireEnvironmentDirectory } from '#/environment/environmentDefaults';
import { EnvironmentError } from '#/environment/environmentRegistry';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import type { IWorkspaceEnvironmentDirs, WorkspaceAddEnvironmentDirInput } from './workspaceEnvironmentDirs';

export class WorkspaceEnvironmentDirsService extends Disposable implements IWorkspaceEnvironmentDirs {
  private readonly changeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changeEmitter.event;
  readonly ready: Promise<void>;
  private registryDirs: readonly WorkspaceEnvironmentDir[] = [];
  private ephemeralDirs: readonly WorkspaceEnvironmentDir[] = [];
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: IWorkspaceContext,
    private readonly workspaces: IWorkspaceService,
    store: IWorkspacePersistence,
    private readonly environments: IEnvironmentService,
    private readonly log: ILogService,
  ) {
    super();
    this.ready = this.enqueue(() => this.reloadFromRegistry());
    this._register(
      store.onDidChange(() => {
        void this.enqueue(() => this.reloadFromRegistry()).catch((error) => {
          this.log.warn(`workspace environment dirs reload failed: ${String(error)}`);
        });
      }),
    );
  }

  get dirs(): readonly WorkspaceEnvironmentDir[] {
    return this.directories.filter((dir) => dir.environmentId !== LOCAL_ENVIRONMENT_ID);
  }

  get directories(): readonly WorkspaceEnvironmentDir[] {
    return [
      ...this.registryDirs,
      ...this.ephemeralDirs.filter((dir) => !this.registryDirs.some((kept) => kept.environmentId === dir.environmentId && kept.path === dir.path)),
    ];
  }

  add(input: WorkspaceAddEnvironmentDirInput): Promise<WorkspaceEnvironmentDir> {
    return this.enqueue(() => this.applyAdd(input));
  }

  private async applyAdd(input: WorkspaceAddEnvironmentDirInput): Promise<WorkspaceEnvironmentDir> {
    const dir: WorkspaceEnvironmentDir = {
      environmentId: input.environmentId,
      path: normalizeEnvironmentDir(input.environmentId, input.path),
    };
    const existing = this.directories.some((kept) => kept.environmentId === dir.environmentId && kept.path === dir.path);
    const persisted = this.registryDirs.some((kept) => kept.environmentId === dir.environmentId && kept.path === dir.path);
    if (existing && (persisted || input.persist !== true)) return dir;
    await requireEnvironmentDirectory(this.environments, dir.environmentId, dir.path);
    if (input.persist === true) {
      const target = (await this.record()) ?? (await this.workspaces.createOrTouch(this.context.cwd));
      await this.workspaces.update(target.id, { directories: [...workspaceDirectories(target), dir] });
      this.ephemeralDirs = this.ephemeralDirs.filter((kept) => kept.environmentId !== dir.environmentId || kept.path !== dir.path);
      await this.reloadFromRegistry();
      return dir;
    }
    this.ephemeralDirs = [...this.ephemeralDirs, dir];
    this.changeEmitter.fire();
    return dir;
  }

  private async reloadFromRegistry(): Promise<void> {
    const record = await this.record();
    const next = record === undefined ? [] : workspaceDirectories(record);
    if (sameDirs(this.registryDirs, next)) return;
    this.registryDirs = next;
    this.changeEmitter.fire();
  }

  private async record(): Promise<Workspace | undefined> {
    const byId = await this.workspaces.get(this.context.workspaceId);
    if (byId !== undefined || this.context.meta.kind === 'managed') return byId;
    const cwdKey = workspaceRootKey(this.context.cwd);
    return (await this.workspaces.list()).find((entry) => workspaceRootKey(entry.root) === cwdKey);
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

function normalizeEnvironmentDir(environmentId: string, path: string): string {
  if (environmentId !== LOCAL_ENVIRONMENT_ID) return normalizeRemoteCwd(path);
  if (!isAbsolute(path)) {
    throw new EnvironmentError('environment.invalid_cwd', `directory ${path} for environment ${environmentId} must be an absolute path`);
  }
  return resolve(path);
}

function sameDirs(a: readonly WorkspaceEnvironmentDir[], b: readonly WorkspaceEnvironmentDir[]): boolean {
  return a.length === b.length && a.every((dir, index) => dir.environmentId === b[index]?.environmentId && dir.path === b[index]?.path);
}
