import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type { PluginInfo, PluginMcpServerInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { formatPluginSourceLabel, pluginTrustLabel } from '#/tui/utils/plugin-source-label';
import { printableChar } from '#/tui/utils/printable-key';
import { computeUpdateStatus, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import { ChoicePickerComponent } from './choice-picker';

const OVERVIEW_MARKETPLACE = 'marketplace';
const OVERVIEW_RELOAD = 'reload';
const OVERVIEW_SHOW_LIST = 'show-list';
const OVERVIEW_PLUGIN_PREFIX = 'plugin:';
const MCP_SERVER_PREFIX = 'mcp:';

const REMOVE_CONFIRM_CANCEL = 'cancel';
const REMOVE_CONFIRM_REMOVE = 'remove';
const ELLIPSIS = '…';

interface PluginsOverviewItem {
  readonly value: string;
  readonly kind: 'plugin' | 'action';
  readonly label: string;
  readonly status?: string;
  readonly description: string;
}

export type PluginsOverviewSelection =
  | { readonly kind: 'marketplace' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'show-list' }
  | { readonly kind: 'toggle'; readonly id: string; readonly enabled: boolean }
  | { readonly kind: 'mcp'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'info'; readonly id: string };

export interface PluginsOverviewSelectorOptions {
  readonly plugins: readonly PluginSummary[];
  readonly selectedId?: string;
  readonly pluginHint?: {
    readonly id: string;
    readonly text: string;
  };
  readonly onSelect: (selection: PluginsOverviewSelection) => void;
  readonly onCancel: () => void;
}

export class PluginsOverviewSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginsOverviewSelectorOptions;
  private readonly items: readonly PluginsOverviewItem[];
  private selectedIndex = 0;

  constructor(opts: PluginsOverviewSelectorOptions) {
    super();
    this.opts = opts;
    this.items = buildOverviewItems(opts.plugins);
    const selectedIndex = this.items.findIndex(
      (item) => item.value === `${OVERVIEW_PLUGIN_PREFIX}${opts.selectedId}`,
    );
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      return;
    }
    const chosen = this.items[this.selectedIndex];
    if (chosen === undefined) return;
    const pluginId = overviewItemPluginId(chosen);
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      if (pluginId === undefined) return;
      const plugin = this.opts.plugins.find((item) => item.id === pluginId);
      if (plugin !== undefined) {
        this.opts.onSelect({ kind: 'toggle', id: pluginId, enabled: !plugin.enabled });
      }
      return;
    }
    if (decoded === 'd' || decoded === 'D') {
      if (pluginId !== undefined) this.opts.onSelect({ kind: 'remove', id: pluginId });
      return;
    }
    if (decoded === 'm' || decoded === 'M') {
      if (pluginId === undefined) return;
      const plugin = this.opts.plugins.find((item) => item.id === pluginId);
      if (plugin !== undefined && plugin.mcpServerCount > 0) {
        this.opts.onSelect({ kind: 'mcp', id: pluginId });
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (pluginId !== undefined) {
        this.opts.onSelect({ kind: 'info', id: pluginId });
        return;
      }
      const selection = parseOverviewSelection(chosen.value);
      if (selection !== undefined) this.opts.onSelect(selection);
    }
  }

  override render(width: number): string[] {
    const { plugins } = this.opts;
    const hint =
      '↑↓ navigate · Space toggle · M MCP servers · D remove · Enter details · Esc cancel';
    const pluginItems = this.items.filter((item) => item.kind === 'plugin');
    const actionItems = this.items.filter((item) => item.kind === 'action');
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Plugins'),
      mutedHintLine(` ${hint}`),
      '',
      sectionLabel(`Installed plugins (${plugins.length})`),
    ];

    if (pluginItems.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No plugins installed.'));
    } else {
      let absoluteIndex = 0;
      for (const item of pluginItems) {
        lines.push(...this.renderItem(item, absoluteIndex, width));
        absoluteIndex++;
      }
    }

    lines.push('');
    lines.push(sectionLabel('Actions'));
    for (let i = 0; i < actionItems.length; i++) {
      lines.push(...this.renderItem(actionItems[i]!, pluginItems.length + i, width));
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderItem(item: PluginsOverviewItem, index: number, width: number): string[] {
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected
      ? (text: string) => currentTheme.boldFg('primary', text)
      : (text: string) => currentTheme.fg('text', text);
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += '  ' + statusStyle(item)(item.status);
    }
    const pluginId = overviewItemPluginId(item);
    if (pluginId !== undefined && this.opts.pluginHint?.id === pluginId) {
      line += '  ' + currentTheme.fg('warning', this.opts.pluginHint.text);
    }

    const descriptionWidth = Math.max(1, width - 4);
    const lines = [line];
    for (const descLine of wrapOverviewDescription(item.description, descriptionWidth)) {
      lines.push(mutedHintLine(`    ${descLine}`));
    }
    return lines;
  }
}

