/**
 * `workflow` domain — Dynamic Workflow contracts.
 *
 * Two services:
 *   - `workflowCatalogService` (App scope): catalog discovery and persistence.
 *   - `workflowRunService`     (Session scope): per-session run lifecycle.
 *
 * Schema names mirror the engine types from `agent-core-v2`.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const workflowPhaseMetaSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
});

export const workflowSourceSchema = z.enum(['project', 'user', 'extra', 'builtin']);

export const workflowRunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// WorkflowDefinition / WorkflowMeta (catalog)
// ---------------------------------------------------------------------------

export const workflowDefinitionSchema = z.object({
  meta: z.object({
    name: z.string(),
    description: z.string(),
    whenToUse: z.string().optional(),
    argumentHint: z.string().optional(),
    phases: z.array(workflowPhaseMetaSchema),
  }),
  script: z.string(),
  /** File path ('' or synthetic for inline/builtin). */
  path: z.string(),
  source: workflowSourceSchema,
});

export const skippedWorkflowSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const saveWorkflowInputSchema = z.object({
  script: z.string(),
  scope: z.enum(['project', 'user']),
  overwrite: z.boolean().optional(),
});

export const saveWorkflowResultSchema = z.object({
  path: z.string(),
});

// ---------------------------------------------------------------------------
// WorkflowRunRecord
// ---------------------------------------------------------------------------

export const workflowRunRecordSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  description: z.string(),
  phases: z.array(workflowPhaseMetaSchema),
  status: workflowRunStatusSchema,
  phase: z.string().optional(),
  phaseIndex: z.number().optional(),
  agentCalls: z.number(),
  /** Bounded log buffer: the most recent entries. */
  logs: z.array(z.string()),
  error: z.string().optional(),
  resultJson: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  taskId: z.string().optional(),
  scriptPath: z.string().optional(),
  source: workflowSourceSchema,
  script: z.string(),
  args: z.string(),
  callerAgentId: z.string(),
});

export const startWorkflowRunInputSchema = z.object({
  /** Name of a catalog workflow; mutually exclusive with `script`. */
  name: z.string().optional(),
  /** Inline workflow script; mutually exclusive with `name`. */
  script: z.string().optional(),
  args: z.string(),
  /** Agent the run's subagents are mirrored onto. */
  callerAgentId: z.string(),
});

export const startWorkflowRunResultSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const workflowCatalogContract = {
  list: { input: z.tuple([]), output: z.array(workflowDefinitionSchema) },
  get: { input: z.tuple([z.string()]), output: maybe(workflowDefinitionSchema) },
  skipped: { input: z.tuple([]), output: z.array(skippedWorkflowSchema) },
  reload: { input: z.tuple([]), output: noResult },
  save: {
    input: z.tuple([saveWorkflowInputSchema]),
    output: saveWorkflowResultSchema,
  },
} satisfies ServiceContract;

export const workflowRunContract = {
  start: {
    input: z.tuple([startWorkflowRunInputSchema]),
    output: startWorkflowRunResultSchema,
  },
  list: { input: z.tuple([]), output: z.array(workflowRunRecordSchema) },
  get: { input: z.tuple([z.string()]), output: maybe(workflowRunRecordSchema) },
  cancel: { input: z.tuple([z.string()]), output: z.boolean() },
} satisfies ServiceContract;
