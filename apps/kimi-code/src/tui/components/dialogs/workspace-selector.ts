import type { ManagedWorkspace } from '@moonshot-ai/kimi-code-sdk';
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

interface WorkspaceChoice {
  readonly workspace: ManagedWorkspace;
  readonly name: string;
  readonly secondaryLabel: string;
  readonly searchText: string;
}

interface ChoiceRegion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

export interface WorkspaceSelectorOptions {
  readonly workspaces: readonly ManagedWorkspace[];
  readonly pageSize?: number;
  readonly onSelect: (workspace: ManagedWorkspace) => void;
  readonly onCancel: () => void;
}

const DISABLED_WORKSPACE_WARNING =
  'This business workspace is disabled and cannot be selected.';

function shortBusinessId(businessId: string): string {
  return businessId.length <= 8 ? businessId : businessId.slice(-8);
}

function buildWorkspaceChoices(workspaces: readonly ManagedWorkspace[]): readonly WorkspaceChoice[] {
  const businessNameCounts = new Map<string, number>();
  for (const ws of workspaces) {
    if (ws.kind !== 'business') continue;
    businessNameCounts.set(ws.name, (businessNameCounts.get(ws.name) ?? 0) + 1);
  }

  return workspaces.map((ws) => {
    const duplicate =
      ws.kind === 'business' && (businessNameCounts.get(ws.name) ?? 0) > 1;
    const secondaryLabel = duplicate
      ? `${ws.kindLabel} · ${shortBusinessId(ws.businessId)}`
      : ws.kindLabel;
    const searchText =
      ws.kind === 'business'
        ? `${ws.name} ${ws.kindLabel} ${ws.businessId}`
        : `${ws.name} ${ws.kindLabel}`;
    return {
      workspace: ws,
      name: ws.name,
      secondaryLabel,
      searchText,
    };
  });
}

export class WorkspaceSelectorComponent implements Component, Focusable {
  focused = false;
  private readonly opts: WorkspaceSelectorOptions;
  private readonly list: SearchableList<WorkspaceChoice>;
  private readonly totalCount: number;
  private readonly shownAt = Date.now();
  private choiceRegions: readonly ChoiceRegion[] = [];
  private warning: string | undefined;

