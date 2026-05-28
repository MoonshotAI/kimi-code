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

const ANSI_SGR = /\[[0-9;]*m/g;
const SGR_SEQUENCE = String.raw`\[[0-9;]*m`;
const HIGHLIGHTED_D_REMOVE = new RegExp(`${SGR_SEQUENCE}(?:${SGR_SEQUENCE})*D(?:${SGR_SEQUENCE})+ remove`, 'g');
const MID = '\u00B7';

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

function primaryShortcut(text: string): string {
  return withAnsiColors(() => chalk.hex(darkColors.primary).bold(text));
}

function dangerShortcut(text: string): string {
  return withAnsiColors(() => chalk.hex(darkColors.error).bold(text));
}

describe('plugins selector dialogs', () => {
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
    expect(raw.match(HIGHLIGHTED_D_REMOVE)).toHaveLength(1);
    expect(raw).toContain(primaryShortcut('Space'));
    expect(raw).toContain(primaryShortcut('M'));
    expect(raw).toContain(dangerShortcut('D'));
    expect(raw).toContain(primaryShortcut('Enter'));
    expect(out).toContain('Marketplace');
    expect(out).toContain('Summary');

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'info', id: 'kimi-datasource' });
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
      `Enter/Space install ${MID} Workflow skills ${MID} id superpowers ${MID} v5.1.0 ${MID} Curated plugin ${MID} workflow`,
    );
    expect(raw).toContain(primaryShortcut('Enter'));
    expect(raw).toContain(primaryShortcut('Space'));
    expect(out).toContain('Actions');
    expect(out).toContain('Back to installed plugins');

    picker.handleInput(' ');
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'install',
      entry: expect.objectContaining({ id: 'superpowers' }),
    });
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
    expect(out).toContain(`Enter/Space update ${MID} Plugin ${MID} id superpowers`);

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
    expect(raw).toContain(primaryShortcut('Enter'));
    expect(raw).toContain(primaryShortcut('Space'));

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
    expect(raw).toContain(primaryShortcut('Enter'));
    expect(raw).toContain(primaryShortcut('Space'));
    expect(raw).toContain(dangerShortcut('Remove plugin'));

    picker.handleInput('\r');

    expect(results).toEqual([{ kind: 'confirm' }]);
  });
});
