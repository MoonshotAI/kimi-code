import { z } from 'zod';

import type { WorkflowMeta } from './types';

export class WorkflowValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkflowValidationError';
  }
}

export const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WORKFLOW_NAME_MAX_LENGTH = 64;
export const WORKFLOW_DESCRIPTION_MAX_LENGTH = 500;
export const WORKFLOW_ARGUMENT_HINT_MAX_LENGTH = 200;
export const WORKFLOW_MAX_PHASES = 24;

const WorkflowPhaseMetaSchema = z.object({
  title: z.string().min(1, 'phase title must not be empty'),
  detail: z.string().optional(),
});

const WorkflowMetaSchema = z
  .object({
    name: z
      .string()
      .max(WORKFLOW_NAME_MAX_LENGTH, `name must be at most ${WORKFLOW_NAME_MAX_LENGTH} characters`)
      .regex(WORKFLOW_NAME_PATTERN, 'name must be kebab-case (lowercase letters, digits, hyphens)'),
    description: z
      .string()
      .min(1, 'description must not be empty')
      .max(
        WORKFLOW_DESCRIPTION_MAX_LENGTH,
        `description must be at most ${WORKFLOW_DESCRIPTION_MAX_LENGTH} characters`,
      ),
    whenToUse: z.string().optional(),
    argumentHint: z
      .string()
      .max(
        WORKFLOW_ARGUMENT_HINT_MAX_LENGTH,
        `argumentHint must be at most ${WORKFLOW_ARGUMENT_HINT_MAX_LENGTH} characters`,
      )
      .optional(),
    phases: z
      .array(WorkflowPhaseMetaSchema)
      .min(1, 'phases must contain at least 1 phase')
      .max(WORKFLOW_MAX_PHASES, `phases must contain at most ${WORKFLOW_MAX_PHASES} phases`),
  })
  .refine((meta) => new Set(meta.phases.map((phase) => phase.title)).size === meta.phases.length, {
    message: 'phase titles must be unique',
    path: ['phases'],
  });

export function validateWorkflowMeta(value: unknown): WorkflowMeta {
  const result = WorkflowMetaSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new WorkflowValidationError(`Invalid workflow meta: ${detail}`);
  }
  return result.data;
}

export function validateWorkflowName(name: string): void {
  if (name.length === 0 || name.length > WORKFLOW_NAME_MAX_LENGTH || !WORKFLOW_NAME_PATTERN.test(name)) {
    throw new WorkflowValidationError(
      `Invalid workflow name "${name}": must be kebab-case (lowercase letters, digits, hyphens), at most ${WORKFLOW_NAME_MAX_LENGTH} characters`,
    );
  }
}
