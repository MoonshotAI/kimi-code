import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      "Optional glob filter for which files to search, e.g. `*.ts`. Matched against each file's full absolute path, so a path-anchored pattern like `src/**/*.ts` silently matches nothing — use a basename pattern (`*.ts`), or anchor with `**/` (`**/src/**/*.ts`). To scope the search to a directory, use `path` instead.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      'Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count_matches'])
    .optional()
    .describe(
      'Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match, most-recently-modified first (honors `head_limit`); `count_matches` shows per-file match counts as `path:count` lines, preceded by an aggregate total line. Defaults to `files_with_matches`.',
    ),
  '-i': z.boolean().optional().describe('Perform a case-insensitive search. Defaults to false.'),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.',
    ),
  '-A': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show after each match. Applies only when `output_mode` is `content`.',
    ),
  '-B': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before each match. Applies only when `output_mode` is `content`.',
    ),
  '-C': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.',
    ),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.',
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.',
    ),
});

export const GrepOutputSchema = z.object({
  mode: z.enum(['content', 'files_with_matches', 'count_matches']),
  numFiles: z.number().int().nonnegative(),
  filenames: z.array(z.string()),
  content: z.string().optional(),
  numLines: z.number().int().nonnegative().optional(),
  numMatches: z.number().int().nonnegative().optional(),
  appliedLimit: z.number().int().nonnegative().optional(),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;
export type GrepOutput = z.infer<typeof GrepOutputSchema>;

export interface IGrepTool extends AgentTool<GrepInput> { readonly _serviceBrand: undefined }
export const IGrepTool = createDecorator<IGrepTool>('grepTool');
