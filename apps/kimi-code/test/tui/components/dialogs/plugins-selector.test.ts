import { describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

import {
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsPanelComponent,
  type PluginMcpSelection,
  type PluginRemoveConfirmResult,
  type PluginsPanelSelection,
} from '#/tui/components/dialogs/plugins-selector';
import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { pluginTrustLabel } from '#/tui/utils/plugin-source-label';

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '').replaceAll('\u276F', '?');
}

function withAnsiColors<T>(fn: () => T): T {
  const previousChalkLevel = chalk.level;
  chalk.level = 3;
  try {
    return fn();
  } finally {
    chalk.level = previousChalkLevel;
  }
}

function renderRaw(component: { render(width: number): string[] }, width = 120): string {
  return withAnsiColors(() => component.render(width).join('\n'));
}

function dangerShortcut(text: string): string {
  return withAnsiColors(() => chalk.hex(darkColors.error).bold(text));
}

const superpowers = {
  id: 'superpowers',
  displayName: 'Superpowers',
  version: '5.1.0',
  enabled: true,
  state: 'ok' as const,
  skillCount: 14,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hasErrors: false,
  source: 'local-path' as const,
};

const officialEntries = [
  { id: 'kimi-datasource', tier: 'official' as const, displayName: 'Kimi Datasource', version: '3.1.1', source: 'https://x/d.zip' },
];
const thirdPartyEntries = [
  { id: 'superpowers', tier: 'curated' as const, displayName: 'Superpowers', source: 'https://x/s.zip' },
];
const marketplaceEntries = [...officialEntries, ...thirdPartyEntries];

function makePanel(opts: {
  installed?: readonly (typeof superpowers)[];
  initialTab?: 'installed' | 'official' | 'third-party' | 'custom';
  selectedId?: string;
  pluginHint?: { id: string; text: string };
}) {
  const installed = opts.installed ?? [];
  const onSelect = vi.fn<(s: PluginsPanelSelection) => void>();
  const onRequestMarketplace = vi.fn();
  const panel = new PluginsPanelComponent({
    installed,
    installedIds: new Set(installed.map((p) => p.id)),
    initialTab: opts.initialTab,
    selectedId: opts.selectedId,
    pluginHint: opts.pluginHint,
    onSelect,
    onCancel: vi.fn(),
    onRequestMarketplace,
  });
  return { panel, onSelect, onRequestMarketplace };
}

