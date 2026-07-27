/**
 * Session-level workflow registry — a simplified analogue of the skill
 * registry (`../skill/registry.ts`): holds the discovered workflow list and
 * supports reload on demand.
 */
import { discoverWorkflows, type DiscoverWorkflowsOptions } from './discovery';
import type { SkippedWorkflow, WorkflowDefinition } from './types';

export interface WorkflowRegistryOptions {
  readonly discover?: typeof discoverWorkflows;
}

export class SessionWorkflowRegistry {
  private workflows: WorkflowDefinition[] = [];
  private skippedWorkflows: SkippedWorkflow[] = [];
  private loaded = false;
  private readonly discoverImpl: typeof discoverWorkflows;

  constructor(
    private readonly discoverOptions: DiscoverWorkflowsOptions,
    options: WorkflowRegistryOptions = {},
  ) {
    this.discoverImpl = options.discover ?? discoverWorkflows;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    const result = await this.discoverImpl(this.discoverOptions);
    this.workflows = result.workflows;
    this.skippedWorkflows = result.skipped;
    this.loaded = true;
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows];
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.find((workflow) => workflow.meta.name === name);
  }

  get skipped(): readonly SkippedWorkflow[] {
    return this.skippedWorkflows;
  }
}
