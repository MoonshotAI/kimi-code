import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './get-comment-evidence.md?raw';
import { reviewDisplay } from './display';
import { jsonError, jsonResult } from './support';

export const GetCommentEvidenceInputSchema = z
  .object({
    comment_id: z.string().min(1),
  })
  .strict();
export type GetCommentEvidenceInput = z.infer<typeof GetCommentEvidenceInputSchema>;

export class GetCommentEvidenceTool implements BuiltinTool<GetCommentEvidenceInput> {
  readonly name = 'GetCommentEvidence' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetCommentEvidenceInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: GetCommentEvidenceInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Getting review comment evidence',
      display: reviewDisplay(`comment evidence: ${args.comment_id}`),
      execute: async () => {
        try {
          return jsonResult({
            comment_id: args.comment_id,
            evidence: this.review.getCommentEvidence(args.comment_id) ?? null,
          });
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