describe('plugins selector dialogs', () => {
  it('trusts only built-in Kimi CDN plugin paths', () => {
    expect(pluginTrustLabel({
      id: 'kimi-datasource',
      displayName: 'Kimi Datasource',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'zip-url',
      originalSource: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
    })).toBe('official');
    expect(pluginTrustLabel({
      id: 'superpowers',
      displayName: 'Superpowers',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'zip-url',
      originalSource: 'https://code.kimi.com/kimi-code/plugins/curated/superpowers.zip',
    })).toBe('curated');
    expect(pluginTrustLabel({
      id: 'demo',
      displayName: 'Demo',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'zip-url',
      originalSource: 'https://code.kimi.com/demo.zip',
    })).toBe('third-party');
    expect(pluginTrustLabel({
      id: 'local',
      displayName: 'Local',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'local-path',
      originalSource: 'https://code.kimi.com/kimi-code/plugins/official/local',
    })).toBe('third-party');
  });

  it('opens on the Installed tab with the four panel tabs', () => {
    const { panel } = makePanel({ installed: [superpowers] });
    const out = strip(renderRaw(panel));
    expect(out).toContain('Plugins');
    expect(out).toContain('Installed');
    expect(out).toContain('Official');
    expect(out).toContain('Third-party');
    expect(out).toContain('Custom');
    expect(out).toContain('? Superpowers  enabled');
    expect(out).toContain('Space toggle');
    expect(out).toContain('1 installed');
  });

  it('repaints from the current theme palette without remounting', () => {
    const { panel } = makePanel({ installed: [superpowers] });
    const previous = currentTheme.palette;
    try {
      currentTheme.setPalette(darkColors);
      const darkOut = renderRaw(panel);
      currentTheme.setPalette(lightColors);
      const lightOut = renderRaw(panel);
      // A palette snapshot cached at construction would render identically
      // after the switch; reading currentTheme.palette at render time must
      // produce different ANSI output for the same panel instance.
      expect(darkOut).not.toBe(lightOut);
    } finally {
      currentTheme.setPalette(previous);
    }
  });

  it('toggles an installed plugin with Space', () => {
    const { panel, onSelect } = makePanel({ installed: [superpowers] });
    panel.handleInput(' ');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'toggle', id: 'superpowers', enabled: false });
  });

  it('routes D / M / R / Enter to remove / mcp / reload / details on the Installed tab', () => {
    const { panel, onSelect } = makePanel({ installed: [superpowers] });
    panel.handleInput('d');
    panel.handleInput('m');
    panel.handleInput('r');
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'remove', id: 'superpowers' });
    expect(onSelect).toHaveBeenCalledWith({ kind: 'mcp', id: 'superpowers' });
    expect(onSelect).toHaveBeenCalledWith({ kind: 'reload' });
    expect(onSelect).toHaveBeenCalledWith({ kind: 'details', id: 'superpowers' });
  });

  it('Enter on an installed plugin with an available update installs it', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '4.0.0' }];
    const entries = [
      {
        id: 'superpowers',
        tier: 'curated' as const,
        displayName: 'Superpowers',
        version: '5.0.0',
        source: 'https://x/s.zip',
      },
    ];
    const { panel, onSelect } = makePanel({ installed });
    panel.setMarketplace(entries, '/tmp/marketplace.json');
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
  });

  it('Enter on an up-to-date installed plugin opens details', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '5.0.0' }];
    const entries = [
      {
        id: 'superpowers',
        tier: 'curated' as const,
        displayName: 'Superpowers',
        version: '5.0.0',
        source: 'https://x/s.zip',
      },
    ];
    const { panel, onSelect } = makePanel({ installed });
    panel.setMarketplace(entries, '/tmp/marketplace.json');
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'details', id: 'superpowers' });
  });

  it('I on an installed plugin opens details even when an update is available', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '4.0.0' }];
    const entries = [
      {
        id: 'superpowers',
        tier: 'curated' as const,
        displayName: 'Superpowers',
        version: '5.0.0',
        source: 'https://x/s.zip',
      },
    ];
    const { panel, onSelect } = makePanel({ installed });
    panel.setMarketplace(entries, '/tmp/marketplace.json');
    panel.handleInput('i');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'details', id: 'superpowers' });
  });

  it('renders the inline plugin hint on the installed row', () => {
    const datasource = { ...superpowers, id: 'kimi-datasource', displayName: 'Kimi Datasource', skillCount: 1 };
    const { panel } = makePanel({
      installed: [datasource],
      selectedId: 'kimi-datasource',
      pluginHint: { id: 'kimi-datasource', text: 'pending /new' },
    });
    const out = strip(renderRaw(panel));
    expect(out).toContain('? Kimi Datasource  enabled  pending /new');
  });

  it('lazily loads the Official catalog, then lists installed entries first', () => {
    const { panel, onRequestMarketplace } = makePanel({ installed: [superpowers] });
    panel.handleInput('\t'); // → Official
    expect(onRequestMarketplace).toHaveBeenCalledTimes(1);
    expect(strip(renderRaw(panel))).toContain('Loading marketplace');

    panel.setMarketplace(marketplaceEntries, '/tmp/marketplace.json');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Kimi Datasource  install');
    expect(out).toContain('0 installed · 1 available');
  });

  it('installs the selected Third-party entry on Enter', () => {
    const { panel, onSelect } = makePanel({ installed: [superpowers], initialTab: 'third-party' });
    panel.setMarketplace(marketplaceEntries, '/tmp/marketplace.json');
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
  });

  it('renders an installing state while an install is in progress', () => {
    const { panel } = makePanel({ installed: [superpowers] });
    panel.setInstalling('Superpowers');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Installing Superpowers from marketplace');
  });

  it('keeps a valid selection if ↓ is pressed while the catalog is loading', () => {
    const { panel, onSelect } = makePanel({ initialTab: 'third-party' });
    // Catalog still loading (entries empty); pressing ↓ must not drive the
    // selection negative, or the later Enter would read entries[-1].
    panel.handleInput('\u001b[B'); // ↓
    panel.setMarketplace(marketplaceEntries, '/tmp/marketplace.json');
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
  });

  it('shows untiered marketplace entries on the Third-party tab', () => {
    const untiered = [
      { id: 'custom-plugin', displayName: 'Custom Plugin', source: 'https://x/c.zip' },
    ];
    const { panel } = makePanel({ initialTab: 'third-party' });
    panel.setMarketplace(untiered, '/tmp/marketplace.json');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Custom Plugin  install');
  });

  it('shows an update badge when the marketplace version is newer than installed', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '4.0.0' }];
    const entries = [
      {
        id: 'superpowers',
        tier: 'curated' as const,
        displayName: 'Superpowers',
        version: '5.0.0',
        source: 'https://x/s.zip',
      },
    ];
    const { panel } = makePanel({ installed, initialTab: 'third-party' });
    panel.setMarketplace(entries, '/tmp/marketplace.json');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Superpowers  update 4.0.0 → 5.0.0');
  });

  it('shows an update badge on the Installed tab when the marketplace version is newer', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '4.0.0' }];
    const entries = [
      {
        id: 'superpowers',
        tier: 'curated' as const,
        displayName: 'Superpowers',
        version: '5.0.0',
        source: 'https://x/s.zip',
      },
    ];
    const { panel } = makePanel({ installed });
    panel.setMarketplace(entries, '/tmp/marketplace.json');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Superpowers  enabled  update 4.0.0 → 5.0.0');
  });

  it('does not show an update badge on the Installed tab before the marketplace loads', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '4.0.0' }];
    const { panel } = makePanel({ installed });
    // The marketplace has not been loaded yet, so the badge stays hidden rather
    // than guessing.
    const out = strip(renderRaw(panel));
    expect(out).not.toContain('update');
  });

  it('shows installed · v<version> when the installed plugin is up to date', () => {
    const installed = [{ ...superpowers, id: 'superpowers', version: '5.0.0' }];
    const entries = [
      {
        id: 'superpowers',
        tier: 'curated' as const,
        displayName: 'Superpowers',
        version: '5.0.0',
        source: 'https://x/s.zip',
      },
    ];
    const { panel } = makePanel({ installed, initialTab: 'third-party' });
    panel.setMarketplace(entries, '/tmp/marketplace.json');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Superpowers  installed · v5.0.0');
  });

  it('shows an inline error when the Official catalog fails', () => {
    const { panel } = makePanel({ installed: [superpowers] });
    panel.handleInput('\t'); // → Official
    panel.setMarketplaceError('fetch failed');
    const out = strip(renderRaw(panel));
    expect(out).toContain('Marketplace unavailable: fetch failed');
    expect(out).toContain('Use the Custom tab');
  });

  it('installs from a URL typed on the Custom tab', () => {
    const { panel, onSelect } = makePanel({ initialTab: 'custom' });
    const out = strip(renderRaw(panel));
    expect(out).toContain('Install from a GitHub URL');
    expect(out).toContain('╭');

    for (const ch of 'https://github.com/owner/repo') {
      panel.handleInput(ch);
    }
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install-source',
      source: 'https://github.com/owner/repo',
    });
  });

  it('toggles MCP servers from the MCP selector', () => {
    const selections: PluginMcpSelection[] = [];
    const picker = new PluginMcpSelectorComponent({
      info: {
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        version: '1.0.0',
        enabled: true,
        state: 'ok',
        skillCount: 1,
        mcpServerCount: 1,
        enabledMcpServerCount: 1,
        hasErrors: false,
        source: 'local-path',
        installedAt: '2026-05-29T00:00:00.000Z',
        root: '/plugins/kimi-datasource',
        manifest: undefined,
        mcpServers: [
          {
            name: 'data',
            runtimeName: 'plugin-kimi-datasource-data',
            enabled: true,
            transport: 'stdio',
            command: 'node',
            args: ['./bin/kimi-datasource.mjs'],
            cwd: '/plugins/kimi-datasource',
          },
        ],
        diagnostics: [],
      },
      onSelect: (selection) => {
        selections.push(selection);
      },
      onCancel: vi.fn(),
    });

    const raw = renderRaw(picker);
    const out = strip(raw);
    expect(out).toContain('MCP servers (1/1 enabled)');
    expect(out).toContain('? data  enabled');
    expect(out).toContain('Enter/Space enable/disable');

    picker.handleInput(' ');

    expect(selections).toEqual([
      { kind: 'toggle', pluginId: 'kimi-datasource', server: 'data', enabled: false },
    ]);
  });

  it('defaults plugin removal confirmation to cancel', () => {
    const results: PluginRemoveConfirmResult[] = [];
    const picker = new PluginRemoveConfirmComponent({
      id: 'kimi-datasource',
      displayName: 'Kimi Datasource',
      onDone: (result) => {
        results.push(result);
      },
    });

    const out = picker.render(120).map(strip);
    expect(out).toContain(' Remove Kimi Datasource (kimi-datasource)?');
    expect(out).toContain('  ? Cancel');
    expect(out).toContain('    Keep this plugin installed.');
    expect(out).toContain('    Remove only the install record; plugin files are left in place.');

    picker.handleInput('\r');
    expect(results).toEqual([{ kind: 'cancel' }]);
  });

  it('confirms plugin removal only after choosing remove', () => {
    const results: PluginRemoveConfirmResult[] = [];
    const picker = new PluginRemoveConfirmComponent({
      id: 'kimi-datasource',
      displayName: 'Kimi Datasource',
      onDone: (result) => {
        results.push(result);
      },
    });

    picker.handleInput('\u001b[B');
    const raw = renderRaw(picker);
    expect(strip(raw)).toContain('Enter/Space select');
    // The destructive option label keeps its danger styling (error + bold).
    expect(raw).toContain(dangerShortcut('Remove plugin'));

    picker.handleInput('\r');

    expect(results).toEqual([{ kind: 'confirm' }]);
  });
});
