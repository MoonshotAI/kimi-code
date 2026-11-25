import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { ListMouseTracker } from '#/tui/utils/mouse-regions';
import { SearchableList } from '#/tui/utils/searchable-list';
import type { ModelSwitchAction } from '#/utils/model-switch-confirm-config';

const MODEL_TITLE = 'Switch model?';

interface ModelSwitchOption {
  readonly value: ModelSwitchAction;
  readonly label: string;
  readonly description?: string;
}

const OLD_SESSION_OPTIONS: readonly ModelSwitchOption[] = [
  {
    value: 'compact',
    label: 'Compact and continue',
    description: 'Lower cost and better output quality when continuing this session',
  },
  {
    value: 'continue',
    label: 'Continue as-is',
    description: 'Output quality may suffer · cache loss may increase token usage',
  },
  { value: 'cancel', label: 'Cancel', description: 'Stay on the current model' },
];

const NEW_SESSION_OPTIONS: readonly ModelSwitchOption[] = [
  { value: 'continue', label: 'Confirm switch' },
  { value: 'cancel', label: 'Cancel', description: 'Stay on the current model' },
];

const EFFORT_SESSION_OPTIONS: readonly ModelSwitchOption[] = [
  { value: 'continue', label: 'Confirm switch' },
  { value: 'cancel', label: 'Cancel', description: 'Stay on the current effort' },
];

export interface ModelSwitchConfirmDialogOptions {
  readonly fromModel: string;
  readonly toModel: string;
  readonly sessionType: 'old' | 'new';
  readonly kind?: 'model' | 'effort';
  readonly hint?: string;
  readonly warning?: string;
  readonly onSelect: (action: ModelSwitchAction) => void;
  readonly onCancel: () => void;
}

export class ModelSwitchConfirmDialogComponent implements Component, Focusable {
  focused = false;
  private readonly opts: ModelSwitchConfirmDialogOptions;
  private readonly list: SearchableList<ModelSwitchOption>;
  private readonly mouse = new ListMouseTracker<number>();

  constructor(opts: ModelSwitchConfirmDialogOptions) {
    this.opts = opts;
    this.list = new SearchableList({
      items:
        opts.kind === 'effort'
          ? EFFORT_SESSION_OPTIONS
          : opts.sessionType === 'old'
            ? OLD_SESSION_OPTIONS
            : NEW_SESSION_OPTIONS,
      toSearchText: (o) => o.label,
      initialIndex: 0,
      searchable: false,
    });
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.confirmSelected();
      return;
    }
    this.list.handleKey(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.mouse.handle(event, {
      focused: this.focused,
      onHover: (index) => this.list.selectIndex(index),
      onActivate: (index) => {
        this.list.selectIndex(index);
        this.confirmSelected();
      },
    });
  }

  private confirmSelected(): void {
    const chosen = this.list.selected();
    if (chosen !== undefined) this.opts.onSelect(chosen.value);
  }

  render(width: number): string[] {
    this.mouse.reset();
    const view = this.list.view();
    const title =
      this.opts.kind === 'effort'
        ? `Switch effort from ${this.opts.fromModel} to ${this.opts.toModel}?`
        : MODEL_TITLE;
    const titleSuffix =
      this.opts.kind === 'effort'
        ? ''
        : currentTheme.fg('textMuted', `  ${this.opts.fromModel} → ${this.opts.toModel}`);
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${title}`) + titleSuffix,
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
    ];
    if (this.opts.hint !== undefined) {
      for (const hintLine of this.opts.hint.split(/\r\n|\r|\n/)) {
        lines.push(currentTheme.fg('text', ` ${hintLine}`));
      }
    }
    if (this.opts.warning !== undefined) {
      for (const warningLine of this.opts.warning.split(/\r\n|\r|\n/)) {
        lines.push(currentTheme.boldFg('warning', ` ${warningLine}`));
      }
    }

    const maxLabelWidth = Math.max(...view.items.map((o) => visibleWidth(o.label)));
    for (let i = view.page.start; i < view.page.end; i++) {
      const opt = view.items[i]!;
      const selected = i === view.selectedIndex;
      this.mouse.track(lines, i, () => {
        const prefix = currentTheme.fg(
          selected ? 'primary' : 'textDim',
          `  ${selected ? SELECT_POINTER : ' '} `,
        );
        const label = selected
          ? currentTheme.boldFg('primary', opt.label)
          : currentTheme.fg('text', opt.label);
        const description =
          opt.description === undefined
            ? ''
            : ' '.repeat(maxLabelWidth - visibleWidth(opt.label) + 4) +
              currentTheme.fg('textMuted', opt.description);
        lines.push(`${prefix}${label}${description}`);
      });
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
