import { describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

import {
  PluginMcpSelectorComponent,
  PluginMarketplaceSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsOverviewSelectorComponent,
  type PluginMcpSelection,
  type PluginRemoveConfirmResult,
} from '#/tui/components/dialogs/plugins-selector';
import { darkColors } from '#/tui/theme/colors';
import { pluginTrustLabel } from '#/tui/utils/plugin-source-label';

const ANSI_SGR = /\[[0-9;]*m/g;
const MID = '\u00B7';
const ESC = String.fromCodePoint(27);
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;

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

  it('renders installed plugins as selectable overview entries', () => {
    const onSelect = vi.fn();
    const picker = new PluginsOverviewSelectorComponent({
      plugins: [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 2,
          mcpServerCount: 1,
          enabledMcpServerCount: 1,
          hasErrors: false,
          source: 'local-path',
        },
      ],
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    const raw = renderRaw(picker);
    const out = strip(raw);
    expect(out).toContain('Installed plugins (1)');
    expect(out).toContain('Actions');
    expect(out).toContain('? Kimi Datasource  enabled');
    expect(out).toContain(`id kimi-datasource ${MID} 2 skills ${MID} MCP 1/1`);
    expect(out).not.toContain('Space disable');
    expect(out).not.toContain('Enter info');
    expect(out).toContain('Space toggle · M MCP servers · D remove · Enter details');
    expect(out).toContain('Marketplace');
    expect(out).toContain('Summary');

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'info', id: 'kimi-datasource' });
  });

  it('ignores Left/Right arrows in the overview (no enter/exit by arrow)', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new PluginsOverviewSelectorComponent({
      plugins: [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 2,
          mcpServerCount: 1,
          enabledMcpServerCount: 1,
          hasErrors: false,
          source: 'local-path',
        },
      ],
      colors: darkColors,
      onSelect,
      onCancel,
    });

    picker.handleInput(RIGHT); // must NOT open details
    expect(onSelect).not.toHaveBeenCalled();
    picker.handleInput(LEFT); // must NOT cancel/exit
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders marketplace plugins separately from marketplace actions', () => {
    const onSelect = vi.fn();
    const picker = new PluginMarketplaceSelectorComponent({
      entries: [
        {
          id: 'superpowers',
          tier: 'curated',
          displayName: 'Superpowers',
          version: '5.1.0',
          description: 'Workflow skills',
          source: 'https://example.com/superpowers.zip',
          keywords: ['workflow'],
        },
      ],
      installedIds: new Set(),
      source: '/tmp/marketplace.json',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    const raw = renderRaw(picker);
    const out = strip(raw);
    expect(out).toContain('Marketplace (1)');
    expect(out).toContain('? Superpowers  install v5.1.0');
    expect(out).toContain(
      `Workflow skills ${MID} id superpowers ${MID} v5.1.0 ${MID} Curated plugin ${MID} workflow`,
    );
    expect(out).toContain('Enter install/update');
    expect(out).toContain('Actions');
    expect(out).toContain('Back to installed plugins');

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
  });

  it('installs only on Enter, not Space, in the marketplace', () => {
    const onSelect = vi.fn();
    const picker = new PluginMarketplaceSelectorComponent({
      entries: [
        {
          id: 'superpowers',
          tier: 'curated',
          displayName: 'Superpowers',
          version: '5.1.0',
          description: 'Workflow skills',
          source: 'https://example.com/superpowers.zip',
          keywords: ['workflow'],
        },
      ],
      installedIds: new Set(),
      source: '/tmp/marketplace.json',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' '); // Space must NOT install
    expect(onSelect).not.toHaveBeenCalled();
    picker.handleInput('\r'); // Enter installs
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
  });

  it('ignores the Left arrow in the marketplace view (Esc returns instead)', () => {
    const onCancel = vi.fn();
    const picker = new PluginMarketplaceSelectorComponent({
      entries: [
        {
          id: 'superpowers',
          tier: 'curated',
          displayName: 'Superpowers',
          version: '5.1.0',
          description: 'Workflow skills',
          source: 'https://example.com/superpowers.zip',
          keywords: ['workflow'],
        },
      ],
      installedIds: new Set(),
      source: '/tmp/marketplace.json',
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel,
    });

    picker.handleInput(LEFT); // must NOT return to the overview
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('issues install for installed marketplace entries (update path)', () => {
    const onSelect = vi.fn();
    const picker = new PluginMarketplaceSelectorComponent({
      entries: [
        {
          id: 'superpowers',
          displayName: 'Superpowers',
          source: 'https://example.com/superpowers.zip',
        },
      ],
      installedIds: new Set(['superpowers']),
      source: '/tmp/marketplace.json',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip).join('\n');
    expect(out).toContain('? Superpowers  installed');
    expect(out).toContain(`Plugin ${MID} id superpowers`);

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
  });

  it('toggles an installed plugin from the overview with space', () => {
    const onSelect = vi.fn();
    const picker = new PluginsOverviewSelectorComponent({
      plugins: [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'local-path',
        },
      ],
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' ');

    expect(onSelect).toHaveBeenCalledWith({
      kind: 'toggle',
      id: 'kimi-datasource',
      enabled: false,
    });
  });

  it('issues a remove request from the overview on D', () => {
    const onSelect = vi.fn();
    const picker = new PluginsOverviewSelectorComponent({
      plugins: [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'local-path',
        },
      ],
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('d');

    expect(onSelect).toHaveBeenCalledWith({ kind: 'remove', id: 'kimi-datasource' });
  });

  it('opens MCP server management from the overview on M', () => {
    const onSelect = vi.fn();
    const picker = new PluginsOverviewSelectorComponent({
      plugins: [
        {
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
        },
      ],
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('m');

    expect(onSelect).toHaveBeenCalledWith({ kind: 'mcp', id: 'kimi-datasource' });
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
      colors: darkColors,
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

  it('renders plugin action hints inline on the overview row', () => {
    const picker = new PluginsOverviewSelectorComponent({
      plugins: [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'local-path',
        },
      ],
      selectedId: 'kimi-datasource',
      pluginHint: { id: 'kimi-datasource', text: 'pending /new' },
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip).join('\n');

    expect(out).toContain('? Kimi Datasource  enabled  pending /new');
  });

  it('defaults plugin removal confirmation to cancel', () => {
    const results: PluginRemoveConfirmResult[] = [];
    const picker = new PluginRemoveConfirmComponent({
      id: 'kimi-datasource',
      displayName: 'Kimi Datasource',
      colors: darkColors,
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
      colors: darkColors,
      onDone: (result) => {
        results.push(result);
      },
    });

    picker.handleInput('[B');
    const raw = renderRaw(picker);
    expect(strip(raw)).toContain('Enter/Space select');
    // The destructive option label keeps its danger styling (error + bold).
    expect(raw).toContain(dangerShortcut('Remove plugin'));

    picker.handleInput('\r');

    expect(results).toEqual([{ kind: 'confirm' }]);
  });
});
