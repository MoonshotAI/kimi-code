import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  type TuiMode,
  truncateToWidth,
} from '@moonshot-ai/pi-tui';
import {
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  FOLLOW_UP_KEYMAP,
  type FollowUpBehavior,
  type FollowUpDelivery,
} from '#/tui/config';
import { currentTheme } from '#/tui/theme';

export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

export interface HelpPanelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

const SUBMIT_DESCRIPTIONS: Readonly<Record<FollowUpDelivery, string>> = {
  default: 'Submit; queues while Kimi is working',
  'steer-draft': 'Submit; steers into the running turn',
  queue: 'Submit; queues while Kimi is working',
};

export function keyboardShortcuts(
  followUpBehavior: FollowUpBehavior,
  ctrlEnterRecognized: boolean,
  tuiMode: TuiMode = 'regular',
): readonly KeyboardShortcut[] {
  const submit = FOLLOW_UP_KEYMAP[followUpBehavior];
  return [
    { keys: 'Shift-Tab', description: 'Toggle plan mode' },
    ...(tuiMode === 'fullscreen' ? [{ keys: 'Ctrl-F', description: 'Search conversation' }] : []),
    { keys: 'Ctrl-G', description: 'Edit in external editor ($VISUAL / $EDITOR)' },
    { keys: 'Ctrl-O', description: 'Toggle tool output / compaction summary expansion' },
    { keys: 'Ctrl-S', description: 'Steer — inject a follow-up during streaming' },
    { keys: 'Shift-Enter / Ctrl-J', description: 'Insert newline' },
    { keys: 'Ctrl-C', description: 'Interrupt stream / clear input' },
    { keys: 'Ctrl-D', description: 'Exit (on empty input)' },
    { keys: 'Esc', description: 'Close dialogs / interrupt streaming' },
    { keys: '↑ / ↓', description: 'Browse input history' },
    { keys: 'Enter', description: SUBMIT_DESCRIPTIONS[submit.enter] },
    ...(ctrlEnterRecognized ? [{ keys: 'Ctrl-Enter', description: SUBMIT_DESCRIPTIONS[submit['mod-enter']] }] : []),
    { keys: 'Ctrl-Q', description: SUBMIT_DESCRIPTIONS[submit['ctrl-q']] },
  ];
}

export const DEFAULT_KEYBOARD_SHORTCUTS = keyboardShortcuts(DEFAULT_FOLLOW_UP_BEHAVIOR, false);

export interface HelpPanelOptions {
  readonly commands: readonly HelpPanelCommand[];
  readonly shortcuts?: readonly KeyboardShortcut[];
  readonly onClose: () => void;
  readonly maxVisible?: number;
}

export class HelpPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: HelpPanelOptions;
  private scrollTop = 0;

  constructor(opts: HelpPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    const kbdColor = (text: string) => currentTheme.fg('warning', text);
    const slashColor = (text: string) => currentTheme.fg('primary', text);

    const shortcuts = this.opts.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS;
    const kbdWidth = Math.max(8, ...shortcuts.map((s) => s.keys.length));
    const sortedCmds = [...this.opts.commands].toSorted(compareSlashCommandsForDisplay);
    const cmdLabels = sortedCmds.map((c) => {
      const aliases = c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
      return `/${c.name}${aliases}`;
    });
    const cmdWidth = Math.max(12, ...cmdLabels.map((l) => l.length));
    const lines: string[] = [
      accent('─'.repeat(width)),
      currentTheme.boldFg('primary', ' help ') + muted('· Esc / Enter / q to cancel · ↑↓ scroll'),
      '',
      `  ${dim('Sure, Kimi is ready to help! Just send a message to get started.')}`,
      '',
      `  ${currentTheme.bold('Keyboard shortcuts')}`,
      ...shortcuts.map((s) => `    ${kbdColor(s.keys.padEnd(kbdWidth))}  ${dim(s.description)}`),
      '',
      `  ${currentTheme.bold('Slash commands')}`,
      ...sortedCmds.map((cmd, i) => {
        const label = cmdLabels[i] ?? `/${cmd.name}`;
        return `    ${slashColor(label.padEnd(cmdWidth))}  ${dim(cmd.description)}`;
      }),
      '',
      accent('─'.repeat(width)),
    ];

    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`,
      );
      return [lines[0] ?? '', ...slice, scrollInfo, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function compareSlashCommandsForDisplay(a: HelpPanelCommand, b: HelpPanelCommand): number {
  return (
    getSlashCommandDisplayGroup(a.name) - getSlashCommandDisplayGroup(b.name) ||
    a.name.localeCompare(b.name)
  );
}

function getSlashCommandDisplayGroup(name: string): number {
  return name.startsWith('skill:') ? 1 : 0;
}
