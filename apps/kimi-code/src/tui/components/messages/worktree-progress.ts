import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@moonshot-ai/pi-tui';

import { WORKTREE_LISTED_FILES, WORKTREE_SHORT_SHA_LENGTH } from '#/constant/worktree';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET, SUCCESS_MARK } from '#/tui/constant/symbols';
import { WORKTREE_ERROR_OUTPUT_LINES, WORKTREE_SETUP_OUTPUT_LINES } from '#/tui/constant/worktree';
import { currentTheme } from '#/tui/theme';
import { SpinnerTicker } from '#/tui/utils/spinner-ticker';
import { abbreviateHome } from '#/utils/paths';

export type WorktreeStepStatus = 'running' | 'done' | 'failed';

export type WorktreeProgressRow =
  | { readonly step: 'check'; readonly status: WorktreeStepStatus; readonly sourceDir: string; readonly output?: readonly string[] }
  | {
      readonly step: 'add';
      readonly status: WorktreeStepStatus;
      readonly path: string;
      readonly head: string;
      readonly output?: readonly string[];
    }
  | {
      readonly step: 'include';
      readonly status: WorktreeStepStatus;
      readonly copiedFiles: readonly string[];
      readonly output?: readonly string[];
    }
  | {
      readonly step: 'setup';
      readonly status: WorktreeStepStatus;
      readonly script: string;
      readonly output: readonly string[];
      readonly exitCode?: number;
    }
  | { readonly step: 'remove'; readonly status: WorktreeStepStatus; readonly path: string; readonly output?: readonly string[] };

export type WorktreeProgress =
  | { readonly phase: 'creating' | 'stopped'; readonly name?: string; readonly rows: readonly WorktreeProgressRow[] }
  | {
      readonly phase: 'entered';
      readonly name: string;
      readonly sourceDir: string;
      readonly sourceDirty: boolean;
      readonly missingSubdir?: string;
    }
  | { readonly phase: 'cancelled'; readonly sourceDir: string };

const INCLUDE_FILE = '.worktreeinclude';

export class WorktreeProgressComponent implements Component {
  private progress: WorktreeProgress = { phase: 'creating', rows: [] };
  private readonly spinner: SpinnerTicker;

  constructor(onTick: () => void) {
    this.spinner = new SpinnerTicker(onTick);
  }

  update(progress: WorktreeProgress): void {
    this.progress = progress;
    if (progress.phase === 'creating' && progress.rows.some((row) => row.status === 'running')) this.spinner.start();
    else this.spinner.stop();
  }

  invalidate(): void {}

