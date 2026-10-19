import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_MAX_CHARS = 100_000;
export const DEFAULT_MAX_CHARS_LIMIT = 500_000;

export const TRANSCODE_MAX_BYTES: number = 10 * 1024 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().negative();

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a text file or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      'The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).',
    ),
  column_offset: z.number().int().nonnegative().optional().describe(
    'Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.',
  ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.',
    ),
  max_chars: z.number().int().positive().optional().describe(
    'Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.',
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
