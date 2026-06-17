import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import type { ReviewFanOutRunner, ReviewResult, ReviewStartInput } from '../../../review';
import { toInputJsonSchema } from '../../support/input-schema';
import RUN_CODE_REVIEW_DESCRIPTION from './run-code-review.md?raw';

const MAX_DIRECTIONS = 6;
const MIN_DEEP_DIRECTIONS = 2;

const ReviewTargetSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('working_tree'),
    baseRef: z.string().trim().min(1).optional(),
  }),
  z.object({
    scope: z.literal('current_branch'),
    baseRef: z.string().trim().min(1),
    headRef: z.string().trim().min(1).optional(),
  }),
  z.object({
    scope: z.literal('single_commit'),
    commit: z.string().trim().min(1),
  }),
]);

export const RunCodeReviewInputSchema = z
  .object({
    intensity: z
      .enum(['standard', 'thorough', 'deep'])
      .describe('standard: one reviewer; thorough: one reviewer per direction; deep: directions × file groups.'),
    target: ReviewTargetSchema.describe('The scope to review.'),
    background: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Briefing for the reviewers: what the change is, its intent, and the context to judge it. Factual orientation, not a verdict.',
      ),
    directions: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_DIRECTIONS)
      .describe('Review angles. One reviewer per direction (thorough) or multiplied across file groups (deep).'),
    change_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Short label for the change, e.g. "TUI refactor".'),
  })
  .strict();

export type RunCodeReviewInput = z.infer<typeof RunCodeReviewInputSchema>;

export class RunCodeReviewTool implements BuiltinTool<RunCodeReviewInput> {
  readonly name = 'RunCodeReview' as const;
  readonly description = RUN_CODE_REVIEW_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RunCodeReviewInputSchema);

  constructor(private readonly runReview: ReviewFanOutRunner) {}

  resolveExecution(args: RunCodeReviewInput): ToolExecution {
    return {
      accesses: ToolAccesses.all(),
      description: `Running ${args.intensity} code review (${String(args.directions.length)} directions)`,
      display: {
        kind: 'agent_call',
        agent_name: `code review (${args.intensity})`,
        prompt: args.change_type ?? args.background,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: RunCodeReviewInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (args.intensity === 'deep' && args.directions.length < MIN_DEEP_DIRECTIONS) {
      return {
        output: `Deep review requires at least ${String(MIN_DEEP_DIRECTIONS)} directions for overlapping coverage.`,
        isError: true,
      };
    }
    try {
      const input: ReviewStartInput = {
        target: args.target,
        intensity: args.intensity,
        directions: args.directions,
        background: args.background,
        changeType: args.change_type,
      };
      const result = await this.runReview(input, {
        parentToolCallId: context.toolCallId,
        signal: context.signal,
      });
      return { output: renderReviewResult(result) };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}

function renderReviewResult(result: ReviewResult): string {
  const lines = [result.summary];
  if (result.reviewSlug !== undefined) {
    lines.push('', `Saved as review "${result.reviewSlug}". Browse with /review read ${result.reviewSlug}.`);
  }
  return lines.join('\n');
}