export type PluginMarketplaceSelection =
  | { readonly kind: 'install'; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: 'back' };

export interface PluginMarketplaceSelectorOptions {
  readonly entries: readonly PluginMarketplaceEntry[];
  readonly installed: ReadonlyMap<string, string | undefined>;
  readonly source: string;
  readonly onSelect: (selection: PluginMarketplaceSelection) => void;
  readonly onCancel: () => void;
}

export class PluginMarketplaceSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginMarketplaceSelectorOptions;
  private readonly items: readonly PluginsOverviewItem[];
  private selectedIndex = 0;

  constructor(opts: PluginMarketplaceSelectorOptions) {
    super();
    this.opts = opts;
    this.items = buildMarketplaceItems(opts.entries, opts.installed);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.items[this.selectedIndex];
      if (chosen === undefined) return;
      if (chosen.value === 'back') {
        this.opts.onSelect({ kind: 'back' });
        return;
      }
      const entry = this.opts.entries.find((item) => item.id === chosen.value);
      if (entry === undefined) return;
      this.opts.onSelect({ kind: 'install', entry });
    }
  }

  override render(width: number): string[] {
    const entries = this.items.filter((item) => item.kind === 'plugin');
    const actions = this.items.filter((item) => item.kind === 'action');
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Official plugins'),
      mutedHintLine(' ↑↓ navigate · Enter install/update · Esc cancel'),
      currentTheme.fg('textMuted', ` Source: ${this.opts.source}`),
      '',
      sectionLabel(`Marketplace (${entries.length})`),
    ];

    if (entries.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No marketplace plugins found.'));
    } else {
      for (let i = 0; i < entries.length; i++) {
        lines.push(...this.renderItem(entries[i]!, i, width));
      }
    }

    lines.push('');
    lines.push(sectionLabel('Actions'));
    for (let i = 0; i < actions.length; i++) {
      lines.push(...this.renderItem(actions[i]!, entries.length + i, width));
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderItem(item: PluginsOverviewItem, index: number, width: number): string[] {
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected
      ? (text: string) => currentTheme.boldFg('primary', text)
      : (text: string) => currentTheme.fg('text', text);
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += '  ' + statusStyle(item)(item.status);
    }
    const descriptionWidth = Math.max(1, width - 4);
    const lines = [line];
    for (const descLine of wrapOverviewDescription(item.description, descriptionWidth)) {
      lines.push(mutedHintLine(`    ${descLine}`));
    }
    return lines;
  }
}

export type PluginMcpSelection =
  | { readonly kind: 'toggle'; readonly pluginId: string; readonly server: string; readonly enabled: boolean }
  | { readonly kind: 'back'; readonly pluginId: string };

export interface PluginMcpSelectorOptions {
  readonly info: PluginInfo;
  readonly selectedServer?: string;
  readonly serverHint?: {
    readonly server: string;
    readonly text: string;
  };
  readonly onSelect: (selection: PluginMcpSelection) => void;
  readonly onCancel: () => void;
}

