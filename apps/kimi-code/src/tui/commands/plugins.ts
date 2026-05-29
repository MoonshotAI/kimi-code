import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  PluginMcpSelectorComponent,
  PluginMarketplaceSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsOverviewSelectorComponent,
  type PluginMcpSelection,
  type PluginMarketplaceSelection,
  type PluginRemoveConfirmResult,
  type PluginsOverviewSelection,
} from '../components/dialogs/plugins-selector';
import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from '../components/messages/plugins-status-panel';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { formatErrorMessage } from '../utils/event-payload';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';
import type { SlashCommandHost } from './dispatch';

interface ShowPluginsPickerOptions {
  readonly selectedId?: string;
  readonly pluginHint?: {
    readonly id: string;
    readonly text: string;
  };
}

interface PluginMcpServerHint {
  readonly server: string;
  readonly text: string;
}

interface ShowPluginMcpPickerOptions {
  readonly selectedServer?: string;
  readonly serverHint?: PluginMcpServerHint;
}

export async function handlePluginsCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  const sub = args[0];
  const rest = args.slice(1);
  const session = host.requireSession();

  try {
    if (sub === undefined) {
      await showPluginsPicker(host);
      return;
    }
    if (sub === 'list') {
      await renderPluginsList(host);
      return;
    }
    if (sub === 'install') {
      const source = rest.join(' ').trim();
      if (source.length === 0) {
        host.showError('Usage: /plugins install <local-path-or-zip-url>');
        return;
      }
      await installPluginFromSource(host, source);
      return;
    }
    if (sub === 'marketplace') {
      await showPluginMarketplacePicker(host, rest.join(' ').trim() || undefined);
      return;
    }
    if (sub === 'info') {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await renderPluginInfo(host, id);
      return;
    }
    if (sub === 'mcp') {
      const action = rest[0];
      const id = rest[1];
      const server = rest[2];
      if ((action !== 'enable' && action !== 'disable') || id === undefined || server === undefined) {
        host.showError('Usage: /plugins mcp enable|disable <id> <server>');
        return;
      }
      await session.setPluginMcpServerEnabled(id, server, action === 'enable');
      host.showStatus(
        `${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${server} for ${id}. Run /new to apply.`,
      );
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await applyPluginEnabled(host, id, sub === 'enable');
      return;
    }
    if (sub === 'remove') {
      const id = rest[0];
      if (id === undefined) {
        host.showError('Usage: /plugins remove <id>');
        return;
      }
      if (!(await confirmRemovePlugin(host, id))) {
        host.showStatus(`Remove cancelled: ${id}.`);
        return;
      }
      await session.removePlugin(id);
      host.showStatus(`Removed ${id} (plugin files left in place).`);
      return;
    }
    if (sub === 'reload') {
      await reloadPlugins(host);
      return;
    }
    const plugins = await session.listPlugins();
    if (plugins.some((plugin) => plugin.id === sub)) {
      await renderPluginInfo(host, sub);
      return;
    }
    host.showError(`Unknown /plugins action: ${sub}. Run /plugins to choose interactively.`);
  } catch (error) {
    host.showError(`/plugins ${sub ?? ''} failed: ${formatErrorMessage(error)}`);
  }
}

