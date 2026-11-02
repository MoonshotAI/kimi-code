import { renderPrompt } from '#/_base/utils/render-prompt';

import compactionInstructionTemplate from './compaction-instruction.md?raw';
import compactionTodoListNote from './compaction-todo-list.md?raw';

export interface CompactionInstructionInput {
  readonly customInstruction?: string;
  readonly todoListActive: boolean;
}

export function renderCompactionInstruction(input: CompactionInstructionInput): string {
  const customInstruction = input.customInstruction?.trim() ?? '';
  return renderPrompt(compactionInstructionTemplate, {
    todo_list_block: input.todoListActive ? `${compactionTodoListNote.trimEnd()}\n\n` : '',
    custom_instruction_block:
      customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
  }).trimEnd();
}
