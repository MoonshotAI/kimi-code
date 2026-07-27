/**
 * `tools` domain (L7) — `IWriteTool` contract.
 *
 * Public contract of Write, the model's UTF-8 text file writer. Overwrites a
 * file entirely or appends content to its end. Creates the file if it does
 * not exist, and creates missing parent directories automatically (mirroring
 * `mkdir(parents=True, exist_ok=True)`). Path access policy is resolved
 * before any filesystem I/O.
 *
 * Append semantics never read or rewrite existing content, keeping appends
 * atomic with respect to concurrent writers and safe against mid-write
 * crashes. Owns the `WriteInput` / `WriteOutput` zod schemas and the
 * Agent-scope service identifier. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const WriteInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically.',
    ),
  content: z
    .string()
    .describe(
      'Raw full file content to write exactly as provided. This does not use the Read/Edit text view.',
    ),
  mode: z
    .enum(['overwrite', 'append'])
    .optional()
    .describe(
      'Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.',
    ),
});

export const WriteOutputSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;
export type WriteOutput = z.infer<typeof WriteOutputSchema>;

export interface IWriteTool extends AgentTool<WriteInput> { readonly _serviceBrand: undefined }
export const IWriteTool = createDecorator<IWriteTool>('writeTool');
