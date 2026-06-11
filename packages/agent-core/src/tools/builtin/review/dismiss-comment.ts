import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './dismiss-comment.md';
import { joinReviewDetails, reviewDisplay } from './display';
import { jsonError, jsonResult } from './support';

const DismissalReasonSchema = z.enum([
  'duplicate',
  'out_of_scope',
  'pre_existing',
  'unsupported',
  'low_confidence',
  'superseded',
  'not_actionable',
]);

export const DismissCommentInputSchema = z
  .object({
    comment_id: z.string().min(1),
    reason: DismissalReasonSchema,
    summary: z.string().min(1),
    merged_comment_id: z.string().min(1).optional(),
  })
  .strict();
export type DismissCommentInput = z.infer<typeof DismissCommentInputSchema>;

export class DismissCommentTool implements BuiltinTool<DismissCommentInput> {
  readonly name = 'DismissComment' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DismissCommentInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: DismissCommentInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Dismissing review comment',
      display: reviewDisplay(
        `comment dismissal: ${args.comment_id}`,
        joinReviewDetails([
          args.reason,
          args.summary,
          args.merged_comment_id === undefined ? undefined : `merged into ${args.merged_comment_id}`,
        ]),
      ),
      execute: async () => {
        try {
          return jsonResult(
            this.review.dismissComment({
              commentId: args.comment_id,
              reason: args.reason,
              summary: args.summary,
              mergedCommentId: args.merged_comment_id,
            }),
          );
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
