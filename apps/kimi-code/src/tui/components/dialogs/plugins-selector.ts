import type { PluginSummary } from '@moonshot-ai/harness-core/features/plugin/index';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { pageView, type PageView } from '#/tui/utils/paging';

export interface PluginsSelectorOptions {
  readonly plugins: readonly PluginSummary[];
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onRemove: (id: string) => void;
  readonly onReload: () => void;
  readonly onClose: () => void;
}

const PAGE_SIZE = 8;
const HEADER_HINT = '↑↓ navigate · Space toggle · D remove · R reload · Esc cancel';

export class PluginsSelectorComponent extends Container implements Focusable {
  focused = false;
  private opts: PluginsSelectorOptions;
  private selectedIndex = 0;
  private confirmRemoveId: string | undefined;

  constructor(opts: PluginsSelectorOptions) {
    super();
    this.opts = opts;
  }

  setOptions(next: PluginsSelectorOptions): void {
    const previousId = this.opts.plugins[this.selectedIndex]?.id;
    this.opts = next;
    this.confirmRemoveId = undefined;
    const nextIndex = next.plugins.findIndex((plugin) => plugin.id === previousId);
    this.selectedIndex =
      nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, Math.max(0, next.plugins.length - 1));
    this.invalidate();
  }

  private page(): PageView {
    return pageView(this.opts.plugins.length, this.selectedIndex, PAGE_SIZE);
  }

  handleInput(data: string): void {
    if (this.confirmRemoveId !== undefined) {
      this.handleConfirmInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onClose();
      return;
    }

    const plugins = this.opts.plugins;

    if (matchesKey(data, Key.up)) {
      if (plugins.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (plugins.length === 0) return;
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) {
      if (plugins.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - PAGE_SIZE);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) {
      if (plugins.length === 0) return;
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + PAGE_SIZE);
      this.invalidate();
      return;
    }

    const ch = printableChar(data);
    if (ch === ' ') {
      const selected = plugins[this.selectedIndex];
      if (selected !== undefined) {
        this.opts.onToggle(selected.id, !selected.enabled);
      }
      return;
    }
    if (ch === 'd' || ch === 'D') {
      const selected = plugins[this.selectedIndex];
      if (selected !== undefined) {
        this.confirmRemoveId = selected.id;
        this.invalidate();
      }
      return;
    }
    if (ch === 'r' || ch === 'R') {
      this.opts.onReload();
    }
  }

  private handleConfirmInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.confirmRemoveId = undefined;
      this.invalidate();
      return;
    }
    if (k === 'y' || k === 'Y') {
      const id = this.confirmRemoveId;
      this.confirmRemoveId = undefined;
      this.invalidate();
      if (id !== undefined) this.opts.onRemove(id);
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [];
    const border = currentTheme.fg('primary', '─'.repeat(width));
    lines.push(border);
    lines.push(currentTheme.boldFg('primary', ' Plugins'));
    lines.push(currentTheme.fg('textMuted', ' ' + HEADER_HINT));
    lines.push('');

    const plugins = this.opts.plugins;
    if (plugins.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No plugins installed.'));
    } else {
      const view = this.page();
      for (let i = view.start; i < view.end; i++) {
        const plugin = plugins[i];
        if (plugin === undefined) continue;
        for (const line of renderPluginRow(plugin, i === this.selectedIndex, width)) {
          lines.push(line);
        }
      }
    }

    lines.push('');

    if (this.confirmRemoveId !== undefined) {
      lines.push(
        truncateToWidth(
          currentTheme.boldFg('warning', `  Remove plugin "${this.confirmRemoveId}"? [y/N]`),
          width,
          '…',
        ),
      );
    } else {
      const view = this.page();
      if (view.pageCount > 1) {
        lines.push(
          currentTheme.fg('textMuted', ` Page ${String(view.page + 1)}/${String(view.pageCount)}`),
        );
      }
    }

    lines.push(border);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function renderPluginRow(
  plugin: PluginSummary,
  isSelected: boolean,
  width: number,
): string[] {
  const pointer = isSelected ? SELECT_POINTER : ' ';
  const pointerStyled = isSelected
    ? currentTheme.fg('primary', `${pointer} `)
    : currentTheme.fg('textDim', `${pointer} `);
  const nameStyled = isSelected
    ? currentTheme.boldFg('primary', plugin.displayName)
    : currentTheme.fg('text', plugin.displayName);
  const stateStyled = plugin.enabled
    ? currentTheme.fg('success', '  enabled')
    : currentTheme.fg('textDim', '  disabled');

  const lines = [`  ${pointerStyled}${nameStyled}${stateStyled}`];

  const meta: string[] = [`id ${plugin.id}`];
  if (plugin.skillCount > 0) meta.push(`${String(plugin.skillCount)} skills`);
  if (plugin.mcpServerCount > 0) {
    meta.push(`MCP ${String(plugin.enabledMcpServerCount)}/${String(plugin.mcpServerCount)}`);
  }
  if (plugin.commandCount > 0) meta.push(`${String(plugin.commandCount)} commands`);
  if (plugin.hookCount > 0) meta.push(`${String(plugin.hookCount)} hooks`);
  if (plugin.hasErrors) meta.push('errors');
  const metaText = truncateToWidth(meta.join(' · '), Math.max(0, width - 6), '…');
  lines.push(currentTheme.fg('textMuted', `      ${metaText}`));

  return lines;
}
