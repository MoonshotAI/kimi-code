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
      'Raw full file content to write. This does not use the Read/Edit text view. Encoding and line endings may be adjusted to preserve an existing file\'s style or to follow repo conventions for new files (see tool description).',
    ),
  mode: z
    .enum(['overwrite', 'append'])
    .optional()
    .describe(
      'Write mode. Defaults to overwrite. append adds content to the end of an existing file literally and does not add a newline; a file created by append follows the same new-file conventions as overwrite.',
    ),
});

export const WriteOutputSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;
export type WriteOutput = z.infer<typeof WriteOutputSchema>;

export interface IWriteTool extends AgentTool<WriteInput> { readonly _serviceBrand: undefined }
export const IWriteTool = createDecorator<IWriteTool>('writeTool');
