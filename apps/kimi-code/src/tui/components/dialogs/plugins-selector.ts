import { t } from '#/i18n';
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
import { computeUpdateStatus, type PluginMarketplaceEntry, type PluginUpdateStatus } from '#/utils/plugin-marketplace';

import { ChoicePickerComponent } from './choice-picker';

const MCP_SERVER_PREFIX = 'mcp:';

const REMOVE_CONFIRM_CANCEL = 'cancel';
const REMOVE_CONFIRM_REMOVE = 'remove';
const INSTALL_TRUST_EXIT = 'exit';
const INSTALL_TRUST_TRUST = 'trust';
const ELLIPSIS = '…';

// Hardcoded Web Bridge promotion: a built-in entry that always leads the
// Official tab, even when the marketplace catalog is unavailable. Selecting it
// opens the install page in the browser rather than installing from a source,
// because Web Bridge is a browser extension + daemon, not a plugin package.
const WEB_BRIDGE_URL = 'https://www.kimi.com/features/webbridge';
const WEB_BRIDGE_ENTRY: PluginMarketplaceEntry = {
  id: 'kimi-webbridge',
  displayName: 'Kimi WebBridge',
  source: WEB_BRIDGE_URL,
  tier: 'official',
  homepage: WEB_BRIDGE_URL,
  description: t('tui.dialogs.pluginsSelector.webBridgeDescription'),
};

// Only the hardcoded pinned row should open the WebBridge install page. Match
// by reference (not id) so a catalog entry on another tab that happens to
// reuse the same id still installs normally instead of being hijacked.
function isPinnedWebBridgeEntry(entry: PluginMarketplaceEntry): boolean {
  return entry === WEB_BRIDGE_ENTRY;
}

