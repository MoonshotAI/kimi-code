import { renderPrompt } from '#/_base/utils/render-prompt';

import compactionInstructionTemplate from './compaction-instruction.md?raw';

export interface CompactionInstructionInput {
  readonly customInstruction?: string;
  readonly recoveryPointer: boolean;
}

const RECOVERY_POINTER_NOTE =
  'The complete record of this conversation stays on disk and a recovery pointer is appended below your note automatically, so you need not reproduce long outputs verbatim — keep exact identifiers, key values and error lines, and name anything the next turn should look up.';

export function renderCompactionInstruction(input: CompactionInstructionInput): string {
  const customInstruction = input.customInstruction?.trim() ?? '';
  return renderPrompt(compactionInstructionTemplate, {
    recovery_pointer_block: input.recoveryPointer ? `\n\n${RECOVERY_POINTER_NOTE}` : '',
    custom_instruction_block:
      customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
  }).trimEnd();
}