  dispose(): void {
    this.spinner.dispose();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [''];
    const lines = ['', ...this.renderProgress(safeWidth)];
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private renderProgress(width: number): string[] {
    const progress = this.progress;
    switch (progress.phase) {
      case 'entered':
        return [
          ...wrapped(currentTheme.fg('success', SUCCESS_MARK), currentTheme.fg('text', `Entered worktree ${progress.name}`), width),
          ...enteredNotes(progress).flatMap((note) => wrapped(MESSAGE_INDENT, currentTheme.fg('warning', note), width)),
        ];
      case 'cancelled':
        return wrapped(
          currentTheme.fg('textDim', STATUS_BULLET),
          currentTheme.fg('textDim', `Cancelled. Staying in ${abbreviateHome(progress.sourceDir)}.`),
          width,
        );
      case 'creating':
      case 'stopped': {
        const title = progress.name === undefined ? 'Creating worktree' : `Creating worktree ${progress.name}`;
        const bullet = currentTheme.fg(progress.phase === 'creating' ? 'primary' : 'textDim', STATUS_BULLET);
        return [
          ...wrapped(bullet, currentTheme.fg('text', title), width),
          ...progress.rows.flatMap((row) => this.renderRow(row, width)),
        ];
      }
    }
  }

  private renderRow(row: WorktreeProgressRow, width: number): string[] {
    if (row.step === 'include' && row.status === 'done' && row.copiedFiles.length === 0) return [];
    const mark =
      row.status === 'running'
        ? currentTheme.fg('primary', `${this.spinner.current} `)
        : row.status === 'done'
          ? currentTheme.fg('success', SUCCESS_MARK)
          : currentTheme.fg('error', FAILURE_MARK);
    const rowLines = wrapped(`${MESSAGE_INDENT}${mark}`, rowLabel(row), width);
    if (row.step === 'setup') {
      return [
        ...rowLines,
        ...row.output.slice(-WORKTREE_SETUP_OUTPUT_LINES).map((line) =>
          truncateToWidth(currentTheme.fg('textMuted', `${MESSAGE_INDENT}  │ ${line}`), width, '…'),
        ),
      ];
    }
    const output = row.status === 'failed' ? (row.output ?? []).slice(-WORKTREE_ERROR_OUTPUT_LINES) : [];
    return [
      ...rowLines,
      ...output.map((line) => truncateToWidth(currentTheme.fg('textMuted', `${MESSAGE_INDENT}  ${line}`), width, '…')),
    ];
  }
}

function rowLabel(row: WorktreeProgressRow): string {
  const text = (value: string): string => currentTheme.fg('text', value);
  const detail = (value: string): string => currentTheme.fg('textDim', `  ${value}`);
  switch (row.step) {
    case 'check': {
      const sourceDir = abbreviateHome(row.sourceDir);
      return text(
        row.status === 'running' ? `Checking ${sourceDir}` : row.status === 'done' ? `Checked ${sourceDir}` : `Couldn't check ${sourceDir}`,
      );
    }
    case 'add': {
      const path = abbreviateHome(row.path);
      if (row.status === 'running') return text(`Creating ${path}`);
      if (row.status === 'failed') return text(`Couldn't create ${path}`);
      return text(`Created ${path}`) + detail(`detached at ${row.head.slice(0, WORKTREE_SHORT_SHA_LENGTH)}`);
    }
    case 'include': {
      if (row.status === 'running') return text(`Copying files from ${INCLUDE_FILE}`);
      if (row.status === 'failed') return text(`Couldn't copy files from ${INCLUDE_FILE}`);
      const count = row.copiedFiles.length;
      const listed = row.copiedFiles.slice(0, WORKTREE_LISTED_FILES).join(', ');
      const more = count > WORKTREE_LISTED_FILES ? ` +${String(count - WORKTREE_LISTED_FILES)} more` : '';
      return text(`Copied ${String(count)} ${count === 1 ? 'file' : 'files'} from ${INCLUDE_FILE}`) + detail(`${listed}${more}`);
    }
    case 'setup': {
      if (row.status === 'running') return text(`Running ${row.script}`);
      if (row.status === 'done') return text(`Ran ${row.script}`);
      return text(
        row.exitCode === undefined ? 'Setup script was interrupted' : `Setup script exited with code ${String(row.exitCode)}`,
      );
    }
    case 'remove': {
      const path = abbreviateHome(row.path);
      return text(row.status === 'running' ? `Deleting ${path}` : row.status === 'done' ? `Deleted ${path}` : `Couldn't delete ${path}`);
    }
  }
}

function enteredNotes(progress: Extract<WorktreeProgress, { phase: 'entered' }>): string[] {
  const notes: string[] = [];
  if (progress.sourceDirty) {
    notes.push(`Uncommitted changes in ${abbreviateHome(progress.sourceDir)} stay there.`);
  }
  if (progress.missingSubdir !== undefined) {
    notes.push(`${progress.missingSubdir} doesn't exist at this commit, so the session starts at the worktree root.`);
  }
  return notes;
}

function wrapped(prefix: string, text: string, width: number): string[] {
  const indent = ' '.repeat(visibleWidth(prefix));
  return wrapTextWithAnsi(text, Math.max(1, width - indent.length)).map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${indent}${line}`,
  );
}
