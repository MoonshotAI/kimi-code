import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './add-comment.md';
import { jsonError, jsonResult } from './support';

const SeveritySchema = z.enum(['critical', 'important', 'minor']);

export const AddCommentInputSchema = z
  .object({
    severity: SeveritySchema,
    path: z.string().min(1),
    line: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().min(1),
    evidence: z.string().optional(),
    suggested_fix: z.string().optional(),
  })
  .strict();
export type AddCommentInput = z.infer<typeof AddCommentInputSchema>;

export class AddCommentTool implements BuiltinTool<AddCommentInput> {
  readonly name = 'AddComment' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AddCommentInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(args: AddCommentInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Adding review comment for ${args.path}:${String(args.line)}`,
      execute: async () => {
        try {
          return jsonResult(
            this.review.addComment({
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
