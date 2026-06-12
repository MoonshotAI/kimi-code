import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './read-file-version.md?raw';
import {
  formatReviewRefForDisplay,
  joinReviewDetails,
  lineRangeLabel,
  reviewDisplay,
} from './display';
import {
  isChangedFileVersionRead,
  jsonError,
  jsonResult,
  readFileVersionForTarget,
  requireAssignedPath,
} from './support';

export const ReadFileVersionInputSchema = z
  .object({
    path: z.string().min(1),
    version: z.enum(['current', 'base', 'head']).optional(),
    ref: z.string().min(1).optional(),
    line_offset: z.number().int().min(1).default(1),
    n_lines: z.number().int().positive().optional(),
  })
  .strict();
export type ReadFileVersionInput = z.input<typeof ReadFileVersionInputSchema>;

export class ReadFileVersionTool implements BuiltinTool<ReadFileVersionInput> {
  readonly name = 'ReadFileVersion' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadFileVersionInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly review: ReviewAgentFacade,
  ) {}

  resolveExecution(args: ReadFileVersionInput): ToolExecution {
    const sourceLabel = args.ref === undefined
      ? args.version ?? 'current'
      : `ref ${formatReviewRefForDisplay(args.ref)}`;
    const detail = joinReviewDetails([
      sourceLabel,
      lineRangeLabel(args.line_offset, args.n_lines),
    ]);
    return {
      approvalRule: this.name,
      description: `Reading review file version for ${args.path}`,
      display: reviewDisplay(`file version: ${args.path}`, detail),
      execute: async () => {
        try {
          requireAssignedPath(this.review, args.path);
          const run = this.review.getActiveRun();
          const result = await readFileVersionForTarget(this.kaos, run, {
            path: args.path,
            version: args.version,
            ref: args.ref,
            lineOffset: args.line_offset ?? 1,
            nLines: args.n_lines,
          });
          this.review.recordFileVersionRead({
            path: args.path,
            lineOffset: result.lineOffset,
            nLines: result.nLines,
            totalLines: result.totalLines,
            changedVersion: isChangedFileVersionRead(run, result),
          });
          return jsonResult({
            path: result.path,
            version: result.version,
            ref: result.ref,
            line_offset: result.lineOffset,
            n_lines: result.nLines,
            total_lines: result.totalLines,
            content: result.content,
          });
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
