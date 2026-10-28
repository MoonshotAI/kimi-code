import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

import { paintHoverRow } from './hover-row';

export type StartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface StartPermissionOption<TChoice extends StartPermissionChoice = StartPermissionChoice> {
  readonly value: TChoice;
  readonly label: string;
  readonly description: string;
}

export interface StartPermissionPromptOptions<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> {
  readonly title: string;
  readonly noticeLines: readonly string[];
  readonly options: readonly StartPermissionOption<TChoice>[];
  readonly onSelect: (choice: TChoice) => void;
  readonly onCancel: () => void;
  readonly layout?: DockLayout;
}

export class StartPermissionPromptComponent<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> extends DockSection implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private choiceRows: readonly number[] = [];
  /** Option under the pointer: highlighted and previewed, but not selected. */
  private hoverIndex: number | undefined;
  /** A click this soon after the prompt appeared was aimed at what was there before. */
  private readonly shownAt = Date.now();

  constructor(private readonly opts: StartPermissionPromptOptions<TChoice>) {
    super(opts.layout);
  }

  handleInput(data: string): void {
    this.hoverIndex = undefined;
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (this.layout !== undefined && (matchesKey(data, 'shift+up') || matchesKey(data, 'shift+down'))) {
      this.scrollBody(matchesKey(data, 'shift+up') ? -1 : 1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.opts.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(this.opts.options[this.selectedIndex]!.value);
    }
  }

  protected renderPart(part: DockPart, width: number): string[] {
    switch (part) {
      case 'head': {
        const lines = [
          currentTheme.fg('primary', '─'.repeat(width)),
          currentTheme.boldFg('primary', ` ${this.opts.title}`),
        ];
        if (this.layout === undefined) {
          lines.push(currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'));
        }
        lines.push('');
        return lines.map((line) => truncateToWidth(line, width));
      }
      case 'body': {
        const lines: string[] = [];
        const textWidth = Math.max(20, width - 2);
        for (const paragraph of this.opts.noticeLines) {
          for (const line of wrapPlain(paragraph, textWidth)) {
            lines.push(` ${styleModeNames(line, 'textMuted')}`);
          }
          lines.push('');
        }
        return lines.map((line) => truncateToWidth(line, width));
      }
      case 'foot':
        return this.renderFoot(width);
    }
  }

  private renderFoot(width: number): string[] {
    const docked = this.layout !== undefined;
    const hoverBackground = this.focused ? currentTheme.hoverBackground() : undefined;
    const hovered = hoverBackground === undefined ? undefined : this.hoverIndex;
    const lines: string[] = [];
    const choiceRows: number[] = [];
    for (let i = 0; i < this.opts.options.length; i += 1) {
      const option = this.opts.options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const label = styleLabel(option.label, selected);
      choiceRows.push(lines.length);
      const line =
        currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) + label;
      lines.push(
        i === hovered && hoverBackground !== undefined
          ? paintHoverRow(line, width, hoverBackground)
          : line,
      );
      if (!docked) {
        for (const line of wrapPlain(option.description, Math.max(20, width - 4))) {
          lines.push(`    ${styleModeNames(line, 'textMuted')}`);
        }
        lines.push('');
      }
    }
    this.choiceRows = choiceRows;

    if (docked) {
      const descriptions = this.opts.options.map((option) =>
        wrapPlain(option.description, Math.max(20, width - 4)),
      );
      const areaHeight = Math.min(3, Math.max(0, ...descriptions.map((rows) => rows.length)));
      if (areaHeight > 0) {
        const rows = descriptions[hovered ?? this.selectedIndex] ?? [];
        lines.push('');
        for (let row = 0; row < areaHeight; row += 1) {
          const cut = row === areaHeight - 1 && rows.length > areaHeight;
          const text = cut
            ? `${truncateToWidth(rows[row]!, Math.max(1, width - 5), '')}…`
            : (rows[row] ?? '');
          lines.push(`    ${styleModeNames(text, 'textMuted')}`);
        }
      }
      const scrollHint = this.bodyOverflows(width) ? ' · shift+↑/↓ scroll' : '';
      lines.push('');
      lines.push(currentTheme.fg('textMuted', ` ↑↓ navigate · Enter select · Esc cancel${scrollHint}`));
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (this.layout === undefined) return undefined;
    const index = part === 'foot' ? this.choiceRows.indexOf(event.y) : -1;
    if (event.type === 'move') {
      const hovered = index === -1 ? undefined : index;
      if (hovered === this.hoverIndex) return index === -1 ? undefined : { handled: true };
      this.hoverIndex = hovered;
      return { handled: true, render: true };
    }
    if (index === -1 || event.button !== 'left') return undefined;
    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      this.opts.onSelect(this.opts.options[index]!.value);
    }
    return { handled: true };
  }
}

function styleLabel(label: string, selected: boolean): string {
  if (selected) return currentTheme.boldFg('primary', label);
  return styleModeNames(label, 'text');
}

function styleModeNames(text: string, baseToken: 'text' | 'textMuted'): string {
  return text
    .split(/(\b(?:Always Ask|Ask When Needed|Never Ask)\b)/g)
    .map((part) => {
      if (part === 'Always Ask' || part === 'Ask When Needed' || part === 'Never Ask') return currentTheme.boldFg('textStrong', part);
      return currentTheme.fg(baseToken, part);
    })
    .join('');
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= width ? word : truncateToWidth(word, width, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
