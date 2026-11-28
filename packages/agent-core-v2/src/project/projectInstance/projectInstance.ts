import type { Project } from '#/app/project/project';
import { Program, type ProgramSnapshot } from '#/program/program';
import type { ProgramDependencies } from '#/program/programDependencies';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { IProjectContext } from '#/project/projectContext/projectContext';

export type ProjectInstanceLifecycle = 'materializing' | 'active' | 'closing' | 'disposed';

export interface ProjectInstanceSnapshot {
  readonly metadata: Project;
  readonly lifecycle: ProjectInstanceLifecycle;
  readonly program: ProgramSnapshot;
}

export class ProjectInstance {
  readonly program: Program;
  private lifecycle: ProjectInstanceLifecycle = 'materializing';
  private metadataValue: Project;

  constructor(
    metadata: Project,
    environments: IEnvironmentService,
    context: IProjectContext,
    dependencies: ProgramDependencies,
  ) {
    this.metadataValue = metadata;
    const liveContext = { ...context };
    Object.defineProperty(liveContext, 'meta', { get: () => this.metadata });
    this.program = new Program(metadata.id, environments, liveContext, dependencies);
  }

  get metadata(): Project {
    return this.metadataValue;
  }

  update(metadata: Project): void {
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

  snapshot(): ProjectInstanceSnapshot {
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
