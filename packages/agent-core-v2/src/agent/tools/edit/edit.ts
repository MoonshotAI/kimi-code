/**
 * `tools` domain — `IEditTool` contract.
 *
 * Public contract of Edit, the model's exact-string-replacement editor for
 * text files. Line endings are preserved by the model view: the raw file is
 * normalized to LF for matching (so pure CRLF files can be edited with LF
 * `old_string`), then re-materialized to the original style on write — pure
 * CRLF files round-trip to CRLF, mixed/lone-CR files stay on the exact raw
 * path.
 *
 * Owns the `EditInput` zod schema and the Agent-scope service identifier.
 * Bound at Agent scope.
 */

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
      'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.',
    ),
  new_string: z
    .string()
    .describe(
      'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.',
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