  constructor(opts: WorkspaceSelectorOptions) {
    this.opts = opts;
    const choices = buildWorkspaceChoices(opts.workspaces);
    this.totalCount = choices.length;
    const currentIdx = choices.findIndex((choice) => choice.workspace.current);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.searchText,
      pageSize: opts.pageSize,
      initialIndex: Math.max(currentIdx, 0),
      searchable: true,
    });
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.warning = undefined;
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.warning = undefined;
      this.list.pageUp();
      return;
    }

    if (matchesKey(data, Key.right)) {
      this.warning = undefined;
      this.list.pageDown();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) this.confirmChoice(selected);
      return;
    }

    if (this.list.handleKey(data)) {
      this.warning = undefined;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) {
      return event.type === 'click'
        ? { handled: true, focus: true }
        : event.type === 'press'
          ? { handled: true }
          : undefined;
    }

    if (event.type === 'wheel') {
      const view = this.list.view();
      if (event.wheelDelta !== undefined && event.wheelDelta !== 0) {
        const before = view.selectedIndex;
        if (view.page.pageCount > 1) {
          if (event.wheelDelta < 0) this.list.pageUp();
          else this.list.pageDown();
        } else if (event.wheelDelta < 0) {
          this.list.moveUp();
        } else {
          this.list.moveDown();
        }
        const changed = this.list.view().selectedIndex !== before;
        if (changed) this.warning = undefined;
        return { handled: true, render: changed };
      }
      return { handled: true };
    }

    if (event.type === 'move') {
      const index = this.choiceIndexAt(event.y);
      if (index === undefined) return undefined;
      return { handled: true, render: this.selectIndex(index) };
    }

    if (event.button !== 'left') return undefined;
    const index = this.choiceIndexAt(event.y);
    if (index === undefined) return undefined;

    if (event.type === 'press') {
      return { handled: true, render: this.selectIndex(index) };
    }

    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      const moved = this.selectIndex(index);
      const chosen = this.list.view().items[index];
      const warningChanged = chosen === undefined ? false : this.confirmChoice(chosen);
      return { handled: true, render: moved || warningChanged };
    }

    return { handled: true };
  }

  private choiceIndexAt(y: number): number | undefined {
    return this.choiceRegions.find((region) => y >= region.start && y < region.end)?.index;
  }

  private selectIndex(index: number): boolean {
    const changed = this.list.view().selectedIndex !== index;
    this.list.moveTo(index);
    if (changed) this.warning = undefined;
    return changed;
  }

  private confirmChoice(choice: WorkspaceChoice): boolean {
    if (!choice.workspace.switchable) {
      const changed = this.warning !== DISABLED_WORKSPACE_WARNING;
      this.warning = DISABLED_WORKSPACE_WARNING;
      return changed;
    }
    const changed = this.warning !== undefined;
    this.warning = undefined;
    this.opts.onSelect(choice.workspace);
    return changed;
  }

  private renderChoiceRow(choice: WorkspaceChoice, isSelected: boolean, nameWidth: number): string {
    const isDisabled = choice.workspace.disabled;
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
    const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
    const renderedName = isSelected
      ? currentTheme.boldFg('primary', truncatedName)
      : isDisabled
        ? currentTheme.fg('textDim', truncatedName)
        : currentTheme.fg('text', truncatedName);

    const parts: string[] = [
      currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `) + renderedName + namePad,
      '  ' + currentTheme.fg('textMuted', choice.secondaryLabel),
    ];
    if (isDisabled) {
      parts.push('  ' + currentTheme.fg('textDim', 'disabled'));
    }
    if (choice.workspace.current) {
      parts.push(' ' + currentTheme.fg('success', CURRENT_MARK));
    }
    return parts.join('');
  }

  render(width: number): string[] {
    const view = this.list.view();
    const border = currentTheme.fg('primary', '─'.repeat(width));
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';

    const hintParts: string[] = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    if (view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select', 'Esc cancel');

    const lines: string[] = [
      border,
      currentTheme.boldFg('primary', ' Switch workspace') + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
    ];

    if (this.warning !== undefined) {
      for (const line of wrapTextWithAnsi(this.warning, Math.max(1, width - 1))) {
        lines.push(currentTheme.fg('warning', ` ${line}`));
      }
    }

    lines.push('');

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    const pageChoices = view.items.slice(view.page.start, view.page.end);
    const choiceRegions: ChoiceRegion[] = [];
    if (pageChoices.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    } else {
      const nameWidth = Math.min(
        Math.max(8, Math.floor(width * 0.5)),
        Math.max(0, ...pageChoices.map((choice) => visibleWidth(choice.name))),
      );

      for (const [offset, choice] of pageChoices.entries()) {
        const itemIndex = view.page.start + offset;
        const start = lines.length;
        lines.push(this.renderChoiceRow(choice, itemIndex === view.selectedIndex, nameWidth));
        choiceRegions.push({ start, end: lines.length, index: itemIndex });
      }
    }
    this.choiceRegions = choiceRegions;

    const remainingBelow = view.items.length - view.page.end;
    const footerNote =
      view.query.length > 0
        ? ` ${String(view.items.length)} / ${String(this.totalCount)}`
        : remainingBelow > 0
          ? ` ▼ ${String(remainingBelow)} more`
          : undefined;
    if (footerNote !== undefined) {
      lines.push('', currentTheme.fg('textMuted', footerNote));
    }

    lines.push('', border);
    const rendered = lines.map((line) => truncateToWidth(line, width));
    return this.focused ? rendered : rendered.map((line) => currentTheme.fade(line));
  }
}
