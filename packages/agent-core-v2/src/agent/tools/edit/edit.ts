import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const EditInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact file content to replace. Use LF for pure CRLF files; use actual \\r escapes for literal carriage returns.',
    ),
  new_string: z
    .string()
    .describe(
      'Replacement file content. LF is written back as CRLF only for pure CRLF files.',
    ),
  replace_all: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of old_string should be replaced.'),
});

export type EditInput = z.infer<typeof EditInputSchema>;

export interface IEditTool extends AgentTool<EditInput> {
  readonly _serviceBrand: undefined;
}
export const IEditTool = createDecorator<IEditTool>('editTool');
