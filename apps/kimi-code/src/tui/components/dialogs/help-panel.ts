import {
  matchesKey,
  Key,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from '@moonshot-ai/pi-tui';
import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import {
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  FOLLOW_UP_KEYMAP,
  type FollowUpBehavior,
  type FollowUpDelivery,
} from '#/tui/config';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedClick,
  renderInlineSegments,
  SpanHitMap,
  type InlineTarget,
} from '#/tui/utils/mouse-regions';
import { printableChar } from '#/tui/utils/printable-key';

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
): readonly KeyboardShortcut[] {
  const submit = FOLLOW_UP_KEYMAP[followUpBehavior];
  return [
    { keys: 'Shift-Tab', description: 'Toggle plan mode' },
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
  readonly layout?: DockLayout;
}

export class HelpPanelComponent extends DockSection implements Focusable {
  focused = false;
  private readonly opts: HelpPanelOptions;
  private readonly headHits = new SpanHitMap<'close'>();
  private readonly bodyHits = new SpanHitMap<'close'>();
  private scrollTop = 0;
  private maxRegularScrollTop = 0;

  constructor(opts: HelpPanelOptions) {
    super(opts.layout);
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = printableChar(data);
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (this.layout !== undefined) {
      if (matchesKey(data, Key.up)) {
        this.scrollBody(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.scrollBody(1);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.scrollBodyPage(-1);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.scrollBodyPage(1);
        return;
      }
      if (matchesKey(data, Key.home)) {
        this.scrollBodyToTop();
        return;
      }
      if (matchesKey(data, Key.end)) {
        this.scrollBodyToEnd();
      }
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
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollTop = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollTop = Number.MAX_SAFE_INTEGER;
    }
  }

  protected renderPart(part: DockPart, width: number): string[] {
    const renderWidth = Math.max(1, width);
    const accent = (text: string) => currentTheme.fg('primary', text);
    const rule = truncateToWidth(accent('─'.repeat(renderWidth)), renderWidth);
    switch (part) {
      case 'head': {
        this.headHits.reset();
        if (this.layout === undefined) return [rule];
        const header = this.renderHeaderLine(renderWidth);
        this.headHits.addRow(1, header.targets);
        return [rule, header.line];
      }
      case 'body':
        return this.renderBody(renderWidth);
      case 'foot':
        return [rule];
    }
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') {
      if (part === 'body') {
        if (this.layout !== undefined) return undefined;
        return { handled: true, render: this.scrollRegularBy(event.wheelDelta ?? 0) };
      }
      return { handled: true };
    }
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (part === 'head') {
      return this.headHits.handle(event, {
        focused: this.focused,
        onActivate: () => {
          this.opts.onClose();
        },
      });
    }
    if (part === 'body' && this.layout === undefined) {
      return this.bodyHits.handle(event, {
        focused: this.focused,
        onActivate: () => {
          this.opts.onClose();
        },
      });
    }
    return undefined;
  }

  private renderHeaderLine(width: number): {
    readonly line: string;
    readonly targets: readonly InlineTarget<'close'>[];
  } {
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    return renderInlineSegments<'close'>(
      [
        { text: currentTheme.boldFg('primary', ' help ') },
        { text: muted('· ') },
        { text: muted('Esc / Enter / q to cancel'), value: 'close' },
        { text: muted(' · ↑↓ scroll') },
      ],
      width,
    );
  }

  private buildBodyLines(): string[] {
    const dim = (text: string) => currentTheme.fg('textDim', text);
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
    return [
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
    ];
  }

  private renderBody(width: number): string[] {
    this.bodyHits.reset();
    const bodyLines = this.buildBodyLines();
    if (this.layout !== undefined) {
      this.maxRegularScrollTop = 0;
      return bodyLines.map((line) => truncateToWidth(line, width));
    }

    const muted = (text: string) => currentTheme.fg('textMuted', text);
    const header = this.renderHeaderLine(width);
    const content = [header.line, ...bodyLines];
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.maxRegularScrollTop = content.length - maxVisible;
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxRegularScrollTop));
      if (this.scrollTop === 0) this.bodyHits.addRow(0, header.targets);
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`,
      );
      return [...slice, scrollInfo].map((line) => truncateToWidth(line, width));
    }
    this.maxRegularScrollTop = 0;
    this.scrollTop = 0;
    this.bodyHits.addRow(0, header.targets);
    return content.map((line) => truncateToWidth(line, width));
  }

  private scrollRegularBy(delta: number): boolean {
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    if (step === 0 || this.maxRegularScrollTop <= 0) return false;
    const next = Math.max(0, Math.min(this.maxRegularScrollTop, this.scrollTop + step));
    if (next === this.scrollTop) return false;
    this.scrollTop = next;
    return true;
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
