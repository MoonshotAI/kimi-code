import type { Workspace } from '#/app/workspace/workspace';
import { Program, type ProgramSnapshot } from '#/program/program';
import type { ProgramDependencies } from '#/program/programDependencies';
import type { RuntimeRegistry, RuntimeRegistrySnapshot } from '#/runtime/runtimeRegistry';
import type { RuntimeUnitHost } from '#/runtime/runtimeUnitHost';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export type WorkspaceInstanceLifecycle = 'materializing' | 'active' | 'closing' | 'disposed';

export interface WorkspaceInstanceSnapshot {
  readonly metadata: Workspace;
  readonly lifecycle: WorkspaceInstanceLifecycle;
  readonly program: ProgramSnapshot;
  readonly runtimes: RuntimeRegistrySnapshot;
}

export class WorkspaceInstance {
  readonly runtimes: RuntimeRegistry;
  readonly unitHost: RuntimeUnitHost;
  readonly program: Program;
  private lifecycle: WorkspaceInstanceLifecycle = 'materializing';

  constructor(
    readonly metadata: Workspace,
    runtimes: RuntimeRegistry,
    unitHost: RuntimeUnitHost,
    context: IWorkspaceContext,
    dependencies: ProgramDependencies,
  ) {
    this.runtimes = runtimes;
    this.unitHost = unitHost;
    this.program = new Program(metadata.id, this.runtimes, context, dependencies);
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
      runtimes: this.runtimes.snapshot(),
    };
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return;
    this.lifecycle = 'closing';
    this.program.dispose();
    await this.unitHost.dispose();
    await this.runtimes.dispose();
    this.lifecycle = 'disposed';
  }
}
