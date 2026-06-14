import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ReviewAgentFacade } from '#/review';
import DESCRIPTION from './read-diff.md?raw';
import { countLabel, joinReviewDetails, reviewDisplay } from './display';
import { jsonError, readDiffForTarget, requireAssignedPath } from './support';

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_BYTES = 60_000;

export const ReadDiffInputSchema = z
  .object({
    paths: z.array(z.string().min(1)).optional(),
    section_id: z.string().min(1).optional(),
    context_lines: z.number().int().min(0).max(100).default(DEFAULT_CONTEXT_LINES),
    max_bytes: z.number().int().min(1_000).max(200_000).default(DEFAULT_MAX_BYTES),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ReadDiffInput = z.input<typeof ReadDiffInputSchema>;

interface DiffCursor {
  readonly pathIndex: number;
  readonly sectionIndex: number;
}

export class ReadDiffTool implements BuiltinTool<ReadDiffInput> {
  readonly name = 'ReadDiff' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadDiffInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly review: ReviewAgentFacade,
  ) {}

  resolveExecution(args: ReadDiffInput): ToolExecution {
    const paths = args.paths ?? [];
    const detail = joinReviewDetails([
      paths.length === 0
        ? 'assigned files'
        : paths.length === 1 ? paths[0] : countLabel(paths.length, 'file', 'files'),
      changedSectionDetail(args.section_id),
      nearbyLinesDetail(args.context_lines),
    ]);
    return {
      approvalRule: this.name,
      description: 'Reading review diff',
      display: reviewDisplay(args.section_id === undefined ? 'changed lines' : 'changed section', detail),
      execute: async () => {
        try {
          const requestedPaths = resolveRequestedPaths(this.review, args.paths);
          if (args.section_id !== undefined && requestedPaths.length !== 1) {
            return jsonError(new Error('section_id requires exactly one path'));
          }
          const cursor = parseCursor(args.cursor);
          const contextLines = args.context_lines ?? DEFAULT_CONTEXT_LINES;
          const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;
          const lines = [
            `Review diff for ${formatCount(requestedPaths.length, 'file')}`,
            '',
          ];
          let bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
          let nextCursor: DiffCursor | undefined;

          for (let pathIndex = cursor.pathIndex; pathIndex < requestedPaths.length; pathIndex += 1) {
            const path = requestedPaths[pathIndex]!;
            requireAssignedPath(this.review, path);
            const result = await readDiffForTarget(
              this.kaos,
              this.review.getActiveRun(),
              path,
              contextLines,
            );
            const selected =
              args.section_id === undefined
                ? result.hunks
                : result.hunks.filter((hunk) => sectionIdForHunkId(hunk.id) === args.section_id);
            if (args.section_id !== undefined && selected.length === 0) {
              return jsonError(
                new Error(
                  `Unknown section_id. Available sections: ${result.hunks.map((hunk) => sectionIdForHunkId(hunk.id)).join(', ')}`,
                ),
              );
            }

            const file = this.review.getChangedFiles().find((item) => item.path === path);
            if (selected.length === 0) {
              const fileText = renderSection({
                path,
                status: file?.status,
                additions: file?.additions,
                deletions: file?.deletions,
                patch: result.patch.trimEnd() || 'No changed lines found for this file.',
              });
              const fileBytes = Buffer.byteLength(fileText, 'utf8');
              if (lines.length > 2 && bytes + fileBytes > maxBytes) {
                nextCursor = { pathIndex, sectionIndex: 0 };
                break;
              }
              lines.push(fileText);
              bytes += fileBytes;
              this.review.recordPatchRead({
                path,
                availableHunkIds: [],
                complete: true,
              });
              continue;
            }

            const startSectionIndex = pathIndex === cursor.pathIndex ? cursor.sectionIndex : 0;
            for (
              let sectionIndex = startSectionIndex;
              sectionIndex < selected.length;
              sectionIndex += 1
            ) {
              const section = selected[sectionIndex]!;
              const sectionText = renderSection({
                path,
                status: file?.status,
                additions: file?.additions,
                deletions: file?.deletions,
                sectionId: sectionIdForHunkId(section.id),
                patch: section.patch,
              });
              const sectionBytes = Buffer.byteLength(sectionText, 'utf8');
              if (lines.length > 2 && bytes + sectionBytes > maxBytes) {
                nextCursor = { pathIndex, sectionIndex };
                break;
              }
              lines.push(sectionText);
              bytes += sectionBytes;
              this.review.recordPatchRead({
                path,
                hunkId: section.id,
                availableHunkIds: result.hunks.map((hunk) => hunk.id),
                ranges: section.ranges,
              });
            }
            if (
              nextCursor === undefined
              && args.section_id === undefined
              && startSectionIndex === 0
              && selected.length === result.hunks.length
            ) {
              this.review.recordPatchRead({
                path,
                availableHunkIds: result.hunks.map((hunk) => hunk.id),
                complete: true,
              });
            }
            if (nextCursor !== undefined) break;
          }

          if (lines.length === 2) lines.push('No changed lines found for the selected files.');
          if (nextCursor !== undefined) {
            lines.push(`[next_cursor: ${formatCursor(nextCursor)}]`);
          }
          return { output: lines.join('\n').trimEnd() };
        } catch (error) {
          return jsonError(error);
        }
      },
    };
  }
}

function resolveRequestedPaths(
  review: ReviewAgentFacade,
  requestedPaths: readonly string[] | undefined,
): readonly string[] {
  if (requestedPaths !== undefined && requestedPaths.length > 0) {
    return [...new Set(requestedPaths)];
  }
  return review.getAssignment().assignedFiles;
}

function renderSection(input: {
  readonly path: string;
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly sectionId?: string;
  readonly patch: string;
}): string {
  const stats =
    input.additions === undefined || input.deletions === undefined
      ? undefined
      : ` (+${String(input.additions)} -${String(input.deletions)})`;
  return [
    `--- file: ${input.path}`,
    `status: ${input.status ?? 'changed'}${stats ?? ''}`,
    input.sectionId === undefined ? undefined : `section: ${input.sectionId}`,
    input.patch,
    '',
  ].filter((line) => line !== undefined).join('\n');
}

function parseCursor(cursor: string | undefined): DiffCursor {
  if (cursor === undefined) return { pathIndex: 0, sectionIndex: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      readonly pathIndex?: unknown;
      readonly sectionIndex?: unknown;
    };
    const { pathIndex, sectionIndex } = parsed;
    if (
      typeof pathIndex === 'number'
      && typeof sectionIndex === 'number'
      && Number.isInteger(pathIndex)
      && Number.isInteger(sectionIndex)
      && pathIndex >= 0
      && sectionIndex >= 0
    ) {
      return {
        pathIndex,
        sectionIndex,
      };
    }
  } catch {
    /* fall through */
  }
  throw new Error('Invalid ReadDiff cursor');
}

function formatCursor(cursor: DiffCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function sectionIdForHunkId(hunkId: string): string {
  const match = /^hunk-(\d+)$/i.exec(hunkId);
  return `section-${match?.[1] ?? hunkId}`;
}

function changedSectionDetail(sectionId: string | undefined): string | undefined {
  if (sectionId === undefined) return undefined;
  const match = /^section-(\d+)$/i.exec(sectionId);
  return `section ${match?.[1] ?? sectionId}`;
}

function nearbyLinesDetail(count: number | undefined): string | undefined {
  if (count === undefined || count <= 0) return undefined;
  return countLabel(count, 'nearby line', 'nearby lines');
}

function formatCount(count: number, singular: string): string {
  return `${String(count)} ${count === 1 ? singular : `${singular}s`}`;
}
