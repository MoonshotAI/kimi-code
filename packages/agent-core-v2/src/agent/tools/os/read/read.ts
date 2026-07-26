/**
 * `tools` domain (L7) — `IReadTool` contract.
 *
 * Public contract of Read, the model's UTF-8 text file reader. Renders a
 * text file as `<line-number>\t<content>` per line as `output`, and rides a
 * `<system>…</system>` status block on the `note` side channel (rendered to
 * the model at projection time, never to UIs) summarizing how much was read
 * (line and byte counts, truncation, and line-ending notes). Pure CRLF files
 * are displayed with LF line endings; mixed or lone carriage returns are
 * shown as `\r` so the model can reproduce them exactly.
 *
 * Binary, non-UTF-8, NUL-containing, image and video files are refused;
 * images/videos are redirected to ReadMediaFile. Supports one-based
 * `line_offset` / `n_lines` pagination and a negative `line_offset` tail
 * mode, bounded by the per-call caps owned here (`MAX_LINES`,
 * `MAX_LINE_LENGTH`, `MAX_BYTES`).
 *
 * Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      `The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed ${String(MAX_LINES)}.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of ${String(MAX_LINES)} lines.`,
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
