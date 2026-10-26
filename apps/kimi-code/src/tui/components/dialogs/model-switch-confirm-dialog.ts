/**
 * Cloud-gated model or effort confirmation. Model switches keep their
 * session-specific actions; effort switches offer only confirm and cancel.
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
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

export class ModelSwitchConfirmDialogComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSwitchConfirmDialogOptions;
  private readonly list: SearchableList<ModelSwitchOption>;

  constructor(opts: ModelSwitchConfirmDialogOptions) {
    super();
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

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
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
      const isSelected = i === view.selectedIndex;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += isSelected
        ? currentTheme.boldFg('primary', opt.label)
        : currentTheme.fg('text', opt.label);
      if (opt.description !== undefined) {
        const gap = maxLabelWidth - visibleWidth(opt.label) + 4;
        line += ' '.repeat(gap) + currentTheme.fg('textMuted', opt.description);
      }
      lines.push(line);
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
