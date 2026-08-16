/**
 * Cron task selector — lists the session's scheduled cron tasks and deletes
 * the selected one after an inline [y/N] confirmation. Not searchable, so
 * `D` is free to mean delete.
 */
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { CronTaskSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { SearchableList } from '#/tui/utils/searchable-list';

const PROMPT_PREVIEW_LENGTH = 60;

export interface CronSelectorOptions {
  readonly tasks: readonly CronTaskSnapshot[];
  readonly onDelete: (task: CronTaskSnapshot) => void;
  readonly onCancel: () => void;
}

function formatNextFire(nextFireAt: number | null): string {
  if (nextFireAt === null) return 'no future fire';
  const date = new Date(nextFireAt);
  const two = (value: number): string => value.toString().padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function promptPreview(prompt: string): string {
  const flat = sanitizeShellOutput(prompt).replaceAll(/\s+/g, ' ').trim();
  return flat.length > PROMPT_PREVIEW_LENGTH ? `${flat.slice(0, PROMPT_PREVIEW_LENGTH)}…` : flat;
}

export class CronSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CronSelectorOptions;
  private readonly list: SearchableList<CronTaskSnapshot>;
  private pendingDeleteId: string | undefined;
  private submitted = false;

  constructor(opts: CronSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.tasks,
      toSearchText: (task) => task.id,
    });
  }

  handleInput(data: string): void {
    if (this.submitted) return;

    if (this.pendingDeleteId !== undefined) {
      const ch = printableChar(data);
      if (ch === 'y' || ch === 'Y') {
        const task = this.list.selected();
        this.submitted = true;
        if (task !== undefined) {
          this.opts.onDelete(task);
        } else {
          this.opts.onCancel();
        }
      } else {
        this.pendingDeleteId = undefined;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (this.list.handleKey(data)) {
      this.invalidate();
      return;
    }

    const ch = printableChar(data);
    if (ch === 'd' || ch === 'D') {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.pendingDeleteId = selected.id;
        this.invalidate();
      }
    }
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const confirming = this.pendingDeleteId !== undefined;
    const hint = confirming
      ? 'Y confirm · N keep'
      : '↑↓ navigate · D delete · Esc cancel';

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Scheduled cron tasks'),
      currentTheme.fg('textMuted', ' ' + hint),
      '',
    ];

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No scheduled cron tasks'));
    } else {
      const { start, end } = view.page;
      for (let i = start; i < end; i++) {
        const task = view.items[i];
        if (task === undefined) continue;
        lines.push(...this.renderTask(task, i === view.selectedIndex, confirming, width));
      }
      if (end < view.items.length) {
        lines.push(currentTheme.fg('textMuted', `  ▼ ${view.items.length - end} more`));
      }
    }

    if (confirming) {
      const task = this.list.selected();
      lines.push('');
      lines.push(
        currentTheme.boldFg(
          'warning',
          ` Delete cron task ${task?.id ?? ''} (${task?.cron ?? ''})? [y/N]`,
        ),
      );
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderTask(
    task: CronTaskSnapshot,
    isSelected: boolean,
    confirming: boolean,
    width: number,
  ): string[] {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const prefix = `  ${pointer} `;
    const cronBudget = Math.max(8, width - visibleWidth(prefix));
    const cronLabel = truncateToWidth(task.cron, cronBudget, '…');
    const nameLine =
      currentTheme.fg(isSelected ? 'primary' : 'textDim', prefix) +
      (isSelected && !confirming
        ? currentTheme.boldFg('primary', cronLabel)
        : currentTheme.fg('text', cronLabel));

    const detail =
      `    next ${formatNextFire(task.nextFireAt)} · ` +
      `${task.recurring ? 'recurring' : 'one-shot'} · ${promptPreview(task.prompt)}`;
    const detailLine = currentTheme.fg('textMuted', truncateToWidth(detail, width, '…'));
    return [nameLine, detailLine];
  }
}