export class PluginMcpSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginMcpSelectorOptions;
  private readonly items: readonly PluginsOverviewItem[];
  private selectedIndex = 0;

  constructor(opts: PluginMcpSelectorOptions) {
    super();
    this.opts = opts;
    this.items = buildMcpItems(opts.info);
    const selectedIndex = this.items.findIndex(
      (item) => item.value === `${MCP_SERVER_PREFIX}${opts.selectedServer}`,
    );
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || printableChar(data) === ' ') {
      const chosen = this.items[this.selectedIndex];
      if (chosen === undefined) return;
      if (chosen.value === 'back') {
        this.opts.onSelect({ kind: 'back', pluginId: this.opts.info.id });
        return;
      }
      const serverName = mcpItemServerName(chosen);
      if (serverName === undefined) return;
      const server = this.opts.info.mcpServers.find((item) => item.name === serverName);
      if (server === undefined) return;
      this.opts.onSelect({
        kind: 'toggle',
        pluginId: this.opts.info.id,
        server: server.name,
        enabled: !server.enabled,
      });
    }
  }

  override render(width: number): string[] {
    const { info } = this.opts;
    const serverItems = this.items.filter((item) => item.kind === 'plugin');
    const actionItems = this.items.filter((item) => item.kind === 'action');
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` MCP servers · ${info.displayName}`),
      mutedHintLine(' ↑↓ navigate · Enter/Space enable/disable · Esc cancel'),
      '',
      sectionLabel(`MCP servers (${info.enabledMcpServerCount}/${info.mcpServerCount} enabled)`),
    ];

    if (serverItems.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No MCP servers declared.'));
    } else {
      for (let i = 0; i < serverItems.length; i++) {
        lines.push(...this.renderItem(serverItems[i]!, i, width));
      }
    }

    lines.push('');
    lines.push(sectionLabel('Actions'));
    for (let i = 0; i < actionItems.length; i++) {
      lines.push(...this.renderItem(actionItems[i]!, serverItems.length + i, width));
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderItem(item: PluginsOverviewItem, index: number, width: number): string[] {
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected
      ? (text: string) => currentTheme.boldFg('primary', text)
      : (text: string) => currentTheme.fg('text', text);
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += '  ' + statusStyle(item)(item.status);
    }
    const serverName = mcpItemServerName(item);
    if (serverName !== undefined && this.opts.serverHint?.server === serverName) {
      line += '  ' + currentTheme.fg('warning', this.opts.serverHint.text);
    }
    const descriptionWidth = Math.max(1, width - 4);
    const lines = [line];
    for (const descLine of wrapOverviewDescription(item.description, descriptionWidth)) {
      lines.push(mutedHintLine(`    ${descLine}`));
    }
    return lines;
  }
}

export type PluginRemoveConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PluginRemoveConfirmOptions {
  readonly id: string;
  readonly displayName: string;
  readonly onDone: (result: PluginRemoveConfirmResult) => void;
}