async function showPluginsPicker(
  host: SlashCommandHost,
  options?: ShowPluginsPickerOptions,
): Promise<void> {
  let plugins: readonly PluginSummary[];
  try {
    plugins = await host.requireSession().listPlugins();
  } catch (error) {
    host.showError(`Failed to load plugins: ${formatErrorMessage(error)}`);
    return;
  }

  host.mountEditorReplacement(
    new PluginsOverviewSelectorComponent({
      plugins,
      selectedId: options?.selectedId,
      pluginHint: options?.pluginHint,
      colors: host.state.theme.colors,
      onSelect: (selection) => {
        host.restoreEditor();
        void handlePluginsOverviewSelection(host, selection).catch((error: unknown) => {
          host.showError(`/plugins failed: ${formatErrorMessage(error)}`);
        });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function showPluginMarketplacePicker(host: SlashCommandHost, source?: string): Promise<void> {
  try {
    const [marketplace, installed] = await Promise.all([
      loadPluginMarketplace({ workDir: host.state.appState.workDir, source }),
      host.requireSession().listPlugins(),
    ]);
    host.mountEditorReplacement(
      new PluginMarketplaceSelectorComponent({
        entries: marketplace.plugins,
        installedIds: new Set(installed.map((plugin) => plugin.id)),
        source: marketplace.source,
        colors: host.state.theme.colors,
        onSelect: (selection) => {
          host.restoreEditor();
          void handlePluginMarketplaceSelection(host, selection).catch((error: unknown) => {
            host.showError(`/plugins marketplace failed: ${formatErrorMessage(error)}`);
          });
        },
        onCancel: () => {
          host.restoreEditor();
          void showPluginsPicker(host);
        },
      }),
    );
  } catch (error) {
    host.showError(`Failed to load plugin marketplace: ${formatErrorMessage(error)}`);
  }
}

async function showPluginMcpPicker(
  host: SlashCommandHost,
  id: string,
  options?: ShowPluginMcpPickerOptions,
): Promise<void> {
  let info: PluginInfo;
  try {
    info = await host.requireSession().getPluginInfo(id);
  } catch (error) {
    host.showError(`Failed to load plugin MCP servers: ${formatErrorMessage(error)}`);
    return;
  }

  host.mountEditorReplacement(
    new PluginMcpSelectorComponent({
      info,
      selectedServer: options?.selectedServer,
      serverHint: options?.serverHint,
      colors: host.state.theme.colors,
      onSelect: (selection) => {
        host.restoreEditor();
        void handlePluginMcpSelection(host, selection).catch((error: unknown) => {
          host.showError(`/plugins mcp failed: ${formatErrorMessage(error)}`);
        });
      },
      onCancel: () => {
        host.restoreEditor();
        void showPluginsPicker(host, { selectedId: id });
      },
    }),
  );
}

async function confirmRemovePlugin(host: SlashCommandHost, id: string): Promise<boolean> {
  let displayName = id;
  try {
    displayName = (await host.requireSession().getPluginInfo(id)).displayName;
  } catch {
    // Keep the confirmation available even when plugin details cannot be loaded.
  }

  return new Promise((resolveConfirmed) => {
    host.mountEditorReplacement(
      new PluginRemoveConfirmComponent({
        id,
        displayName,
        colors: host.state.theme.colors,
        onDone: (result: PluginRemoveConfirmResult) => {
          host.restoreEditor();
          resolveConfirmed(result.kind === 'confirm');
        },
      }),
    );
  });
}

async function applyPluginEnabled(
  host: SlashCommandHost,
  id: string,
  enabled: boolean,
  showStatus = true,
): Promise<string> {
  const session = host.requireSession();
  await session.setPluginEnabled(id, enabled);
  let info: PluginInfo | undefined;
  try {
    info = await session.getPluginInfo(id);
  } catch {
    info = undefined;
  }
  const mcpHint =
    enabled && info !== undefined && info.mcpServerCount > info.enabledMcpServerCount
      ? ` Some MCP servers are disabled; re-enable with /plugins mcp enable ${id} <server>.`
      : '';
  if (showStatus) {
    host.showStatus(`${enabled ? 'Enabled' : 'Disabled'} ${id}. Run /new to apply.${mcpHint}`);
  }
  const inlineMcpHint = mcpHint.length > 0 ? ' · MCP servers disabled' : '';
  return `${pluginInlineChangeHint()}${inlineMcpHint}`;
}

async function handlePluginsOverviewSelection(
  host: SlashCommandHost,
  selection: PluginsOverviewSelection,
): Promise<void> {
  const session = host.requireSession();
  switch (selection.kind) {
    case 'marketplace':
      await showPluginMarketplacePicker(host);
      return;
    case 'reload':
      await reloadPlugins(host);
      await showPluginsPicker(host);
      return;
    case 'show-list':
      await renderPluginsList(host);
      return;
    case 'toggle': {
      const hint = await applyPluginEnabled(host, selection.id, selection.enabled, false);
      await showPluginsPicker(host, {
        selectedId: selection.id,
        pluginHint: { id: selection.id, text: hint },
      });
      return;
    }
    case 'mcp':
      await showPluginMcpPicker(host, selection.id);
      return;
    case 'remove':
      if (!(await confirmRemovePlugin(host, selection.id))) {
        host.showStatus(`Remove cancelled: ${selection.id}.`);
        await showPluginsPicker(host, { selectedId: selection.id });
        return;
      }
      await session.removePlugin(selection.id);
      host.showStatus(`Removed ${selection.id} (plugin files left in place).`);
      await showPluginsPicker(host);
      return;
    case 'info':
      await renderPluginInfo(host, selection.id);
      return;
  }
}

async function handlePluginMcpSelection(
  host: SlashCommandHost,
  selection: PluginMcpSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'toggle':
      await host.requireSession().setPluginMcpServerEnabled(
        selection.pluginId,
        selection.server,
        selection.enabled,
      );
      await showPluginMcpPicker(host, selection.pluginId, {
        selectedServer: selection.server,
        serverHint: {
          server: selection.server,
          text: pluginInlineChangeHint(),
        },
      });
      return;
    case 'back':
      await showPluginsPicker(host, { selectedId: selection.pluginId });
      return;
  }
}

async function handlePluginMarketplaceSelection(
  host: SlashCommandHost,
  selection: PluginMarketplaceSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'install':
      host.showStatus(`Installing or updating ${selection.entry.displayName} from marketplace...`);
      await installPluginFromSource(host, selection.entry.source, {
        successNotice: 'marketplace',
      });
      await showPluginsPicker(host, { selectedId: selection.entry.id });
      return;
    case 'back':
      await showPluginsPicker(host);
      return;
  }
}

async function renderPluginsList(
  host: SlashCommandHost,
  plugins?: readonly PluginSummary[],
): Promise<void> {
  const currentPlugins = plugins ?? (await host.requireSession().listPlugins());
  const lines = buildPluginsListLines({
    colors: host.state.theme.colors,
    plugins: currentPlugins,
  });
  const title = ` Plugins (${currentPlugins.length}) `;
  const panel = new UsagePanelComponent(lines, host.state.theme.colors.primary, title);
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function renderPluginInfo(host: SlashCommandHost, id: string): Promise<void> {
  const info = await host.requireSession().getPluginInfo(id);
  const lines = buildPluginsInfoLines({ colors: host.state.theme.colors, info });
  const panel = new UsagePanelComponent(lines, host.state.theme.colors.primary, ` ${info.id} `);
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function installPluginFromSource(
  host: SlashCommandHost,
  source: string,
  options?: { readonly successNotice?: 'marketplace' },
): Promise<void> {
  const summary = await host.requireSession().installPlugin(
    resolvePluginInstallSource(source, host.state.appState.workDir),
  );
  const serverWord = summary.mcpServerCount === 1 ? 'server' : 'servers';
  const mcpHint =
    summary.mcpServerCount > 0
      ? ` Declares ${summary.mcpServerCount} MCP ${serverWord}; enabled by default and configurable from /plugins.`
      : '';
  const installVerb = options?.successNotice === 'marketplace' ? 'Installed or updated' : 'Installed';
  host.showStatus(
    `${installVerb} ${summary.displayName} (${summary.id}).${mcpHint} Run /new to apply plugin changes.`,
  );
  if (options?.successNotice === 'marketplace') {
    host.showNotice(
      `Installed or updated ${summary.displayName}`,
      `Marketplace install or update succeeded for ${summary.id}. Run /new to apply plugin changes.`,
    );
  }
}

async function reloadPlugins(host: SlashCommandHost): Promise<void> {
  const summary = await host.requireSession().reloadPlugins();
  const line = `Reload: +${summary.added.length} -${summary.removed.length}` +
    (summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : '');
  host.showStatus(line);
}

function resolvePluginInstallSource(source: string, workDir: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed === '~') return osHomedir();
  if (trimmed.startsWith('~/')) return join(osHomedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(workDir, trimmed);
}

function pluginInlineChangeHint(): string {
  return 'pending /new';
}
