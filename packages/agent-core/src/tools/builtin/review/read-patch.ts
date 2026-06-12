import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './read-patch.md?raw';
import { countLabel, joinReviewDetails, reviewDisplay } from './display';
import { jsonError, jsonResult, readPatchForTarget, requireAssignedPath } from './support';

export const ReadPatchInputSchema = z
  .object({
    path: z.string().min(1),
    hunk_id: z.string().min(1).optional(),
    context_lines: z.number().int().min(0).max(100).default(3),
  })
  .strict();
export type ReadPatchInput = z.input<typeof ReadPatchInputSchema>;

export class ReadPatchTool implements BuiltinTool<ReadPatchInput> {
  readonly name = 'ReadPatch' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadPatchInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly review: ReviewAgentFacade,
  ) {}

  resolveExecution(args: ReadPatchInput): ToolExecution {
    const contextLines = args.context_lines ?? 3;
    const detail = joinReviewDetails([
      args.hunk_id === undefined ? 'all hunks' : `hunk ${args.hunk_id}`,
      countLabel(contextLines, 'context line', 'context lines'),
    ]);
    return {
      approvalRule: this.name,
      description: `Reading review patch for ${args.path}`,
      display: reviewDisplay(`review patch: ${args.path}`, detail),
      execute: async () => {
        try {
          requireAssignedPath(this.review, args.path);
          const result = await readPatchForTarget(
            this.kaos,
            this.review.getActiveRun(),
            args.path,
            contextLines,
          );
          const selected =
            args.hunk_id === undefined
              ? result.hunks
              : result.hunks.filter((hunk) => hunk.id === args.hunk_id);
          if (args.hunk_id !== undefined && selected.length === 0) {
            return jsonError(
              new Error(
                `Unknown hunk_id. Available hunks: ${result.hunks.map((hunk) => hunk.id).join(', ')}`,
              ),
            );
          }
          this.review.recordPatchRead({
            path: args.path,
            hunkId: args.hunk_id,
            availableHunkIds: result.hunks.map((hunk) => hunk.id),
            complete: args.hunk_id === undefined,
            ranges: selected.flatMap((hunk) => hunk.ranges),
          });
          return jsonResult({
            path: args.path,
            hunk_id: args.hunk_id,
            hunks: selected.map(({ id, header, oldStart, oldCount, newStart, newCount }) => ({
              id,
              header,
              old_start: oldStart,
              old_count: oldCount,
              new_start: newStart,
              new_count: newCount,
            })),
            patch: args.hunk_id === undefined
              ? result.patch
              : selected.map((hunk) => hunk.patch).join('\n'),
          });
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}
