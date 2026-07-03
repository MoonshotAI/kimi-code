import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { PluginInfo, PluginMcpServerInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { formatPluginSourceLabel, pluginTrustLabel } from '#/tui/utils/plugin-source-label';
import { printableChar } from '#/tui/utils/printable-key';
import { renderTabStrip } from '#/tui/utils/tab-strip';
import { computeUpdateStatus, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import { ChoicePickerComponent } from './choice-picker';

const MCP_SERVER_PREFIX = 'mcp:';

const REMOVE_CONFIRM_CANCEL = 'cancel';
const REMOVE_CONFIRM_REMOVE = 'remove';
const INSTALL_TRUST_EXIT = 'exit';
const INSTALL_TRUST_TRUST = 'trust';
const ELLIPSIS = '…';

interface PluginsOverviewItem {
  readonly value: string;
  readonly kind: 'plugin' | 'action';
  readonly label: string;
  readonly status?: string;
  readonly description: string;
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
    const colors = currentTheme.palette;
    const serverItems = this.items.filter((item) => item.kind === 'plugin');
    const actionItems = this.items.filter((item) => item.kind === 'action');
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(` MCP servers · ${info.displayName}`),
      mutedHintLine(' ↑↓ navigate · Enter/Space enable/disable · Esc cancel', colors),
      '',
      sectionLabel(`MCP servers (${info.enabledMcpServerCount}/${info.mcpServerCount} enabled)`, colors),
    ];

    if (serverItems.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('  No MCP servers declared.'));
    } else {
      for (let i = 0; i < serverItems.length; i++) {
        lines.push(...this.renderItem(serverItems[i]!, i, width));
      }
    }

    lines.push('');
    lines.push(sectionLabel('Actions', colors));
    for (let i = 0; i < actionItems.length; i++) {
      lines.push(...this.renderItem(actionItems[i]!, serverItems.length + i, width));
    }

    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderItem(item: PluginsOverviewItem, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += '  ' + statusStyle(item, colors)(item.status);
    }
    const serverName = mcpItemServerName(item);
    if (serverName !== undefined && this.opts.serverHint?.server === serverName) {
      line += '  ' + chalk.hex(colors.warning)(this.opts.serverHint.text);
    }
    const descriptionWidth = Math.max(1, width - 4);
    const lines = [line];
    for (const descLine of wrapOverviewDescription(item.description, descriptionWidth)) {
      lines.push(mutedHintLine(`    ${descLine}`, colors));
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

export type PluginInstallTrustConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PluginInstallTrustConfirmOptions {
  /** Plugin display name or source, shown in the title for identification. */
  readonly label: string;
  readonly onDone: (result: PluginInstallTrustConfirmResult) => void;
}

/**
 * Confirmation shown before installing a third-party (unofficial) plugin.
 * Defaults to "Exit" so the user must explicitly switch to "Trust and install"
 * to proceed with a plugin that Kimi has not reviewed.
 */
export class PluginInstallTrustConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginInstallTrustConfirmOptions) {
    super({
      title: `Install third-party plugin ${opts.label}?`,
      hint: '↑↓ navigate · Enter/Space select · ←/Esc cancel',
      formatHint: mutedHintLine,
      notice:
        '⚠️ This is a third-party plugin that Kimi has not reviewed. It can bundle MCP servers, ' +
        'skills, or files that run code and access your workspace. Install it only if you ' +
        'trust the source.',
      noticeTone: 'warning',
      options: [
        {
          value: INSTALL_TRUST_EXIT,
          label: 'Exit',
          description: 'Cancel the installation.',
        },
        {
          value: INSTALL_TRUST_TRUST,
          label: 'Trust and install',
          tone: 'danger',
          description: 'Install this third-party plugin anyway.',
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === INSTALL_TRUST_TRUST ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
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

function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== 'ok') return plugin.state;
  return plugin.enabled ? 'enabled' : 'disabled';
}

function marketplaceStatusStyle(status: string, colors: ColorPalette): (text: string) => string {
  // "update …" is a warning (actionable); "installed …" is success;
  // "install …" is the available action.
  if (status.startsWith('update')) return chalk.hex(colors.warning);
  if (status.startsWith('installed')) return chalk.hex(colors.success);
  return chalk.hex(colors.primary);
}

/** Rounded single-line URL input box (DESIGN §9), shared by the marketplace
 * Custom tab and the unified plugins panel. */
function renderUrlInputBox(
  input: Input,
  focused: boolean,
  width: number,
  colors: ColorPalette,
): string[] {
  input.focused = focused;
  const border = (s: string): string => chalk.hex(colors.primary)(s);
  const boxWidth = Math.max(24, width - 2);
  const innerWidth = Math.max(10, boxWidth - 4);
  const inputLine = input.render(innerWidth)[0] ?? '';
  const rightPad = Math.max(0, innerWidth - visibleWidth(inputLine));
  return [
    ' ' + border('╭' + '─'.repeat(boxWidth - 2) + '╮'),
    ' ' + border('│') + '  ' + inputLine + ' '.repeat(rightPad) + border('│'),
    ' ' + border('╰' + '─'.repeat(boxWidth - 2) + '╯'),
  ];
}

// ===========================================================================
// Unified /plugins panel: Installed / Official / Third-party / Custom tabs.
// ===========================================================================

export type PluginsPanelTabId = 'installed' | 'official' | 'third-party' | 'custom';

export type PluginsPanelSelection =
  | { readonly kind: 'toggle'; readonly id: string; readonly enabled: boolean }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'mcp'; readonly id: string }
  | { readonly kind: 'details'; readonly id: string }
  | { readonly kind: 'reload' }
  | { readonly kind: 'install'; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: 'install-source'; readonly source: string };

export interface PluginsPanelOptions {
  readonly installed: readonly PluginSummary[];
  readonly installedIds: ReadonlySet<string>;
  readonly initialTab?: PluginsPanelTabId;
  readonly selectedId?: string;
  readonly pluginHint?: { readonly id: string; readonly text: string };
  readonly onSelect: (selection: PluginsPanelSelection) => void;
  readonly onCancel: () => void;
  /** Called the first time the Official or Third-party tab needs its catalog.
   * The host fetches the marketplace and calls setMarketplace / setMarketplaceError. */
  readonly onRequestMarketplace?: () => void;
}

type MarketState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly entries: readonly PluginMarketplaceEntry[]; readonly source: string };

const PLUGINS_PANEL_TABS: readonly { id: PluginsPanelTabId; label: string }[] = [
  { id: 'installed', label: 'Installed' },
  { id: 'official', label: 'Official' },
  { id: 'third-party', label: 'Third-party' },
  { id: 'custom', label: 'Custom' },
];

export class PluginsPanelComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginsPanelOptions;
  private readonly customInput = new Input();
  private activeTabIndex: number;
  private selectedIndex = 0;
  private market: MarketState = { status: 'idle' };
  private installing: string | undefined;

  constructor(opts: PluginsPanelOptions) {
    super();
    this.opts = opts;
    this.activeTabIndex = Math.max(
      0,
      PLUGINS_PANEL_TABS.findIndex((tab) => tab.id === (opts.initialTab ?? 'installed')),
    );
    if (opts.selectedId !== undefined && this.activeTab.id === 'installed') {
      const idx = opts.installed.findIndex((p) => p.id === opts.selectedId);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.customInput.onSubmit = (value) => {
      const source = value.trim();
      if (source.length > 0) this.opts.onSelect({ kind: 'install-source', source });
    };
  }

  marketplaceStatus(): MarketState['status'] {
    return this.market.status;
  }

  setMarketplaceLoading(): void {
    this.market = { status: 'loading' };
  }

  setMarketplace(entries: readonly PluginMarketplaceEntry[], source: string): void {
    this.market = { status: 'loaded', entries, source };
  }

  setMarketplaceError(message: string): void {
    this.market = { status: 'error', message };
  }

  setInstalling(label: string): void {
    this.installing = label;
    this.invalidate();
  }

  clearInstalling(): void {
    this.installing = undefined;
    this.invalidate();
  }

  private get activeTab(): (typeof PLUGINS_PANEL_TABS)[number] {
    return PLUGINS_PANEL_TABS[this.activeTabIndex]!;
  }

  private get marketplaceEntries(): readonly PluginMarketplaceEntry[] {
    if (this.market.status !== 'loaded') return [];
    const { installedIds } = this.opts;
    return this.market.entries.toSorted(
      (a, b) => Number(installedIds.has(b.id)) - Number(installedIds.has(a.id)),
    );
  }

  private get installedVersions(): ReadonlyMap<string, string | undefined> {
    return new Map(this.opts.installed.map((plugin) => [plugin.id, plugin.version]));
  }

  private get officialEntries(): readonly PluginMarketplaceEntry[] {
    return this.marketplaceEntries.filter((entry) => entry.tier === 'official');
  }

  private get thirdPartyEntries(): readonly PluginMarketplaceEntry[] {
    // Anything not explicitly marked official lands here: `curated` entries plus
    // entries that omit `tier` (custom marketplaces often do). Without this,
    // untiered entries would be invisible in both marketplace tabs.
    return this.marketplaceEntries.filter((entry) => entry.tier !== 'official');
  }

  private requestMarketplaceIfNeeded(): void {
    // The Installed tab also needs the catalog to render update badges; only the
    // Custom tab (manual URL entry) can skip the fetch entirely.
    if (this.market.status === 'idle' && this.activeTab.id !== 'custom') {
      this.market = { status: 'loading' };
      this.opts.onRequestMarketplace?.();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex = (this.activeTabIndex + 1) % PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.activeTabIndex =
        (this.activeTabIndex - 1 + PLUGINS_PANEL_TABS.length) % PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      return;
    }
    switch (this.activeTab.id) {
      case 'installed':
        this.handleInstalledInput(data);
        return;
      case 'official':
      case 'third-party':
        this.handleMarketplaceInput(data);
        return;
      case 'custom':
        this.customInput.handleInput(data);
        return;
    }
  }

  private handleInstalledInput(data: string): void {
    const plugins = this.opts.installed;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      return;
    }
    const plugin = plugins[this.selectedIndex];
    const ch = printableChar(data);
    // Decode Space for terminals that send printable keys via Kitty/CSI-u
    // sequences (e.g. VS Code's integrated terminal); `matchesKey(Key.space)`
    // alone misses those and the toggle silently stops working.
    if (matchesKey(data, Key.space) || ch === ' ') {
      if (plugin !== undefined) {
        this.opts.onSelect({ kind: 'toggle', id: plugin.id, enabled: !plugin.enabled });
      }
      return;
    }
    if (ch === 'd' || ch === 'D') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'remove', id: plugin.id });
      return;
    }
    if (ch === 'm' || ch === 'M') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'mcp', id: plugin.id });
      return;
    }
    if (ch === 'r' || ch === 'R') {
      this.opts.onSelect({ kind: 'reload' });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (plugin === undefined) return;
      const update = this.installedUpdateStatus(plugin);
      if (update !== undefined) {
        this.opts.onSelect({ kind: 'install', entry: update.entry });
      } else {
        this.opts.onSelect({ kind: 'details', id: plugin.id });
      }
      return;
    }
    if (ch === 'i' || ch === 'I') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'details', id: plugin.id });
    }
  }

  private handleMarketplaceInput(data: string): void {
    const entries = this.activeTab.id === 'official' ? this.officialEntries : this.thirdPartyEntries;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      // Clamp to 0 while the catalog is still loading (entries empty); otherwise
      // `entries.length - 1` is -1 and a later Enter reads `entries[-1]`.
      this.selectedIndex = entries.length === 0 ? 0 : Math.min(entries.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = entries[this.selectedIndex];
      if (entry === undefined) return;
      this.opts.onSelect({ kind: 'install', entry });
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.customInput.invalidate();
  }

  override render(width: number): string[] {
    if (this.installing !== undefined) {
      return this.renderInstalling(width);
    }
    const colors = currentTheme.palette;
    const tab = this.activeTab.id;
    const hint =
      tab === 'installed'
        ? this.installedHint()
        : tab === 'custom'
          ? ' Tab switch · Enter install · Esc cancel'
          : ' Tab switch · ↑↓ navigate · Enter open/install · Esc cancel';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Plugins'),
      mutedHintLine(hint, colors),
      '',
      renderTabStrip({
        labels: PLUGINS_PANEL_TABS.map((t) => t.label),
        activeIndex: this.activeTabIndex,
        width,
        colors,
      }),
      '',
    ];

    if (tab === 'installed') this.renderInstalled(lines, width);
    else if (tab === 'official') this.renderOfficial(lines, width);
    else if (tab === 'third-party') this.renderThirdParty(lines, width);
    else this.renderCustom(lines, width);

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderInstalled(lines: string[], width: number): void {
    const { installed } = this.opts;
    const colors = currentTheme.palette;
    if (installed.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('  No plugins installed.'));
    } else {
      for (let i = 0; i < installed.length; i++) {
        lines.push(...this.renderInstalledRow(installed[i]!, i, width));
      }
    }
    lines.push('');
    lines.push(mutedHintLine(` ${installed.length} installed`, colors));
  }

  private installedHint(): string {
    const plugin = this.opts.installed[this.selectedIndex];
    const hasUpdate = plugin !== undefined && this.installedUpdateStatus(plugin) !== undefined;
    const enter = hasUpdate ? 'Enter update' : 'Enter details';
    return ` Tab switch · Space toggle · D remove · M MCP · ${enter} · I details · R reload · Esc cancel`;
  }

  private installedUpdateStatus(
    plugin: PluginSummary,
  ): { entry: PluginMarketplaceEntry; local: string; latest: string } | undefined {
    if (this.market.status !== 'loaded') return undefined;
    const entry = this.market.entries.find((e) => e.id === plugin.id);
    if (entry === undefined) return undefined;
    const status = computeUpdateStatus(entry.version, plugin.version, true);
    return status.kind === 'update' ? { entry, local: status.local, latest: status.latest } : undefined;
  }

  private renderInstalledRow(plugin: PluginSummary, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const status = pluginStatus(plugin);
    const update = this.installedUpdateStatus(plugin);
    let line = prefix + labelStyle(plugin.displayName);
    if (status !== undefined) {
      line += '  ' + statusStyle({ kind: 'plugin', value: '', label: '', description: '', status }, colors)(status);
    }
    if (update !== undefined) {
      const badge = `update ${update.local} → ${update.latest}`;
      line += '  ' + marketplaceStatusStyle(badge, colors)(badge);
    }
    if (this.opts.pluginHint?.id === plugin.id) {
      line += '  ' + chalk.hex(colors.warning)(this.opts.pluginHint.text);
    }
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    for (const descLine of wrapOverviewDescription(overviewPluginDescription(plugin), descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderMarketplaceTab(
    lines: string[],
    width: number,
    entries: readonly PluginMarketplaceEntry[],
  ): void {
    const colors = currentTheme.palette;
    if (this.market.status === 'loading' || this.market.status === 'idle') {
      lines.push(chalk.hex(colors.textMuted)('  Loading marketplace…'));
      return;
    }
    if (this.market.status === 'error') {
      lines.push(chalk.hex(colors.warning)(`  Marketplace unavailable: ${this.market.message}`));
      lines.push(mutedHintLine('  Use the Custom tab to install from a URL.', colors));
      return;
    }
    if (entries.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('  No plugins found.'));
    } else {
      for (let i = 0; i < entries.length; i++) {
        lines.push(...this.renderMarketplaceRow(entries[i]!, i, width));
      }
    }
    const installedCount = entries.filter((e) => this.opts.installedIds.has(e.id)).length;
    lines.push('');
    lines.push(
      mutedHintLine(` ${installedCount} installed · ${entries.length - installedCount} available`, colors),
    );
    lines.push(mutedHintLine(` Source: ${this.market.source}`, colors));
  }

  private renderOfficial(lines: string[], width: number): void {
    this.renderMarketplaceTab(lines, width, this.officialEntries);
  }

  private renderThirdParty(lines: string[], width: number): void {
    this.renderMarketplaceTab(lines, width, this.thirdPartyEntries);
  }

  private renderMarketplaceRow(entry: PluginMarketplaceEntry, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const status = marketplaceEntryStatus(entry, this.installedVersions);
    const line =
      prefix + labelStyle(entry.displayName) + '  ' + marketplaceStatusStyle(status, colors)(status);
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    for (const descLine of wrapOverviewDescription(marketplaceEntryDescription(entry), descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderCustom(lines: string[], width: number): void {
    const colors = currentTheme.palette;
    lines.push(mutedHintLine(' Install from a GitHub URL (or zip URL / local path):', colors));
    lines.push('');
    lines.push(...renderUrlInputBox(this.customInput, this.focused, width, colors));
  }

  private renderInstalling(width: number): string[] {
    const colors = currentTheme.palette;
    const lines = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Plugins'),
      '',
      chalk.hex(colors.textMuted)(`  Installing ${this.installing} from marketplace…`),
      '',
      chalk.hex(colors.primary)('─'.repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
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
  const version = entry.version !== undefined ? ` · v${entry.version}` : '';
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(', ')}`
      : '';
  const tierSuffix = entry.description !== undefined ? ` · ${tier}` : '';
  return `${description} · id ${entry.id}${version}${tierSuffix}${keywords}`;
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry['tier']): string {
  if (tier === 'official') return 'Official plugin';
  if (tier === 'curated') return 'Curated plugin';
  return 'Plugin';
}

function installStatus(entry: PluginMarketplaceEntry): string {
  return entry.version === undefined ? 'install' : `install v${entry.version}`;
}

function marketplaceEntryStatus(
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
      return installStatus(entry);
  }
}

function sectionLabel(label: string, colors: ColorPalette): string {
  return chalk.hex(colors.textDim).bold(` ${label}`);
}

function statusStyle(
  item: PluginsOverviewItem,
  colors: ColorPalette,
): (text: string) => string {
  if (item.kind === 'action') return chalk.hex(colors.textDim);
  if (item.status === 'enabled' || item.status === 'installed') return chalk.hex(colors.success);
  if (item.status?.startsWith('install')) return chalk.hex(colors.primary);
  if (item.status === 'disabled') return chalk.hex(colors.textDim);
  if (item.status !== undefined && /^\d/.test(item.status)) return chalk.hex(colors.textDim);
  return chalk.hex(colors.warning);
}

function mutedHintLine(text: string, colors?: ColorPalette): string {
  if (colors !== undefined) {
    return chalk.hex(colors.textMuted)(text);
  }
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
