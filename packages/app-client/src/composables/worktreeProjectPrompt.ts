import { ref } from 'vue';

export const WORKTREE_RESULT_TOAST_MS = 8000;

export interface WorktreeProjectPromptState {
  project: string;
  branch?: string;
  sessionCount: number;
}

export type WorktreeProjectPromptChoice = 'switch' | 'create' | 'dismiss';

export const worktreeProjectPrompt = ref<WorktreeProjectPromptState | null>(null);

let resolvePrompt: ((choice: WorktreeProjectPromptChoice) => void) | null = null;

export function askExistingWorktreeProject(info: WorktreeProjectPromptState): Promise<WorktreeProjectPromptChoice> {
  resolvePrompt?.('dismiss');
  return new Promise<WorktreeProjectPromptChoice>((resolve) => {
    resolvePrompt = resolve;
    worktreeProjectPrompt.value = info;
  });
}

export function answerExistingWorktreeProject(choice: WorktreeProjectPromptChoice): void {
  const resolve = resolvePrompt;
  resolvePrompt = null;
  worktreeProjectPrompt.value = null;
  resolve?.(choice);
}
