import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './get-comments.md';
import { joinReviewDetails, reviewDisplay } from './display';
import { jsonError, jsonResult } from './support';

const StateSchema = z.enum(['candidate', 'merged', 'dismissed']);

export const GetCommentsInputSchema = z
  .object({
    status: StateSchema.optional(),
    scope: z.enum(['assigned', 'all']).default('all'),
    paths: z.array(z.string().min(1)).optional(),
    include_sources: z.boolean().default(false),
  })
  .strict();
export type GetCommentsInput = z.input<typeof GetCommentsInputSchema>;

export class GetCommentsTool implements BuiltinTool<GetCommentsInput> {
  readonly name = 'GetComments' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetCommentsInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: GetCommentsInput): ToolExecution {
    const scope = args.scope ?? 'all';
    const detail = joinReviewDetails([
      args.status,
      scope === 'assigned' ? 'assigned scope' : 'all scope',
      args.paths === undefined ? undefined : args.paths.join(', '),
      args.include_sources === true ? 'include sources' : undefined,
    ]);
    return {
      approvalRule: this.name,
      description: 'Getting review comments',
      display: reviewDisplay('review comments', detail),
      execute: async () => {
        try {
          const pathFilter = args.paths === undefined ? undefined : new Set(args.paths);
          const assigned = new Set(this.review.getAssignment().assignedFiles);
          const includeSources = args.include_sources ?? false;
          const includePath = (path: string): boolean => {
            if (scope === 'assigned' && !assigned.has(path)) return false;
            if (pathFilter !== undefined && !pathFilter.has(path)) return false;
            return true;
          };
          const comments = args.status === 'merged' || args.status === 'dismissed'
            ? []
            : this.review.getComments({ state: args.status }).filter((comment) => includePath(comment.path));
          const mergedComments = args.status === undefined || args.status === 'merged'
            ? this.review.getMergedComments().filter((comment) => includePath(comment.path))
            : [];
          const dismissedComments = args.status === undefined || args.status === 'dismissed'
            ? this.review.getDismissedComments().filter((dismissal) => {
                const source = this.review.getComments({ sourceCommentIds: [dismissal.commentId] })[0];
                return source !== undefined && includePath(source.path);
              })
            : [];
          const sourceComments = includeSources
            ? this.review.getComments({
                sourceCommentIds: mergedComments.flatMap((comment) => comment.sourceCommentIds),
              })
            : undefined;
          return jsonResult({
            comments,
            merged_comments: mergedComments,
            dismissed_comments: dismissedComments,
            source_comments: sourceComments,
          });
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
