/**
 * DiffFileSelector — lets the user pick a changed file to view its diff.
 *
 * Files may come from explicit session edits (Edit/Write tool calls) or from
 * the git working tree as a fallback. Multiple sources are shown as tabs.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '../../theme';
import { SearchableList } from '../../utils/searchable-list';
import { renderTabStrip } from '../../utils/tab-strip';

const MAX_VISIBLE_CHOICES = 8;
const PREFERRED_SELECTED_OFFSET = 3;

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'untracked';

export interface DiffSelectorFile {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly source: 'session' | 'git';
  readonly turnId?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface DiffSource {
  readonly label: string;
  readonly subtitle?: string;
  readonly files: readonly DiffSelectorFile[];
}

export interface DiffFileSelectorOptions {
  readonly sources: readonly DiffSource[];
  readonly initialSourceIndex?: number;
  readonly initialSelectedIndex?: number;
  readonly onSelect: (file: DiffSelectorFile) => void;
  readonly onCancel: () => void;
}

function statusLabel(status: DiffFileStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'untracked':
      return '?';
  }
}

function statusWord(status: DiffFileStatus): string | undefined {
  switch (status) {
    case 'modified':
      return 'modified';
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'untracked':
      return 'untracked';
  }
}

export class DiffFileSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: DiffFileSelectorOptions;
  private list: SearchableList<DiffSelectorFile>;
  private submitted = false;
  private activeSourceIndex = 0;
  private readonly selectedIndexBySource: number[];

  constructor(opts: DiffFileSelectorOptions) {
    super();
    this.opts = opts;
    this.activeSourceIndex = opts.initialSourceIndex ?? 0;
    this.selectedIndexBySource = Array.from({ length: opts.sources.length }, () => 0);
    this.selectedIndexBySource[this.activeSourceIndex] = opts.initialSelectedIndex ?? 0;
    this.list = this.buildList();
  }

  getActiveSourceIndex(): number {
    return this.activeSourceIndex;
  }

  private get activeSource(): DiffSource {
    return this.opts.sources[this.activeSourceIndex] ?? { label: '', files: [] };
  }

  private buildList(): SearchableList<DiffSelectorFile> {
    return new SearchableList({
      items: this.activeSource.files,
      toSearchText: (file) => file.path,
      initialIndex: this.selectedIndexBySource[this.activeSourceIndex] ?? 0,
    });
  }

  getSelectedIndex(): number {
    return this.list.view().selectedIndex;
  }

  handleInput(data: string): void {
    if (this.submitted) return;

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (matchesKey(data, Key.left)) {
      if (this.activeSourceIndex > 0) {
        this.selectedIndexBySource[this.activeSourceIndex] = this.list.view().selectedIndex;
        this.activeSourceIndex--;
        this.list = this.buildList();
      }
      return;
    }

    if (matchesKey(data, Key.right)) {
      if (this.activeSourceIndex < this.opts.sources.length - 1) {
        this.selectedIndexBySource[this.activeSourceIndex] = this.list.view().selectedIndex;
        this.activeSourceIndex++;
        this.list = this.buildList();
      }
      return;
    }

    if (this.list.handleKey(data)) {
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.submitted = true;
        this.opts.onSelect(selected);
      }
    }
  }

  override render(width: number): string[] {
    const source = this.activeSource;
    const view = this.list.view();
    const hintParts = ['←/→ source', '↑↓ navigate', 'type to filter', 'Enter select', 'Esc cancel'];

    let topInfo: string;
    if (source.subtitle !== undefined && source.subtitle.length > 0) {
      topInfo = this.renderSubtitle(source.subtitle);
    } else if (this.activeSourceIndex === 0) {
      topInfo = ` ${currentTheme.boldFg('primary', 'Uncommitted changes')} ${currentTheme.fg('textMuted', '(git diff HEAD)')}`;
    } else {
      topInfo = ` ${currentTheme.boldFg('primary', source.label)}`;
    }

    const { totalAdditions, totalDeletions, maxRightWidth } = this.computeSourceMetrics(source);
    const summaryParts: string[] = [
      `${String(source.files.length)} file${source.files.length === 1 ? '' : 's'} changed`,
    ];
    if (totalAdditions > 0) {
      summaryParts.push(currentTheme.fg('diffAdded', `+${String(totalAdditions)}`));
    }
    if (totalDeletions > 0) {
      summaryParts.push(currentTheme.fg('diffRemoved', `-${String(totalDeletions)}`));
    }

    const fileLines: string[] = [];
    if (view.items.length === 0) {
      fileLines.push(currentTheme.fg('textMuted', '   No changed files'));
    } else {
      const visibleCount = Math.min(MAX_VISIBLE_CHOICES, view.items.length);
      const maxStart = view.items.length - visibleCount;
      const start = Math.min(
        Math.max(0, view.selectedIndex - PREFERRED_SELECTED_OFFSET),
        maxStart,
      );
      const end = start + visibleCount;

      for (let i = start; i < end; i++) {
        const file = view.items[i];
        if (file === undefined) continue;
        fileLines.push(this.renderFileLine(file, i === view.selectedIndex, width, maxRightWidth));
      }
    }

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      topInfo,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      renderTabStrip({
        labels: this.opts.sources.map((s) => s.label),
        activeIndex: this.activeSourceIndex,
        width,
        colors: currentTheme.palette,
      }),
      currentTheme.fg('textMuted', '  ' + summaryParts.join(' ')),
      '',
      ...fileLines,
      '',
      currentTheme.fg('primary', '─'.repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderSubtitle(subtitle: string): string {
    const match = /^Turn (\d+) "(.*)"$/.exec(subtitle);
    if (match === null) {
      return currentTheme.boldFg('primary', ` ${subtitle}`);
    }
    const turnNumber = match[1]!;
    const prompt = match[2]!;
    return ` ${currentTheme.boldFg('primary', `Turn ${turnNumber}`)} ${currentTheme.fg('textMuted', `"${prompt}"`)}`;
  }

  private computeSourceMetrics(
    source: DiffSource,
  ): { totalAdditions: number; totalDeletions: number; maxRightWidth: number } {
    let totalAdditions = 0;
    let totalDeletions = 0;
    let maxRightWidth = 0;
    for (const file of source.files) {
      totalAdditions += file.additions ?? 0;
      totalDeletions += file.deletions ?? 0;
      const rightWidth = visibleWidth(this.buildRightText(file));
      if (rightWidth > maxRightWidth) {
        maxRightWidth = rightWidth;
      }
    }
    return { totalAdditions, totalDeletions, maxRightWidth };
  }

  private buildRightText(file: DiffSelectorFile): string {
    const statParts: string[] = [];
    if (file.additions !== undefined && file.additions > 0) {
      statParts.push(currentTheme.fg('diffAdded', `+${String(file.additions)}`));
    }
    if (file.deletions !== undefined && file.deletions > 0) {
      statParts.push(currentTheme.fg('diffRemoved', `-${String(file.deletions)}`));
    }
    if (statParts.length > 0) {
      return statParts.join(' ');
    }
    const word = statusWord(file.status);
    return word !== undefined ? currentTheme.fg('textMuted', word) : '';
  }

  private renderFileLine(
    file: DiffSelectorFile,
    isSelected: boolean,
    width: number,
    maxRightWidth: number,
  ): string {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const status = statusLabel(file.status);
    const rightText = this.buildRightText(file);
    const rightPadding = ' '.repeat(Math.max(0, maxRightWidth - visibleWidth(rightText)));
    const prefix = `  ${pointer} ${status} `;
    const separatorWidth = 1;
    const labelBudget = Math.max(8, width - visibleWidth(prefix) - maxRightWidth - separatorWidth);
    const label = truncateToWidth(file.path, labelBudget, '…', true);
    const token = isSelected ? 'primary' : 'text';
    let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', prefix);
    line += isSelected ? currentTheme.boldFg(token, label) : currentTheme.fg(token, label);
    line += ' ' + rightPadding + rightText;
    return line;
  }
}
