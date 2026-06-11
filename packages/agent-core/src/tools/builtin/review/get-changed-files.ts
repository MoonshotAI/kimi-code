import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './get-changed-files.md';
import { jsonError, jsonResult } from './support';

const ReviewFileStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']);

export const GetChangedFilesInputSchema = z
  .object({
    include: z.enum(['assigned', 'all']).default('assigned'),
    statuses: z.array(ReviewFileStatusSchema).optional(),
  })
  .strict();
export type GetChangedFilesInput = z.input<typeof GetChangedFilesInputSchema>;

export class GetChangedFilesTool implements BuiltinTool<GetChangedFilesInput> {
  readonly name = 'GetChangedFiles' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetChangedFilesInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: GetChangedFilesInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Getting changed files',
      execute: async () => {
        try {
          const assignment = this.review.getAssignment();
          const assigned = new Set(assignment.assignedFiles);
          const statuses = args.statuses === undefined ? undefined : new Set(args.statuses);
          const include = args.include ?? 'assigned';
          const files = this.review.getChangedFiles().filter((file) => {
            if (include !== 'all' && !assigned.has(file.path)) return false;
            if (statuses !== undefined && !statuses.has(file.status)) return false;
            return true;
          });
          return jsonResult({ files });
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
