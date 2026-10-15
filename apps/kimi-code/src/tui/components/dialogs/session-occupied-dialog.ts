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

export type SessionOccupiedAction = 'retry' | 'cancel';

interface SessionOccupiedOption {
  readonly value: SessionOccupiedAction;
  readonly label: string;
  readonly description?: string;
}

const OPTIONS: readonly SessionOccupiedOption[] = [
  { value: 'retry', label: 'Retry', description: 'send again now' },
  { value: 'cancel', label: 'Cancel', description: 'get your message back' },
];

export interface SessionOccupiedDialogOptions {
  readonly client: string;
  readonly onSelect: (action: SessionOccupiedAction) => void;
  readonly onCancel: () => void;
}

export class SessionOccupiedDialogComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: SessionOccupiedDialogOptions;
  private readonly list: SearchableList<SessionOccupiedOption>;

  constructor(opts: SessionOccupiedDialogOptions) {
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
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` Session in use by ${this.opts.client}`),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
      currentTheme.fg(
        'text',
        ' Another client is running this session (turn, approval, or background task).',
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
