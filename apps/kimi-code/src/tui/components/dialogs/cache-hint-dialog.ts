/**
 * CacheHintDialog — shown when a resumed (or long-idle) session's context
 * cache has almost certainly expired, so the next turn re-sends the whole
 * history uncached. Offers compact / new session / continue / never.
 *
 * Layout mirrors the list-dialog spec (DESIGN.md): top border, title, hint,
 * body line, then options with right-column descriptions.
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
import { formatIdleDuration } from '#/tui/utils/cache-hint';
import { SearchableList } from '#/tui/utils/searchable-list';
import { formatTokenCount } from '#/utils/usage/usage-format';

export type CacheHintAction = 'compact' | 'new' | 'continue' | 'never';

interface CacheHintOption {
  readonly value: CacheHintAction;
  readonly label: string;
  readonly description?: string;
}

const OPTIONS: readonly CacheHintOption[] = [
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

export class CacheHintDialogComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CacheHintDialogOptions;
  private readonly list: SearchableList<CacheHintOption>;

  constructor(opts: CacheHintDialogOptions) {
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
    const title = `This session has been idle for ${formatIdleDuration(this.opts.idleSeconds)} and is ~${formatTokenCount(this.opts.totalTokens)} tokens.`;
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${title}`),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
      currentTheme.fg(
        'text',
        ' Cache expired — the next message re-sends the entire history at full price.',
      ),
    ];

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