export class PluginRemoveConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginRemoveConfirmOptions) {
    super({
      title: `Remove ${opts.displayName} (${opts.id})?`,
      hint: '↑↓ navigate · Enter/Space select · ←/Esc cancel',
      formatHint: mutedHintLine,
      options: [
        {
          value: REMOVE_CONFIRM_CANCEL,
          label: 'Cancel',
          description: 'Keep this plugin installed.',
        },
        {
          value: REMOVE_CONFIRM_REMOVE,
          label: 'Remove plugin',
          tone: 'danger',
          description: 'Remove only the install record; plugin files are left in place.',
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === REMOVE_CONFIRM_REMOVE ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

function buildOverviewItems(plugins: readonly PluginSummary[]): PluginsOverviewItem[] {
  const options: PluginsOverviewItem[] = plugins.map((plugin) => ({
    value: `${OVERVIEW_PLUGIN_PREFIX}${plugin.id}`,
    kind: 'plugin',
    label: plugin.displayName,
    status: pluginStatus(plugin),
    description: overviewPluginDescription(plugin),
  }));
  options.push(
    {
      value: OVERVIEW_MARKETPLACE,
      kind: 'action',
      label: 'Marketplace',
      description: 'Browse official plugins.',
    },
    {
      value: OVERVIEW_RELOAD,
      kind: 'action',
      label: 'Reload',
      description: 'Re-read installed plugins and manifests.',
    },
    {
      value: OVERVIEW_SHOW_LIST,
      kind: 'action',
      label: 'Summary',
      description: 'Append the current plugin summary to the transcript.',
    },
  );
  return options;
}

function overviewPluginDescription(plugin: PluginSummary): string {
  const state = plugin.state === 'ok' ? '' : ` · state ${plugin.state}`;
  const skills = `${plugin.skillCount} skill${plugin.skillCount === 1 ? '' : 's'}`;
  const mcp =
    plugin.mcpServerCount > 0
      ? ` · MCP ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount}`
      : '';
  const diagnostics = plugin.hasErrors ? ' · diagnostics available' : '';
  const source = ` · ${formatPluginSourceLabel(plugin)}`;
  const trust = ` · ${pluginTrustLabel(plugin)}`;
  return `id ${plugin.id} · ${skills}${mcp}${source}${trust}${state}${diagnostics}`;
}

function pluginStatus(plugin: PluginSummary): string {
  if (plugin.state !== 'ok') return plugin.state;
  return plugin.enabled ? 'enabled' : 'disabled';
}

function parseOverviewSelection(value: string): PluginsOverviewSelection | undefined {
  if (value === OVERVIEW_MARKETPLACE) return { kind: 'marketplace' };
  if (value === OVERVIEW_RELOAD) return { kind: 'reload' };
  if (value === OVERVIEW_SHOW_LIST) return { kind: 'show-list' };
  return undefined;
}

function overviewItemPluginId(item: PluginsOverviewItem): string | undefined {
  if (!item.value.startsWith(OVERVIEW_PLUGIN_PREFIX)) return undefined;
  return item.value.slice(OVERVIEW_PLUGIN_PREFIX.length);
}

function buildMarketplaceItems(
  entries: readonly PluginMarketplaceEntry[],
  installed: ReadonlyMap<string, string | undefined>,
): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = entries.map((entry) => ({
    value: entry.id,
    kind: 'plugin',
    label: entry.displayName,
    status: marketplaceItemStatus(entry, installed),
    description: marketplaceEntryDescription(entry),
  }));
  items.push({
    value: 'back',
    kind: 'action',
    label: 'Back to installed plugins',
    description: 'Return to the local plugin manager.',
  });
  return items;
}

function buildMcpItems(info: PluginInfo): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = info.mcpServers.map((server) => ({
    value: `${MCP_SERVER_PREFIX}${server.name}`,
    kind: 'plugin',
    label: server.name,
    status: server.enabled ? 'enabled' : 'disabled',
    description: mcpServerDescription(server),
  }));
  items.push({
    value: 'back',
    kind: 'action',
    label: 'Back to installed plugins',
    description: 'Return to the local plugin manager.',
  });
  return items;
}

function mcpServerDescription(server: PluginMcpServerInfo): string {
  const action = server.enabled ? 'Enter/Space disable' : 'Enter/Space enable';
  if (server.transport === 'http' || server.transport === 'sse') {
    return `${action} · ${server.transport.toUpperCase()} · ${server.url ?? server.runtimeName}`;
  }
  const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
  const command = `${server.command ?? ''}${args}`.trim();
  const cwd = server.cwd === undefined ? '' : ` · cwd ${server.cwd}`;
  return `${action} · stdio · ${command || server.runtimeName}${cwd}`;
}

function mcpItemServerName(item: PluginsOverviewItem): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined;
  return item.value.slice(MCP_SERVER_PREFIX.length);
}

function marketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  const tier = marketplaceTierLabel(entry.tier);
  const description = entry.description ?? tier;
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(', ')}`
      : '';
  const tierSuffix = entry.description !== undefined ? ` · ${tier}` : '';
  // The version now lives in the status badge, so it is omitted here to avoid duplication.
  return `${description} · id ${entry.id}${tierSuffix}${keywords}`;
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry['tier']): string {
  if (tier === 'official') return 'Official plugin';
  if (tier === 'curated') return 'Curated plugin';
  return 'Plugin';
}

function marketplaceItemStatus(
  entry: PluginMarketplaceEntry,
  installed: ReadonlyMap<string, string | undefined>,
): string {
  const status = computeUpdateStatus(entry.version, installed.get(entry.id), installed.has(entry.id));
  switch (status.kind) {
    case 'update':
      return `update ${status.local} → ${status.latest}`;
    case 'up-to-date':
      return status.version === undefined ? 'installed' : `installed · v${status.version}`;
    case 'not-installed':
      return entry.version === undefined ? 'install' : `install v${entry.version}`;
  }
}

function sectionLabel(label: string): string {
  return currentTheme.boldFg('textDim', ` ${label}`);
}

function statusStyle(
  item: PluginsOverviewItem,
): (text: string) => string {
  if (item.kind === 'action') return (text) => currentTheme.fg('textDim', text);
  if (item.status?.startsWith('update')) return (text) => currentTheme.fg('warning', text);
  if (item.status === 'enabled' || item.status?.startsWith('installed')) return (text) => currentTheme.fg('success', text);
  if (item.status?.startsWith('install')) return (text) => currentTheme.fg('primary', text);
  if (item.status === 'disabled') return (text) => currentTheme.fg('textDim', text);
  if (item.status !== undefined && /^\d/.test(item.status)) return (text) => currentTheme.fg('textDim', text);
  return (text) => currentTheme.fg('warning', text);
}

function mutedHintLine(text: string): string {
  return currentTheme.fg('textMuted', text);
}

function wrapOverviewDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
