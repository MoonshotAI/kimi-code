import { currentTheme } from '#/tui/theme';
import type { ModelSwitchAction } from '#/utils/model-switch-confirm-config';

import {
  AlignedChoiceDialogComponent,
  type AlignedChoiceItem,
} from './aligned-choice-dialog';

const MODEL_TITLE = 'Switch model?';

const OLD_SESSION_OPTIONS: readonly AlignedChoiceItem<ModelSwitchAction>[] = [
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

const NEW_SESSION_OPTIONS: readonly AlignedChoiceItem<ModelSwitchAction>[] = [
  { value: 'continue', label: 'Confirm switch' },
  { value: 'cancel', label: 'Cancel', description: 'Stay on the current model' },
];

const EFFORT_SESSION_OPTIONS: readonly AlignedChoiceItem<ModelSwitchAction>[] = [
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

export class ModelSwitchConfirmDialogComponent extends AlignedChoiceDialogComponent<ModelSwitchAction> {
  private readonly opts: ModelSwitchConfirmDialogOptions;

  constructor(opts: ModelSwitchConfirmDialogOptions) {
    super(
      opts.kind === 'effort'
        ? EFFORT_SESSION_OPTIONS
        : opts.sessionType === 'old'
          ? OLD_SESSION_OPTIONS
          : NEW_SESSION_OPTIONS,
      opts.onSelect,
      opts.onCancel,
    );
    this.opts = opts;
  }

  protected renderHeaderLines(): string[] {
    const title =
      this.opts.kind === 'effort'
        ? `Switch effort from ${this.opts.fromModel} to ${this.opts.toModel}?`
        : MODEL_TITLE;
    const titleSuffix =
      this.opts.kind === 'effort'
        ? ''
        : currentTheme.fg('textMuted', `  ${this.opts.fromModel} → ${this.opts.toModel}`);
    const lines: string[] = [
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
    return lines;
  }
}
