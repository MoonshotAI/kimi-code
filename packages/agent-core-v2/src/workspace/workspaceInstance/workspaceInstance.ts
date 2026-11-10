import type { Workspace } from '#/app/workspace/workspace';
import { Program, type ProgramSnapshot } from '#/program/program';
import type { ProgramDependencies } from '#/program/programDependencies';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export type WorkspaceInstanceLifecycle = 'materializing' | 'active' | 'closing' | 'disposed';

export interface WorkspaceInstanceSnapshot {
  readonly metadata: Workspace;
  readonly lifecycle: WorkspaceInstanceLifecycle;
  readonly program: ProgramSnapshot;
}

export class WorkspaceInstance {
  readonly program: Program;
  private lifecycle: WorkspaceInstanceLifecycle = 'materializing';
  private metadataValue: Workspace;

  constructor(
    metadata: Workspace,
    environments: IEnvironmentService,
    context: IWorkspaceContext,
    dependencies: ProgramDependencies,
  ) {
    this.metadataValue = metadata;
    const liveContext = { ...context };
    Object.defineProperty(liveContext, 'meta', { get: () => this.metadata });
    this.program = new Program(metadata.id, environments, liveContext, dependencies);
  }

  get metadata(): Workspace {
    return this.metadataValue;
  }

  update(metadata: Workspace): void {
    this.metadataValue = metadata;
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
    };
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return;
    this.lifecycle = 'closing';
    const errors: unknown[] = [];
    try {
      await this.program.dispose();
    } catch (error) {
      errors.push(error);
    }
    this.lifecycle = 'disposed';
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `workspace ${this.id} disposal failed`);
  }
}
