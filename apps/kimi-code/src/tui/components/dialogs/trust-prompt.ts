import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type TrustPromptChoice = 'trust' | 'distrust';

export interface TrustPromptOptions {
  readonly workDir: string;
  /** Project-level MCP servers that trusting would enable; may be empty. */
  readonly gatedMcpServers: readonly string[];
  /** Esc resolves to 'distrust' as well. */
  readonly onSelect: (choice: TrustPromptChoice) => void;
}

interface TrustPromptOption {
  readonly value: TrustPromptChoice;
  readonly label: string;
  readonly description: string;
}

const OPTIONS: readonly TrustPromptOption[] = [
  {
    value: 'trust',
    label: 'Trust this folder',
    description: 'Enable project MCP servers. Remembered for this folder.',
  },
  {
    value: 'distrust',
    label: "Don't trust",
    description: 'Exit Kimi Code. Asked again next launch.',
  },
];

export class TrustPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: TrustPromptOptions) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onSelect('distrust');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(OPTIONS.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(OPTIONS[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const lines = [
      rule,
      currentTheme.boldFg('primary', ' Trust this folder?'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc exit'),
      '',
      ...wrapTextWithAnsi(this.opts.workDir, Math.max(20, width - 2)).map(
        (line) => ` ${currentTheme.fg('textStrong', line)}`,
      ),
      '',
    ];

    const notice =
      this.opts.gatedMcpServers.length > 0
        ? `Kimi Code loads project-level MCP servers (.mcp.json, .kimi-code/mcp.json) only in trusted folders. They run as local processes on your machine. This folder defines: ${this.opts.gatedMcpServers.join(', ')}.`
        : 'Kimi Code loads project-level MCP servers (.mcp.json, .kimi-code/mcp.json) only in trusted folders. They run as local processes on your machine.';
    for (const line of wrapTextWithAnsi(notice, Math.max(20, width - 2))) {
      lines.push(` ${currentTheme.fg('textMuted', line)}`);
    }
    lines.push('');

    for (let i = 0; i < OPTIONS.length; i += 1) {
      const option = OPTIONS[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const label = selected
        ? currentTheme.boldFg('primary', option.label)
        : currentTheme.fg('text', option.label);
      lines.push(currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) + label);
      for (const line of wrapTextWithAnsi(option.description, Math.max(20, width - 4))) {
        lines.push(`    ${currentTheme.fg('textMuted', line)}`);
      }
      lines.push('');
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }
}
