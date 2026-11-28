import { abbreviateHome } from '#/utils/paths';

import { ChoicePickerComponent, type ChoiceNoticeLine, type ChoiceOption } from './choice-picker';

const escHint = (meaning: string): string => `↑↓ navigate · Enter select · Esc ${meaning}`;

export type WorktreeFailedChoice = 'retry' | 'stay';

export function createWorktreeFailedPrompt(input: {
  readonly sourceDir: string;
  readonly onChoose: (choice: WorktreeFailedChoice) => void;
}): ChoicePickerComponent {
  return new ChoicePickerComponent({
    title: "Couldn't create the worktree",
    hint: escHint('stay'),
    options: [
      { value: 'retry', label: 'Try again' },
      { value: 'stay', label: `Stay in ${abbreviateHome(input.sourceDir)}` },
    ],
    spaceSelect: false,
    onSelect: (value) => {
      input.onChoose(value === 'retry' ? 'retry' : 'stay');
    },
    onCancel: () => {
      input.onChoose('stay');
    },
  });
}

export interface WorktreeRemoval {
  readonly repoRoot: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string | undefined;
  readonly uncommittedFiles: number;
  readonly commitsLostWithWorktree: number;
  readonly commitsLostWithBranch: number;
  readonly openSessionIds: readonly string[];
  readonly closedSessionCount: number;
  readonly hasSubmodules?: boolean;
  readonly locked?: boolean;
}

export type WorktreeDeleteChoice = 'delete' | 'delete-branch';

export function removalLosses(
  removal: WorktreeRemoval,
  choice: WorktreeDeleteChoice,
): { readonly files: number; readonly commits: number } {
  return {
    files: removal.uncommittedFiles,
    commits: choice === 'delete-branch' ? removal.commitsLostWithBranch : removal.commitsLostWithWorktree,
  };
}

function counted(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function discards(losses: { readonly files: number; readonly commits: number }): string | undefined {
  const parts = [
    ...(losses.files > 0 ? [counted(losses.files, 'file', 'files')] : []),
    ...(losses.commits > 0 ? [counted(losses.commits, 'commit', 'commits')] : []),
  ];
  return parts.length === 0 ? undefined : `Discards ${parts.join(' and ')}`;
}

function requiresForce(removal: WorktreeRemoval): boolean {
  return removal.hasSubmodules === true || removal.locked === true;
}

function worktreeDeleteOptions(removal: WorktreeRemoval): ChoiceOption[] {
  const verb = requiresForce(removal) ? 'Force delete' : 'Delete';
  const option = (value: WorktreeDeleteChoice, label: string): ChoiceOption => ({
    value,
    label,
    tone: 'danger',
    description: discards(removalLosses(removal, value)),
    descriptionTone: 'warning',
  });
  return [
    { value: 'keep', label: 'Keep it' },
    option('delete', `${verb} worktree`),
    ...(removal.branch === undefined
      ? []
      : [option('delete-branch', `${verb} worktree and branch ${removal.branch}`)]),
  ];
}

export interface WorktreeExitActiveWork {
  readonly foreground: boolean;
  readonly backgroundTasks: number;
}

function removalNotice(
  removal: WorktreeRemoval,
  activeWork?: WorktreeExitActiveWork,
): ChoiceNoticeLine[] {
  const lines: ChoiceNoticeLine[] = [{ text: abbreviateHome(removal.path), tone: 'text' }];
  if (activeWork?.foreground === true) {
    lines.push({
      text: 'Work is still running in this session and will be stopped.',
      tone: 'warning',
    });
  }
  if ((activeWork?.backgroundTasks ?? 0) > 0) {
    const tasks = counted(
      activeWork!.backgroundTasks,
      'background task is',
      'background tasks are',
    );
    lines.push({
      text: `${tasks} still running and will be stopped.`,
      tone: 'warning',
    });
  }
  if (removal.hasSubmodules === true) {
    lines.push({ text: 'Contains git submodules. Force delete is required.', tone: 'warning' });
  }
  if (removal.locked === true) {
    lines.push({
      text: 'This worktree is locked (for example, on a removable drive). Force delete is required.',
      tone: 'warning',
    });
  }
  if (removal.uncommittedFiles > 0) {
    const files = counted(removal.uncommittedFiles, 'uncommitted file', 'uncommitted files');
    lines.push({ text: `${files} will be lost.`, tone: 'warning' });
  }
  const commits = removal.branch === undefined ? removal.commitsLostWithWorktree : removal.commitsLostWithBranch;
  if (commits > 0) {
    const where = removal.branch === undefined ? 'in this worktree' : `on branch ${removal.branch}`;
    const exist = counted(commits, 'commit exists', 'commits exist');
    lines.push({ text: `${exist} only ${where}.`, tone: 'warning' });
  }
  if (removal.closedSessionCount > 0) {
    const sessions = counted(removal.closedSessionCount, 'earlier session', 'earlier sessions');
    lines.push({
      text: `${sessions} worked here. Their conversation history stays available.`,
      tone: 'textMuted',
    });
  }
  return lines;
}

function createRemovalPrompt<T extends string>(input: {
  readonly title: string;
  readonly hint?: string;
  readonly removal: WorktreeRemoval;
  readonly activeWork?: WorktreeExitActiveWork;
  readonly onChoose: (choice: T) => void;
  readonly cancelChoice: T;
  readonly exitChoice?: T;
}): ChoicePickerComponent {
  return new ChoicePickerComponent({
    title: input.title,
    hint: input.hint,
    notice: { lines: removalNotice(input.removal, input.activeWork) },
    options: worktreeDeleteOptions(input.removal),
    spaceSelect: false,
    onSelect: (value) => {
      input.onChoose((value === 'delete' || value === 'delete-branch' ? value : 'keep') as T);
    },
    onCancel: () => {
      input.onChoose(input.cancelChoice);
    },
    onExitKey:
      input.exitChoice === undefined
        ? undefined
        : () => {
            input.onChoose(input.exitChoice!);
          },
  });
}

export function createWorktreeDeletePrompt(input: {
  readonly removal: WorktreeRemoval;
  readonly onChoose: (choice: WorktreeDeleteChoice | 'keep') => void;
}): ChoicePickerComponent {
  return createRemovalPrompt({
    title: `Delete worktree ${input.removal.name}?`,
    removal: input.removal,
    onChoose: input.onChoose,
    cancelChoice: 'keep',
  });
}

export type LeaveWorktreeChoice = WorktreeDeleteChoice | 'keep' | 'cancel';

export function createLeaveWorktreePrompt(input: {
  readonly removal: WorktreeRemoval;
  readonly activeWork?: WorktreeExitActiveWork;
  readonly onChoose: (choice: LeaveWorktreeChoice) => void;
}): ChoicePickerComponent {
  return createRemovalPrompt({
    title: `Leaving worktree ${input.removal.name}`,
    hint: '↑↓ navigate · Enter select · Esc stay · Ctrl+C keep and exit',
    removal: input.removal,
    activeWork: input.activeWork,
    onChoose: input.onChoose,
    cancelChoice: 'cancel',
    exitChoice: 'keep',
  });
}
