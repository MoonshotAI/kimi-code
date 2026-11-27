import { currentTheme } from '#/tui/theme';
import { formatIdleDuration } from '#/tui/utils/cache-hint';
import { formatTokenCount } from '#/utils/usage/usage-format';

import {
  AlignedChoiceDialogComponent,
  type AlignedChoiceItem,
} from './aligned-choice-dialog';

export type CacheHintAction = 'compact' | 'new' | 'continue' | 'never';

const OPTIONS: readonly AlignedChoiceItem<CacheHintAction>[] = [
  {
    value: 'compact',
    label: 'Compact and continue',
    description: 'one-time compact cost · cheapest way to keep this topic',
  },
  {
    value: 'new',
    label: 'Start a new session',
    description: 'zero context cost · best for a new task',
  },
  {
    value: 'continue',
    label: 'Continue as-is',
    description: 'full history kept · highest cost per turn',
  },
  { value: 'never', label: "Don't ask me again" },
];

export interface CacheHintDialogOptions {
  readonly idleSeconds: number;
  readonly totalTokens: number;
  readonly onSelect: (action: CacheHintAction) => void;
  readonly onCancel: () => void;
}

export class CacheHintDialogComponent extends AlignedChoiceDialogComponent<CacheHintAction> {
  private readonly opts: CacheHintDialogOptions;

  constructor(opts: CacheHintDialogOptions) {
    super(OPTIONS, opts.onSelect, opts.onCancel);
    this.opts = opts;
  }

  protected renderHeaderLines(): string[] {
    const title = `This session has been idle for ${formatIdleDuration(this.opts.idleSeconds)} and is ~${formatTokenCount(this.opts.totalTokens)} tokens.`;
    return [
      currentTheme.boldFg('primary', ` ${title}`),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
      currentTheme.fg(
        'text',
        ' Cache expired — the next message re-sends the entire history at full price.',
      ),
    ];
  }
}
