import { abbreviateHome } from '#/tui/utils/home-path';

import { ChoicePickerComponent, type ChoiceNoticeLine, type ChoiceOption } from './choice-picker';

const escHint = (meaning: string): string => `↑↓ navigate · Enter select · Esc ${meaning}`;

export type SetupScriptChoice = 'run' | 'skip';
export type WorktreeFailedChoice = 'retry' | 'stay';
export type SetupFailedChoice = 'again' | 'continue' | 'delete';

export function createSetupScriptPrompt(input: {
  readonly script: string;
  readonly sourceDir: string;
  readonly onChoose: (choice: SetupScriptChoice) => void;
}): ChoicePickerComponent {
  return new ChoicePickerComponent({
    title: 'Run the worktree setup script?',
    hint: escHint('skip'),
    notice: `${input.script} from ${abbreviateHome(input.sourceDir)}`,
    noticeTone: 'text',
    options: [
      { value: 'run', label: 'Run it' },
      { value: 'skip', label: 'Skip this time' },
    ],
    spaceSelect: false,
    onSelect: (value) => {
      input.onChoose(value === 'run' ? 'run' : 'skip');
    },
    onCancel: () => {
      input.onChoose('skip');
    },
  });
}

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

export function createSetupFailedPrompt(input: {
  readonly onChoose: (choice: SetupFailedChoice) => void;
}): ChoicePickerComponent {
  return new ChoicePickerComponent({
    title: 'The setup script failed',
    hint: escHint('continue'),
    options: [
      { value: 'again', label: 'Run it again' },
      { value: 'continue', label: 'Continue without it' },
      { value: 'delete', label: 'Delete the worktree and exit', tone: 'danger' },
    ],
    spaceSelect: false,
    onSelect: (value) => {
      input.onChoose(value === 'again' || value === 'delete' ? value : 'continue');
    },
    onCancel: () => {
      input.onChoose('continue');
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

export function worktreeDeleteOptions(removal: WorktreeRemoval): ChoiceOption[] {
  const option = (value: WorktreeDeleteChoice, label: string): ChoiceOption => ({
    value,
    label,
    tone: 'danger',
    description: discards(removalLosses(removal, value)),
    descriptionTone: 'warning',
  });
  return [
    { value: 'keep', label: 'Keep it' },
    option('delete', 'Delete worktree'),
    ...(removal.branch === undefined ? [] : [option('delete-branch', `Delete worktree and branch ${removal.branch}`)]),
  ];
}

function removalNotice(removal: WorktreeRemoval): ChoiceNoticeLine[] {
  const lines: ChoiceNoticeLine[] = [{ text: abbreviateHome(removal.path), tone: 'text' }];
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
    const one = removal.closedSessionCount === 1;
    const sessions = counted(removal.closedSessionCount, 'earlier session', 'earlier sessions');
    const them = one ? 'it' : 'them';
    lines.push({ text: `${sessions} worked here. You can still read ${them}, but not continue ${them}.`, tone: 'textMuted' });
  }
  return lines;
}

export function createWorktreeDeletePrompt(input: {
  readonly removal: WorktreeRemoval;
  readonly onChoose: (choice: WorktreeDeleteChoice | 'keep') => void;
}): ChoicePickerComponent {
  return new ChoicePickerComponent({
    title: `Delete worktree ${input.removal.name}?`,
    notice: { lines: removalNotice(input.removal) },
    options: worktreeDeleteOptions(input.removal),
    spaceSelect: false,
    onSelect: (value) => {
      input.onChoose(value === 'delete' || value === 'delete-branch' ? value : 'keep');
    },
    onCancel: () => {
      input.onChoose('keep');
    },
  });
}

export type LeaveWorktreeChoice = WorktreeDeleteChoice | 'keep' | 'cancel';

export function createLeaveWorktreePrompt(input: {
  readonly removal: WorktreeRemoval;
  readonly onChoose: (choice: LeaveWorktreeChoice) => void;
}): ChoicePickerComponent {
  return new ChoicePickerComponent({
    title: `Leaving worktree ${input.removal.name}`,
    notice: { lines: removalNotice(input.removal) },
    options: worktreeDeleteOptions(input.removal),
    spaceSelect: false,
    onSelect: (value) => {
      input.onChoose(value === 'delete' || value === 'delete-branch' ? value : 'keep');
    },
    onCancel: () => {
      input.onChoose('cancel');
    },
    onExitKey: () => {
      input.onChoose('keep');
    },
  });
}
