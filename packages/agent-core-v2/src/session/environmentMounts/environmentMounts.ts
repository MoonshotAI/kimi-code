import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { SKILL_SOURCE_PRIORITY } from '#/features/skill/catalog/skillSource';
import type { SkillDefinition } from '#/features/skill/catalog/types';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkdir, type SessionEnvironmentWorkdir } from '#/session/workdir/workdir';

export type EnvironmentMount =
  | { readonly status: 'mounted'; readonly agentsMdPaths: readonly string[] }
  | { readonly status: 'failed'; readonly error: string };

export interface ISessionEnvironmentMounts {
  readonly _serviceBrand: undefined;
  mount(environmentId: string, cwd: string): Promise<EnvironmentMount>;
  unmount(environmentId: string, mount: Promise<EnvironmentMount>): void;
}

export const ISessionEnvironmentMounts: ServiceIdentifier<ISessionEnvironmentMounts> =
  createDecorator<ISessionEnvironmentMounts>('sessionEnvironmentMounts');

export function environmentSkillName(name: string, environmentId: string): string {
  return `${name}@${environmentId}`;
}

interface MountHandle {
  released: boolean;
  workdir?: SessionEnvironmentWorkdir;
  contributed: boolean;
}

interface MountEntry {
  readonly result: Promise<EnvironmentMount>;
  readonly handle: MountHandle;
}

export class SessionEnvironmentMountsService extends Disposable implements ISessionEnvironmentMounts {
  declare readonly _serviceBrand: undefined;

  private readonly mounts = new Map<string, MountEntry>();

  constructor(
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
  ) {
    super();
    this._register(toDisposable(() => {
      for (const { handle } of this.mounts.values()) {
        handle.released = true;
        handle.workdir?.dispose();
      }
      this.mounts.clear();
    }));
  }

  mount(environmentId: string, cwd: string): Promise<EnvironmentMount> {
    const existing = this.mounts.get(environmentId);
    if (existing !== undefined) return existing.result;
    const handle: MountHandle = { released: false, contributed: false };
    const result = this.load(environmentId, cwd, handle);
    this.mounts.set(environmentId, { result, handle });
    return result;
  }

  unmount(environmentId: string, mount: Promise<EnvironmentMount>): void {
    const entry = this.mounts.get(environmentId);
    if (entry === undefined || entry.result !== mount) return;
    this.mounts.delete(environmentId);
    entry.handle.released = true;
    entry.handle.workdir?.dispose();
    if (entry.handle.contributed) this.catalog.remove(catalogContributionId(environmentId));
  }

  private async load(environmentId: string, cwd: string, handle: MountHandle): Promise<EnvironmentMount> {
    let workdir: SessionEnvironmentWorkdir;
    try {
      workdir = await this.workdir.acquireEnvironmentWorkdir(environmentId, cwd);
    } catch (error) {
      return { status: 'failed', error: errorMessage(error) };
    }
    if (handle.released) {
      workdir.dispose();
      return { status: 'failed', error: `environment ${environmentId} is no longer available` };
    }
    handle.workdir = workdir;
    try {
      await Promise.all([workdir.skills.load(), workdir.instructions.ready]);
    } catch (error) {
      return { status: 'failed', error: errorMessage(error) };
    }
    if (handle.released) return { status: 'failed', error: `environment ${environmentId} is no longer available` };
    const skills = workdir.skills.catalog
      .listSkills()
      .filter((skill) => skill.source === 'project')
      .map((skill): SkillDefinition => ({
        ...skill,
        name: environmentSkillName(skill.name, environmentId),
        environmentId,
      }));
    if (skills.length > 0) {
      this.catalog.set(catalogContributionId(environmentId), { skills }, { priority: SKILL_SOURCE_PRIORITY.workspace });
      handle.contributed = true;
    }
    return { status: 'mounted', agentsMdPaths: workdir.instructions.snapshot.agentsMdProjectPaths ?? [] };
  }
}

function catalogContributionId(environmentId: string): string {
  return `environment:${environmentId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Session,
  ISessionEnvironmentMounts,
  SessionEnvironmentMountsService,
  ScopeActivation.OnDemand,
  'sessionEnvironmentMounts',
);
