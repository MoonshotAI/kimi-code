import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './update-progress.md';
import { joinReviewDetails, reviewDisplay } from './display';
import { jsonError, jsonResult } from './support';

export const UpdateProgressInputSchema = z
  .object({
    status: z.enum(['active', 'complete', 'blocked']),
    summary: z.string().optional(),
    blocker: z.string().optional(),
  })
  .strict();
export type UpdateProgressInput = z.infer<typeof UpdateProgressInputSchema>;

export class UpdateProgressTool implements BuiltinTool<UpdateProgressInput> {
  readonly name = 'UpdateProgress' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateProgressInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: UpdateProgressInput): ToolExecution {
    const detail = joinReviewDetails([
      args.summary,
      args.blocker === undefined ? undefined : `blocker: ${args.blocker}`,
    ]);
    return {
      approvalRule: this.name,
      description: 'Updating review progress',
      display: reviewDisplay(`review progress update: ${args.status}`, detail),
      execute: async () => {
        try {
          return jsonResult(this.review.updateProgress(args));
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
