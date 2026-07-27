/**
 * `workflow` domain (L6) — `IWorkflowCatalogService` implementation.
 *
 * Owns the discovered workflow listing and skipped-file diagnostics, loaded
 * through the engine-agnostic discovery over the resolved roots: project
 * brand / generic under the bootstrap `cwd` project root, user brand under
 * `homeDir`, user generic under `osHomeDir`, the `[workflows]`
 * `extraWorkflowDirs`, and the packaged builtin root. Reads its limits and
 * extra roots from the `workflows` config section through `config`, addresses
 * the filesystem through `bootstrap` facts, and logs through `log`. Bound at
 * App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import { WORKFLOWS_SECTION, type WorkflowsConfig } from './configSection';
import {
  WorkflowAlreadyExistsError,
  discoverWorkflows,
  saveWorkflow,
} from './runtime/discovery';
import type { SkippedWorkflow, WorkflowDefinition } from './runtime/types';
import { resolveWorkflowLimits } from './runtime/types';
import { WorkflowValidationError } from './runtime/validate';
import { IWorkflowCatalogService, type SaveWorkflowInput } from './workflowCatalog';

export class WorkflowCatalogService extends Disposable implements IWorkflowCatalogService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  private workflows: WorkflowDefinition[] = [];
  private skippedWorkflows: SkippedWorkflow[] = [];

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.ready = this.reload();
  }

  list(): readonly WorkflowDefinition[] {
    return [...this.workflows];
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.find((workflow) => workflow.meta.name === name);
  }

  skipped(): readonly SkippedWorkflow[] {
    return [...this.skippedWorkflows];
  }

  async reload(): Promise<void> {
    const section = this.config.get<WorkflowsConfig>(WORKFLOWS_SECTION);
    const limits = resolveWorkflowLimits(section);
    const result = await discoverWorkflows({
      workDir: this.bootstrap.cwd,
      kimiHome: this.bootstrap.homeDir,
      osHome: this.bootstrap.osHomeDir,
      extraDirs: section?.extraWorkflowDirs ?? [],
      maxScriptBytes: limits.maxScriptBytes,
    });
    this.workflows = result.workflows;
    this.skippedWorkflows = result.skipped;
    for (const skipped of result.skipped) {
      this.log.warn('workflow skipped during discovery', { path: skipped.path, reason: skipped.reason });
    }
  }

  async save(input: SaveWorkflowInput): Promise<{ readonly path: string }> {
    const section = this.config.get<WorkflowsConfig>(WORKFLOWS_SECTION);
    const limits = resolveWorkflowLimits(section);
    try {
      const saved = await saveWorkflow({
        script: input.script,
        scope: input.scope,
        workDir: this.bootstrap.cwd,
        kimiHome: this.bootstrap.homeDir,
        osHome: this.bootstrap.osHomeDir,
        overwrite: input.overwrite,
        maxScriptBytes: limits.maxScriptBytes,
      });
      await this.reload();
      return saved;
    } catch (error) {
      if (error instanceof WorkflowAlreadyExistsError) {
        throw new Error2(ErrorCodes.WORKFLOW_ALREADY_EXISTS, error.message, {
          details: { path: error.filePath },
          cause: error,
        });
      }
      if (error instanceof WorkflowValidationError) {
        throw new Error2(ErrorCodes.WORKFLOW_INVALID, error.message, { cause: error });
      }
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkflowCatalogService,
  WorkflowCatalogService,
  ScopeActivation.OnDemand,
  'workflow',
);
