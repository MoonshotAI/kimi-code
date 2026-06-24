import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsPanelComponent,
  type PluginMcpSelection,
  type PluginRemoveConfirmResult,
  type PluginsPanelSelection,
  type PluginsPanelTabId,
} from '../components/dialogs/plugins-selector';
import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from '../components/messages/plugins-status-panel';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { formatErrorMessage } from '../utils/event-payload';
import { formatPluginSourceLabel } from '../utils/plugin-source-label';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';
import type { SlashCommandHost } from './dispatch';

interface ShowPluginsPickerOptions {
  readonly selectedId?: string;
  readonly pluginHint?: {
    readonly id: string;
    readonly text: string;
  };
  readonly initialTab?: PluginsPanelTabId;
  readonly marketplaceSource?: string;
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
      const spinner = host.showProgressSpinner(`Installing plugin from ${truncateForStatus(source)}…`);
      try {
        await installPluginFromSource(host, source);
        spinner.stop({ ok: true, label: `Install finished — see details below.` });
      } catch (error) {
        spinner.stop({ ok: false, label: `Install failed: ${formatErrorMessage(error)}` });
        throw error;
      }
      return;
    }
    if (sub === 'marketplace') {
      const marketplaceSource = rest.join(' ').trim() || undefined;
      await showPluginsPicker(host, {
        // Custom marketplaces often omit `tier`, so their entries land on the
        // Third-party tab (entry.tier !== 'official'). Open there when a custom
        // source is supplied; otherwise the default catalog's official entries
        // make Official the right landing tab.
        initialTab: marketplaceSource === undefined ? 'official' : 'third-party',
        marketplaceSource,
      });
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
        `${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${server} for ${id}. Run /reload or /new to apply.`,
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
      await removePlugin(host, id);
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

  const panel = new PluginsPanelComponent({
    installed: plugins,
    installedIds: new Set(plugins.map((plugin) => plugin.id)),
    initialTab: options?.initialTab,
    selectedId: options?.selectedId,
    pluginHint: options?.pluginHint,
    onSelect: (selection) => {
      // Each branch of the handler either mounts the next view or restores the
      // editor itself, so do not pre-restore here — that would flash the editor
      // for in-place actions like toggling a plugin.
      void handlePluginsPanelSelection(host, panel, selection).catch((error: unknown) => {
        host.showError(`/plugins failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
    // Every tab except Custom needs the catalog: Official/Third-party list it,
    // and Installed uses it to show update badges. The Installed/Custom tabs
    // keep working even when the marketplace is unreachable (badges simply stay
    // hidden until data arrives).
    onRequestMarketplace: () => {
      void loadMarketplaceCatalog(host, panel, options?.marketplaceSource);
    },
  });
  host.mountEditorReplacement(panel);
  // Kick off the catalog fetch for any tab that needs it: Installed uses it for
  // update badges, Official/Third-party list it. Custom never reads the catalog,
  // so skip the fetch there. Done here (after `panel` is initialized) rather
  // than inside the component constructor, because the callback above closes
  // over `panel`.
  if (options?.initialTab !== 'custom') {
    panel.setMarketplaceLoading();
    void loadMarketplaceCatalog(host, panel, options?.marketplaceSource);
  }
}

async function loadMarketplaceCatalog(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  source?: string,
): Promise<void> {
  try {
    const marketplace = await loadPluginMarketplace({
      workDir: host.state.appState.workDir,
      source,
    });
    panel.setMarketplace(marketplace.plugins, marketplace.source);
  } catch (error) {
    panel.setMarketplaceError(formatErrorMessage(error));
  }
  host.state.ui.requestRender();
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
      onSelect: (selection) => {
        // Every MCP action re-mounts a picker, so let the handler do the
        // mounting — pre-restoring the editor here would flash on toggle.
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
    host.showStatus(`${enabled ? 'Enabled' : 'Disabled'} ${id}. Run /reload or /new to apply.${mcpHint}`);
  }
  const inlineMcpHint = mcpHint.length > 0 ? ' · MCP servers disabled' : '';
  return `${pluginInlineChangeHint()}${inlineMcpHint}`;
}

async function handlePluginsPanelSelection(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  selection: PluginsPanelSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'toggle': {
      const hint = await applyPluginEnabled(host, selection.id, selection.enabled, false);
      await showPluginsPicker(host, {
        initialTab: 'installed',
        selectedId: selection.id,
        pluginHint: { id: selection.id, text: hint },
      });
      return;
    }
    case 'remove':
      if (!(await confirmRemovePlugin(host, selection.id))) {
        host.showStatus(`Remove cancelled: ${selection.id}.`);
        await showPluginsPicker(host, { initialTab: 'installed', selectedId: selection.id });
        return;
      }
      await removePlugin(host, selection.id);
      await showPluginsPicker(host, { initialTab: 'installed' });
      return;
    case 'mcp':
      await showPluginMcpPicker(host, selection.id);
      return;
    case 'details':
      host.restoreEditor();
      await renderPluginInfo(host, selection.id);
      return;
    case 'reload':
      await reloadPlugins(host);
      await showPluginsPicker(host, { initialTab: 'installed' });
      return;
    case 'install': {
      panel.setInstalling(selection.entry.displayName);
      host.state.ui.requestRender();
      try {
        await installPluginFromSource(host, selection.entry.source);
      } catch (error) {
        panel.clearInstalling();
        host.state.ui.requestRender();
        host.showError(`Failed to install ${selection.entry.displayName}: ${formatErrorMessage(error)}`);
        return;
      }
      // Close the panel after installing so the success notice and the
      // "/reload or /new" / post-install tip are visible in the transcript.
      host.restoreEditor();
      return;
    }
    case 'install-source': {
      panel.setInstalling(truncateForStatus(selection.source));
      host.state.ui.requestRender();
      try {
        await installPluginFromSource(host, selection.source);
      } catch (error) {
        panel.clearInstalling();
        host.state.ui.requestRender();
        host.showError(`Failed to install from ${truncateForStatus(selection.source)}: ${formatErrorMessage(error)}`);
        return;
      }
      host.restoreEditor();
      return;
    }
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

async function removePlugin(host: SlashCommandHost, id: string): Promise<void> {
  await host.requireSession().removePlugin(id);
  host.showStatus(`Removed ${id}.`);
  host.showStatus(PLUGIN_RELOAD_HINT, 'warning');
}

async function renderPluginsList(
  host: SlashCommandHost,
  plugins?: readonly PluginSummary[],
): Promise<void> {
  const currentPlugins = plugins ?? (await host.requireSession().listPlugins());
  const title = ` Plugins (${currentPlugins.length}) `;
  const panel = new UsagePanelComponent(
    () => buildPluginsListLines({ plugins: currentPlugins }),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function renderPluginInfo(host: SlashCommandHost, id: string): Promise<void> {
  const info = await host.requireSession().getPluginInfo(id);
  const panel = new UsagePanelComponent(
    () => buildPluginsInfoLines({ info }),
    'primary',
    ` ${info.id} `,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function installPluginFromSource(
  host: SlashCommandHost,
  source: string,
): Promise<void> {
  const session = host.requireSession();
  const beforeList = await session.listPlugins();
  const summary = await session.installPlugin(
    resolvePluginInstallSource(source, host.state.appState.workDir),
  );
  showPluginInstallResult(host, beforeList, summary);
}

const PLUGIN_RELOAD_HINT = 'Run /new or /reload to apply plugin changes.';

function showPluginInstallResult(
  host: SlashCommandHost,
  beforeList: readonly PluginSummary[],
  summary: PluginSummary,
): void {
  const previous = beforeList.find((entry) => entry.id === summary.id);
  const serverWord = summary.mcpServerCount === 1 ? 'server' : 'servers';
  const mcpHint =
    summary.mcpServerCount > 0
      ? ` Declares ${summary.mcpServerCount} MCP ${serverWord}; enabled by default and configurable from /plugins.`
      : '';
  const action = describeInstallAction(previous, summary);
  host.showStatus(`${action} (${summary.id}).${mcpHint}`);
  host.showStatus(PLUGIN_RELOAD_HINT, 'warning');
}

function describeInstallAction(
  previous: PluginSummary | undefined,
  next: PluginSummary,
): string {
  const sourceLabel = formatPluginSourceLabel(next);
  const versionFromTo = (prev?: string, cur?: string): string => {
    if (prev === undefined || prev === cur) return cur === undefined ? '' : ` ${cur}`;
    return ` ${prev} → ${cur ?? '-'}`;
  };
  if (previous === undefined) {
    return `Installed ${next.displayName}${versionFromTo(undefined, next.version)} ${sourcePhrase(sourceLabel)}`;
  }
  if (sourceIdentity(previous) !== sourceIdentity(next)) {
    const prevSourceLabel = formatPluginSourceLabel(previous);
    return `Migrated ${next.displayName}: ${prevSourceLabel} → ${sourceLabel}${versionFromTo(previous.version, next.version)}`;
  }
  return `Updated ${next.displayName}${versionFromTo(previous.version, next.version)} ${sourcePhrase(sourceLabel)}`;
}

// formatPluginSourceLabel already prefixes zip-url hosts with "via", so adding
// "from" would read as "from via <host>". Only prepend "from" otherwise.
function sourcePhrase(sourceLabel: string): string {
  return sourceLabel.startsWith('via ') ? sourceLabel : `from ${sourceLabel}`;
}

function sourceIdentity(plugin: PluginSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github:${plugin.github.owner}/${plugin.github.repo}`;
  }
  return plugin.source;
}

function truncateForStatus(input: string): string {
  const max = 80;
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
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
  return 'run /reload or /new to apply';
}
