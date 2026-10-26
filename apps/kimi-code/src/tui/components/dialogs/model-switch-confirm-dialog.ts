/**
 * ModelSwitchConfirmDialog — cloud-gated confirmation shown when switching
 * models in a session that already has conversation history: the accumulated
 * context will be re-sent to a different model, so the prompt cache is lost
 * and output quality may vary. Offers new session / compact / continue /
 * cancel.
 *
 * The body hint comes from the matched `model_switch_confirm` rule (English
 * arm over the built-in default); the title, option labels, and keyboard hint
 * stay local per the DESIGN.md vocabulary. Layout mirrors the list-dialog
 * spec: top border, title, hint, body line, then options with right-column
 * descriptions.
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

const TITLE = 'Switch model?';

interface ModelSwitchOption {
  readonly value: ModelSwitchAction;
  readonly label: string;
  readonly description?: string;
}

const OPTIONS: readonly ModelSwitchOption[] = [
  {
    value: 'new',
    label: 'Start a new session',
    description: 'No extra cost · best for a new task',
  },
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

export interface ModelSwitchConfirmDialogOptions {
  /** Display name of the model in effect before the switch. */
  readonly fromModel: string;
  /** Display name of the model the user is switching to. */
  readonly toModel: string;
  /** Body text explaining the consequences of the switch; no body line when
   *  absent. */
  readonly hint?: string;
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
      items: OPTIONS,
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
    const modelSuffix = `${this.opts.fromModel} → ${this.opts.toModel}`;
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${TITLE}`) +
        currentTheme.fg('textMuted', `  ${modelSuffix}`),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
    ];
    if (this.opts.hint !== undefined) {
      for (const hintLine of this.opts.hint.split(/\r\n|\r|\n/)) {
        lines.push(currentTheme.fg('text', ` ${hintLine}`));
      }
    }

    const maxLabelWidth = Math.max(...OPTIONS.map((o) => visibleWidth(o.label)));
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
