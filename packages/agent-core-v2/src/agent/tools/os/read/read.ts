import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_MAX_CHARS = 100_000;
export const DEFAULT_MAX_CHARS_LIMIT = 100_000;

export const TRANSCODE_MAX_BYTES: number = 10 * 1024 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().negative();

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'File path, absolute or relative to the working directory (a path outside it must be absolute), or a kimi-file:// attachment reference.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      'Line to start from, 1-based; omit to start at line 1. Negative values count from the end: -100 reads the last 100 lines.',
    ),
  column_offset: z.number().int().nonnegative().optional().describe(
    'Zero-based offset within the first line, used to resume a long line; copy it from Next Read.',
  ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Number of lines to read; omit to read to the end of the file.',
    ),
  max_chars: z.number().int().positive().optional().describe(
    'Maximum characters to return, including line numbers; omit for the default.',
  ),
});

export const ReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;

export interface IReadTool extends AgentTool<ReadInput> { readonly _serviceBrand: undefined }
export const IReadTool = createDecorator<IReadTool>('readTool');
