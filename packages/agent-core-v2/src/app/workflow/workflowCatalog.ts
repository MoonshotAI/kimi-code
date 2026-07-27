/**
 * `workflow` domain (L6) — `IWorkflowCatalogService` contract (App scope).
 *
 * The process-wide catalog of discovered Dynamic Workflows: resolves the
 * `workflows/` roots (project brand → project generic → user brand → user
 * generic → extra → builtin), scans them through the engine-agnostic
 * discovery, and keeps the first-wins merged listing plus the skipped-file
 * diagnostics. Project roots resolve from the bootstrap `cwd` (the same
 * single-workspace assumption v1's per-session registry made for the CLI);
 * per-session workspace catalogs are future work. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SkippedWorkflow, WorkflowDefinition } from './runtime/types';

export interface SaveWorkflowInput {
  readonly script: string;
  readonly scope: 'project' | 'user';
  readonly overwrite?: boolean;
}

export interface IWorkflowCatalogService {
  readonly _serviceBrand: undefined;

  /** Resolves with the first discovery pass finished. */
  readonly ready: Promise<void>;

  /** Merged listing, valid after `ready`. */
  list(): readonly WorkflowDefinition[];
  get(name: string): WorkflowDefinition | undefined;
  /** Files that failed validation during the last discovery pass. */
  skipped(): readonly SkippedWorkflow[];
  /** Re-run discovery from disk. */
  reload(): Promise<void>;
  /**
   * Validate and persist a workflow script into the project or user root;
   * refreshes the catalog entry on success. Throws `workflow.invalid` /
   * `workflow.already_exists`.
   */
  save(input: SaveWorkflowInput): Promise<{ readonly path: string }>;
}

export const IWorkflowCatalogService: ServiceIdentifier<IWorkflowCatalogService> =
  createDecorator<IWorkflowCatalogService>('workflowCatalogService');
