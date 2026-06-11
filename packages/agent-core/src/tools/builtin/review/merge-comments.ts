import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './merge-comments.md';
import { jsonError, jsonResult } from './support';

const SeveritySchema = z.enum(['critical', 'important', 'minor']);

export const MergeCommentsInputSchema = z
  .object({
    source_comment_ids: z.array(z.string().min(1)).min(1),
    severity: SeveritySchema,
    path: z.string().min(1),
    line: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().min(1),
    evidence: z.string().optional(),
    suggested_fix: z.string().optional(),
  })
  .strict();
export type MergeCommentsInput = z.infer<typeof MergeCommentsInputSchema>;

export class MergeCommentsTool implements BuiltinTool<MergeCommentsInput> {
  readonly name = 'MergeComments' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MergeCommentsInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: MergeCommentsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Merging review comments',
      execute: async () => {
        try {
          return jsonResult(
            this.review.mergeComments({
              sourceCommentIds: args.source_comment_ids,
              severity: args.severity,
              path: args.path,
              line: args.line,
              title: args.title,
              body: args.body,
              evidence: args.evidence,
              suggestedFix: args.suggested_fix,
            }),
          );
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
