import type { Workspace } from '#/app/workspace/workspace';
import { Program, type ProgramSnapshot } from '#/program/program';
import type { ProgramDependencies } from '#/program/programDependencies';
import type { EnvironmentRegistry, EnvironmentRegistrySnapshot } from '#/environment/environmentRegistry';
import type { EnvironmentUnitHost } from '#/environment/environmentUnitHost';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export type WorkspaceInstanceLifecycle = 'materializing' | 'active' | 'closing' | 'disposed';

export interface WorkspaceInstanceSnapshot {
  readonly metadata: Workspace;
  readonly lifecycle: WorkspaceInstanceLifecycle;
  readonly program: ProgramSnapshot;
  readonly environments: EnvironmentRegistrySnapshot;
}

export class WorkspaceInstance {
  readonly environments: EnvironmentRegistry;
  readonly unitHost: EnvironmentUnitHost;
  readonly program: Program;
  private lifecycle: WorkspaceInstanceLifecycle = 'materializing';

  constructor(
    readonly metadata: Workspace,
    environments: EnvironmentRegistry,
    unitHost: EnvironmentUnitHost,
    context: IWorkspaceContext,
    dependencies: ProgramDependencies,
  ) {
    this.environments = environments;
    this.unitHost = unitHost;
    this.program = new Program(metadata.id, this.environments, context, dependencies);
  }

  get id(): string {
    return this.metadata.id;
  }

  get root(): string {
    return this.metadata.root;
  }

  activate(): void {
    if (this.lifecycle === 'materializing') this.lifecycle = 'active';
  }

  snapshot(): WorkspaceInstanceSnapshot {
    return {
      metadata: this.metadata,
      lifecycle: this.lifecycle,
      program: this.program.snapshot(),
      environments: this.environments.snapshot(),
    };
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return;
    this.lifecycle = 'closing';
    this.program.dispose();
    await this.unitHost.dispose();
    await this.environments.dispose();
    this.lifecycle = 'disposed';
  }
}