interface PluginsOverviewItem {
  readonly value: string;
  readonly kind: 'plugin' | 'action';
  readonly label: string;
  /** Internal status token used for styling logic (kept in English). */
  readonly status?: string;
  /** Translated status label shown to the user. */
  readonly statusLabel?: string;
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
      chalk.hex(colors.primary).bold(
        ` ${t('tui.dialogs.pluginsSelector.mcpServersTitle', { name: info.displayName })}`,
      ),
      mutedHintLine(t('tui.dialogs.pluginsSelector.mcpNavHint'), colors),
      '',
      sectionLabel(
        t('tui.dialogs.pluginsSelector.mcpServersSection', {
          enabled: info.enabledMcpServerCount,
          total: info.mcpServerCount,
        }),
        colors,
      ),
    ];

    if (serverItems.length === 0) {
      lines.push(chalk.hex(colors.textMuted)(`  ${t('tui.dialogs.pluginsSelector.noMcpServers')}`));
    } else {
      for (let i = 0; i < serverItems.length; i++) {
        lines.push(...this.renderItem(serverItems[i]!, i, width));
      }
    }

    lines.push('');
    lines.push(sectionLabel(t('tui.dialogs.pluginsSelector.actionsSection'), colors));
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
    if (item.status !== undefined && item.statusLabel !== undefined) {
      line += '  ' + statusStyle(item, colors)(item.statusLabel);
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
      title: t('tui.dialogs.pluginsSelector.removeConfirmTitle', { name: opts.displayName, id: opts.id }),
      hint: t('tui.dialogs.pluginsSelector.removeConfirmHint'),
      formatHint: mutedHintLine,
      options: [
        {
          value: REMOVE_CONFIRM_CANCEL,
          label: t('tui.dialogs.pluginsSelector.removeCancelLabel'),
          description: t('tui.dialogs.pluginsSelector.removeCancelDesc'),
        },
        {
          value: REMOVE_CONFIRM_REMOVE,
          label: t('tui.dialogs.pluginsSelector.removeConfirmLabel'),
          tone: 'danger',
          description: t('tui.dialogs.pluginsSelector.removeConfirmDesc'),
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
      title: t('tui.dialogs.pluginsSelector.installTrustTitle', { label: opts.label }),
      hint: t('tui.dialogs.pluginsSelector.installTrustHint'),
      formatHint: mutedHintLine,
      notice: t('tui.dialogs.pluginsSelector.installTrustNotice'),
      noticeTone: 'warning',
      options: [
        {
          value: INSTALL_TRUST_EXIT,
          label: t('tui.dialogs.pluginsSelector.installTrustExitLabel'),
          description: t('tui.dialogs.pluginsSelector.installTrustExitDesc'),
        },
        {
          value: INSTALL_TRUST_TRUST,
          label: t('tui.dialogs.pluginsSelector.installTrustTrustLabel'),
          tone: 'danger',
          description: t('tui.dialogs.pluginsSelector.installTrustTrustDesc'),
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
  const state =
    plugin.state === 'ok'
      ? ''
      : ` · ${t('tui.dialogs.pluginsSelector.pluginState', { state: plugin.state })}`;
  const skills = t(
    plugin.skillCount === 1
      ? 'tui.dialogs.pluginsSelector.skillCount_one'
      : 'tui.dialogs.pluginsSelector.skillCount_other',
    { count: plugin.skillCount },
  );
  const mcp =
    plugin.mcpServerCount > 0
      ? ` · ${t('tui.dialogs.pluginsSelector.mcpCount', {
          enabled: plugin.enabledMcpServerCount,
          total: plugin.mcpServerCount,
        })}`
      : '';
  const diagnostics = plugin.hasErrors
    ? ` · ${t('tui.dialogs.pluginsSelector.diagnosticsAvailable')}`
    : '';
  const source = ` · ${formatPluginSourceLabel(plugin)}`;
  const trust = ` · ${pluginTrustLabel(plugin)}`;
  return `${t('tui.dialogs.pluginsSelector.pluginId', { id: plugin.id })} · ${skills}${mcp}${source}${trust}${state}${diagnostics}`;
}

function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== 'ok') return plugin.state;
  return plugin.enabled ? 'enabled' : 'disabled';
}

function pluginStatusLabel(status: string): string {
  switch (status) {
    case 'enabled':
      return t('tui.dialogs.pluginsSelector.statusEnabled');
    case 'disabled':
      return t('tui.dialogs.pluginsSelector.statusDisabled');
    default:
      return status;
  }
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
  | { readonly kind: 'install-source'; readonly source: string }
  | { readonly kind: 'open-url'; readonly url: string; readonly label: string };

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
  { id: 'installed', label: t('tui.dialogs.pluginsSelector.tabInstalled') },
  { id: 'official', label: t('tui.dialogs.pluginsSelector.tabOfficial') },
  { id: 'third-party', label: t('tui.dialogs.pluginsSelector.tabThirdParty') },
  { id: 'custom', label: t('tui.dialogs.pluginsSelector.tabCustom') },
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
    // The hardcoded Web Bridge entry always leads the Official tab, even when
    // the catalog is loading or unreachable. Dedupe by id so a catalog that
    // also lists it does not render a second row.
    return [WEB_BRIDGE_ENTRY, ...this.officialCatalogEntries];
  }

  private get officialCatalogEntries(): readonly PluginMarketplaceEntry[] {
    // Dedupe by id (not reference): if the official catalog also lists
    // kimi-webbridge, the pinned row already represents it, so suppress the
    // catalog copy to avoid a duplicate row on the Official tab.
    return this.marketplaceEntries.filter(
      (entry) => entry.tier === 'official' && entry.id !== WEB_BRIDGE_ENTRY.id,
    );
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
      if (isPinnedWebBridgeEntry(entry)) {
        this.opts.onSelect({ kind: 'open-url', url: WEB_BRIDGE_URL, label: entry.displayName });
        return;
      }
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
          ? t('tui.dialogs.pluginsSelector.tabHintCustom')
          : t('tui.dialogs.pluginsSelector.tabHintMarketplace');
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(` ${t('tui.dialogs.pluginsSelector.panelTitle')}`),
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
      lines.push(chalk.hex(colors.textMuted)(`  ${t('tui.dialogs.pluginsSelector.noPluginsInstalled')}`));
    } else {
      for (let i = 0; i < installed.length; i++) {
        lines.push(...this.renderInstalledRow(installed[i]!, i, width));
      }
    }
    lines.push('');
    lines.push(
      mutedHintLine(
        ` ${t('tui.dialogs.pluginsSelector.countInstalled', { count: installed.length })}`,
        colors,
      ),
    );
  }

  private installedHint(): string {
    const plugin = this.opts.installed[this.selectedIndex];
    const hasUpdate = plugin !== undefined && this.installedUpdateStatus(plugin) !== undefined;
    const enterAction = hasUpdate
      ? t('tui.dialogs.pluginsSelector.enterUpdate')
      : t('tui.dialogs.pluginsSelector.enterDetails');
    return t('tui.dialogs.pluginsSelector.tabHintInstalled', { enterAction });
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
    const statusLabel = status === undefined ? undefined : pluginStatusLabel(status);
    const update = this.installedUpdateStatus(plugin);
    let line = prefix + labelStyle(plugin.displayName);
    if (status !== undefined && statusLabel !== undefined) {
      line += '  ' + statusStyle({ kind: 'plugin', value: '', label: '', description: '', status }, colors)(statusLabel);
    }
    if (update !== undefined) {
      const badge = t('tui.dialogs.pluginsSelector.updateStatus', {
        local: update.local,
        latest: update.latest,
      });
      line += '  ' + marketplaceStatusStyle(`update ${update.local}`, colors)(badge);
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
    indexOffset = 0,
  ): void {
    const colors = currentTheme.palette;
    if (this.market.status === 'loading' || this.market.status === 'idle') {
      lines.push(chalk.hex(colors.textMuted)(`  ${t('tui.dialogs.pluginsSelector.loadingMarketplace')}`));
      return;
    }
    if (this.market.status === 'error') {
      lines.push(
        chalk.hex(colors.warning)(
          `  ${t('tui.dialogs.pluginsSelector.marketplaceUnavailable', { message: this.market.message })}`,
        ),
      );
      lines.push(
        mutedHintLine(`  ${t('tui.dialogs.pluginsSelector.useCustomTabHint')}`, colors),
      );
      return;
    }
    if (entries.length === 0) {
      lines.push(chalk.hex(colors.textMuted)(`  ${t('tui.dialogs.pluginsSelector.noPluginsFound')}`));
    } else {
      for (let i = 0; i < entries.length; i++) {
        lines.push(...this.renderMarketplaceRow(entries[i]!, i + indexOffset, width));
      }
    }
    const installedCount = entries.filter((e) => this.opts.installedIds.has(e.id)).length;
    lines.push('');
    lines.push(
      mutedHintLine(
        ` ${t('tui.dialogs.pluginsSelector.marketplaceCount', {
          installed: installedCount,
          available: entries.length - installedCount,
        })}`,
        colors,
      ),
    );
    lines.push(
      mutedHintLine(
        ` ${t('tui.dialogs.pluginsSelector.marketplaceSource', { source: this.market.source })}`,
        colors,
      ),
    );
  }

  private renderOfficial(lines: string[], width: number): void {
    // Web Bridge is pinned above the catalog and stays visible while the
    // catalog loads or errors, since it's built into the TUI rather than
    // fetched. Catalog rows shift down by one index to match.
    lines.push(...this.renderMarketplaceRow(WEB_BRIDGE_ENTRY, 0, width));
    this.renderMarketplaceTab(lines, width, this.officialCatalogEntries, 1);
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
    const status = isPinnedWebBridgeEntry(entry)
      ? 'open-in-browser'
      : marketplaceEntryStatus(entry, this.installedVersions);
    const statusLabel = marketplaceStatusLabel(status);
    const line =
      prefix + labelStyle(entry.displayName) + '  ' + marketplaceStatusStyle(status, colors)(statusLabel);
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    for (const descLine of wrapOverviewDescription(marketplaceEntryDescription(entry), descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderCustom(lines: string[], width: number): void {
    const colors = currentTheme.palette;
    lines.push(mutedHintLine(` ${t('tui.dialogs.pluginsSelector.installFromUrlHint')}`, colors));
    lines.push('');
    lines.push(...renderUrlInputBox(this.customInput, this.focused, width, colors));
  }

  private renderInstalling(width: number): string[] {
    const colors = currentTheme.palette;
    const lines = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(` ${t('tui.dialogs.pluginsSelector.panelTitle')}`),
      '',
      chalk.hex(colors.textMuted)(
        `  ${t('tui.dialogs.pluginsSelector.installingFromMarketplace', { label: this.installing ?? '' })}`,
      ),
      '',
      chalk.hex(colors.primary)('─'.repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
}

function buildMcpItems(info: PluginInfo): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = info.mcpServers.map((server) => {
    const status = server.enabled ? 'enabled' : 'disabled';
    return {
      value: `${MCP_SERVER_PREFIX}${server.name}`,
      kind: 'plugin',
      label: server.name,
      status,
      statusLabel: t(`tui.dialogs.pluginsSelector.status${status.charAt(0).toUpperCase() + status.slice(1)}`),
      description: mcpServerDescription(server),
    };
  });
  items.push({
    value: 'back',
    kind: 'action',
    label: t('tui.dialogs.pluginsSelector.backToInstalled'),
    description: t('tui.dialogs.pluginsSelector.backToInstalledDesc'),
  });
  return items;
}

function mcpServerDescription(server: PluginMcpServerInfo): string {
  const action = server.enabled ? t('tui.dialogs.pluginsSelector.mcpDisable') : t('tui.dialogs.pluginsSelector.mcpEnable');
  if (server.transport === 'http' || server.transport === 'sse') {
    return t('tui.dialogs.pluginsSelector.mcpServerTransportHint', {
      action,
      transport: server.transport.toUpperCase(),
      target: server.url ?? server.runtimeName,
    });
  }
  const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
  const command = `${server.command ?? ''}${args}`.trim();
  const base = t('tui.dialogs.pluginsSelector.mcpServerStdioHint', {
    action,
    command: command || server.runtimeName,
  });
  return server.cwd === undefined
    ? base
    : `${base}${t('tui.dialogs.pluginsSelector.mcpServerCwdSuffix', { cwd: server.cwd })}`;
}

function mcpItemServerName(item: PluginsOverviewItem): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined;
  return item.value.slice(MCP_SERVER_PREFIX.length);
}

function marketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  const tier = marketplaceTierLabel(entry.tier);
  const description = entry.description ?? tier;
  const version =
    entry.version !== undefined
      ? ` · ${t('tui.dialogs.pluginsSelector.versionPrefix', { version: entry.version })}`
      : '';
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(', ')}`
      : '';
  const tierSuffix = entry.description !== undefined ? ` · ${tier}` : '';
  return `${description} · ${t('tui.dialogs.pluginsSelector.pluginId', { id: entry.id })}${version}${tierSuffix}${keywords}`;
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry['tier']): string {
  if (tier === 'official') return t('tui.dialogs.pluginsSelector.marketplaceTierOfficial');
  if (tier === 'curated') return t('tui.dialogs.pluginsSelector.marketplaceTierCurated');
  return t('tui.dialogs.pluginsSelector.marketplaceTierUnknown');
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
      return status.version === undefined ? 'installed' : `installed v${status.version}`;
    case 'not-installed':
      return installStatus(entry);
  }
}

function marketplaceStatusLabel(status: string): string {
  if (status === 'open-in-browser') {
    return t('tui.dialogs.pluginsSelector.openInBrowser');
  }
  if (status === 'installed') {
    return t('tui.dialogs.pluginsSelector.installedStatus');
  }
  if (status.startsWith('install v')) {
    const version = status.slice('install v'.length);
    return t('tui.dialogs.pluginsSelector.installStatusVersion', { version });
  }
  if (status === 'install') {
    return t('tui.dialogs.pluginsSelector.installStatus');
  }
  if (status.startsWith('installed v')) {
    const version = status.slice('installed v'.length);
    return t('tui.dialogs.pluginsSelector.installedStatusVersion', { version });
  }
  if (status.startsWith('update ')) {
    const remainder = status.slice('update '.length);
    const arrowIndex = remainder.indexOf(' → ');
    if (arrowIndex >= 0) {
      const local = remainder.slice(0, arrowIndex);
      const latest = remainder.slice(arrowIndex + ' → '.length);
      return t('tui.dialogs.pluginsSelector.updateStatus', { local, latest });
    }
  }
  return status;
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
