/**
 * HelpPanel — modal `/help` display. Lists keyboard shortcuts, slash
 * commands (with aliases + descriptions) in colour-coded sections.
 *
 * Mirrors the container-replacement pattern used by SessionPicker /
 * ApprovalPanel: host mounts the panel into `editorContainer`, picks
 * it as the focused component, and tears it down on the `onClose`
 * callback (fired on Esc / Enter / q).
 */

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { i18n } from '#/tui/i18n';
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

/**
 * Default keyboard shortcuts — keep in sync with the global editor bindings.
 *
 * Built at call time so the descriptions follow the active locale; the keys
 * (`Shift-Tab`, `Ctrl-G`, …) are identifiers and stay verbatim in every locale.
 */
export function defaultKeyboardShortcuts(): readonly KeyboardShortcut[] {
  return [
    { keys: 'Shift-Tab', description: i18n.t('commands.help.shortcuts.planMode') },
    { keys: 'Ctrl-G', description: i18n.t('commands.help.shortcuts.externalEditor') },
    { keys: 'Ctrl-O', description: i18n.t('commands.help.shortcuts.toolOutput') },
    { keys: 'Ctrl-S', description: i18n.t('commands.help.shortcuts.steer') },
    { keys: 'Shift-Enter / Ctrl-J', description: i18n.t('commands.help.shortcuts.newline') },
    { keys: 'Ctrl-C', description: i18n.t('commands.help.shortcuts.interrupt') },
    { keys: 'Ctrl-D', description: i18n.t('commands.help.shortcuts.exit') },
    { keys: 'Esc', description: i18n.t('commands.help.shortcuts.closeDialogs') },
    { keys: '↑ / ↓', description: i18n.t('commands.help.shortcuts.history') },
    { keys: 'Enter', description: i18n.t('commands.help.shortcuts.submit') },
  ];
}

export interface HelpPanelOptions {
  readonly commands: readonly HelpPanelCommand[];
  readonly shortcuts?: readonly KeyboardShortcut[];
  readonly onClose: () => void;
  /** Terminal height — used to decide whether to show the hint tail. */
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
      this.scrollTop += 1; // render clamps
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

    const shortcuts = this.opts.shortcuts ?? defaultKeyboardShortcuts();
    const kbdWidth = Math.max(8, ...shortcuts.map((s) => s.keys.length));
    const sortedCmds = [...this.opts.commands].toSorted(compareSlashCommandsForDisplay);
    const cmdLabels = sortedCmds.map((c) => {
      const aliases = c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
      return `/${c.name}${aliases}`;
    });
    const cmdWidth = Math.max(12, ...cmdLabels.map((l) => l.length));
    const lines: string[] = [
      accent('─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${i18n.t('commands.help.title')} `) +
        muted(i18n.t('commands.help.dismiss')),
      '',
      // Greeting
      `  ${dim(i18n.t('commands.help.greeting'))}`,
      '',
      // Section: keyboard shortcuts
      `  ${currentTheme.bold(i18n.t('commands.help.keyboardShortcuts'))}`,
      ...shortcuts.map((s) => `    ${kbdColor(s.keys.padEnd(kbdWidth))}  ${dim(s.description)}`),
      '',
      // Section: slash commands
      `  ${currentTheme.bold(i18n.t('commands.help.slashCommands'))}`,
      ...sortedCmds.map((cmd, i) => {
        const label = cmdLabels[i] ?? `/${cmd.name}`;
        return `    ${slashColor(label.padEnd(cmdWidth))}  ${dim(cmd.description)}`;
      }),
      '',
      accent('─'.repeat(width)),
    ];

    // Apply scroll windowing — keep the borders visible.
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ' ' +
          i18n.t('commands.help.showing', {
            start: this.scrollTop + 1,
            end: this.scrollTop + slice.length,
            total: content.length,
          }),
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
