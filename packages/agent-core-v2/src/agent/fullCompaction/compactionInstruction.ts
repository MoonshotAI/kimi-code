import { renderPrompt } from '#/_base/utils/render-prompt';

import compactionInstructionTemplate from './compaction-instruction.md?raw';

export interface CompactionInstructionInput {
  readonly customInstruction?: string;
}

export function renderCompactionInstruction(input: CompactionInstructionInput): string {
  const customInstruction = input.customInstruction?.trim() ?? '';
  return renderPrompt(compactionInstructionTemplate, {
    custom_instruction_block:
      customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
  }).trimEnd();
}
