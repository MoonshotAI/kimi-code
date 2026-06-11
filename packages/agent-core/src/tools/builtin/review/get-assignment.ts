import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './get-assignment.md';
import { reviewDisplay } from './display';
import { jsonError, jsonResult } from './support';

export const GetAssignmentInputSchema = z.object({}).strict();
export type GetAssignmentInput = z.infer<typeof GetAssignmentInputSchema>;

export class GetAssignmentTool implements BuiltinTool<GetAssignmentInput> {
  readonly name = 'GetAssignment' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetAssignmentInputSchema);

  constructor(private readonly review: ReviewAgentFacade) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Getting review assignment',
      display: reviewDisplay('review assignment'),
      execute: async () => {
        try {
          return jsonResult(this.review.getAssignment());
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
