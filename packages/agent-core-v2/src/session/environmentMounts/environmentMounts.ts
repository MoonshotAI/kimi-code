import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { SKILL_SOURCE_PRIORITY } from '#/features/skill/catalog/skillSource';
import type { SkillDefinition } from '#/features/skill/catalog/types';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionWorkdir, type SessionEnvironmentWorkdir } from '#/session/workdir/workdir';

export type EnvironmentMount =
  | { readonly status: 'mounted'; readonly agentsMdPaths: readonly string[] }
  | { readonly status: 'failed'; readonly error: string };

export interface ISessionEnvironmentMounts {
  readonly _serviceBrand: undefined;
  mount(environmentId: string, cwd: string): Promise<EnvironmentMount>;
}

export const ISessionEnvironmentMounts: ServiceIdentifier<ISessionEnvironmentMounts> =
  createDecorator<ISessionEnvironmentMounts>('sessionEnvironmentMounts');

export function environmentSkillName(name: string, environmentId: string): string {
  return `${name}@${environmentId}`;
}

export class SessionEnvironmentMountsService extends Disposable implements ISessionEnvironmentMounts {
  declare readonly _serviceBrand: undefined;

  private readonly mounts = new Map<string, Promise<EnvironmentMount>>();
  private disposed = false;

  constructor(
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
  ) {
    super();
    this._register(toDisposable(() => {
      this.disposed = true;
    }));
  }

  mount(environmentId: string, cwd: string): Promise<EnvironmentMount> {
    let pending = this.mounts.get(environmentId);
    if (pending === undefined) {
      pending = this.load(environmentId, cwd);
      this.mounts.set(environmentId, pending);
    }
    return pending;
  }

  private async load(environmentId: string, cwd: string): Promise<EnvironmentMount> {
    let workdir: SessionEnvironmentWorkdir;
    try {
      workdir = await this.workdir.acquireEnvironmentWorkdir(environmentId, cwd);
    } catch (error) {
      return { status: 'failed', error: errorMessage(error) };
    }
    this._register(toDisposable(() => workdir.dispose()));
    try {
      await Promise.all([workdir.skills.load(), workdir.instructions.ready, this.instructions.ready]);
    } catch (error) {
      return { status: 'failed', error: errorMessage(error) };
    }
    if (this.disposed) return { status: 'failed', error: 'session closed' };
    const skills = workdir.skills.catalog
      .listSkills()
      .filter((skill) => skill.source === 'project')
      .map((skill): SkillDefinition => ({
        ...skill,
        name: environmentSkillName(skill.name, environmentId),
        environmentId,
      }));
    if (skills.length > 0) {
      this.catalog.set(`environment:${environmentId}`, { skills }, { priority: SKILL_SOURCE_PRIORITY.workspace });
    }
    const primaryPaths = new Set(this.instructions.agentsMdPaths ?? []);
    const agentsMdPaths = (workdir.instructions.snapshot.agentsMdPaths ?? []).filter((path) => !primaryPaths.has(path));
    return { status: 'mounted', agentsMdPaths };
  }
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
