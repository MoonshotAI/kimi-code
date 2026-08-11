import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  log,
  type CapabilityStatus,
  type PluginInfo,
  type PluginSummary,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';
import { Markdown, Spacer } from '@moonshot-ai/pi-tui';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import {
  PluginInstallTrustConfirmComponent,
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsPanelComponent,
  type PluginInstallTrustConfirmResult,
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
import { createMarkdownTheme } from '../theme/pi-tui-theme';
import { formatErrorMessage } from '../utils/event-payload';
import {
  formatPluginSourceLabel,
  isOfficialPluginInstall,
  isOfficialPluginSource,
} from '../utils/plugin-source-label';
import { KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV, QUOTA_CONSUMING_PLUGIN_IDS } from '#/constant/app';
import { loadPluginMarketplace, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';
import { openUrl } from '#/utils/open-url';
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

/** The plugin-management surface `/plugins` operates on. */
type PluginApi = Pick<
  Session,
  | 'listPlugins'
  | 'installPlugin'
  | 'setPluginEnabled'
  | 'setPluginMcpServerEnabled'
  | 'removePlugin'
  | 'reloadPlugins'
  | 'getPluginInfo'
>;

/**
 * Resolve the plugin-management API. On the v2 engine plugin state is
 * app-global, so a session-less startup still gets a working `/plugins`
 * through the harness's global facade; on v1 (and once a session exists) the
 * session's own API is used.
 */
async function resolvePluginApi(host: SlashCommandHost): Promise<PluginApi> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    throw new Error(NO_ACTIVE_SESSION_MESSAGE);
  }
  return {
    listPlugins: () => host.harness.listPlugins(),
    installPlugin: (source) => host.harness.installPlugin(source),
    setPluginEnabled: (id, enabled) => host.harness.setPluginEnabled(id, enabled),
    setPluginMcpServerEnabled: (id, server, enabled) =>
      host.harness.setPluginMcpServerEnabled(id, server, enabled),
    removePlugin: (id) => host.harness.removePlugin(id),
    reloadPlugins: () => host.harness.reloadPlugins(),
    getPluginInfo: (id) => host.harness.getPluginInfo(id),
  };
}

export async function handlePluginsCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  const sub = args[0];
  const rest = args.slice(1);
  const session = await resolvePluginApi(host);

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
      if (!(await confirmInstallTrust(host, source, isOfficialPluginSource(source)))) {
        host.showStatus('Install cancelled.');
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
        // Curated tab (entry.tier !== 'official'). Open there when a custom
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

/**
 * Resolve the capability API. Like plugin state, capability state is
 * app-global on the v2 engine, so a session-less startup still gets
 * readiness and installs through the harness's global facade; with a live
 * session the session's own API is used (v1 included, where the capability
 * surface then reports itself unavailable).
 */
type CapabilityApi = Pick<Session, 'listCapabilities' | 'getCapability' | 'installCapability'>;

async function resolveCapabilityApi(host: SlashCommandHost): Promise<CapabilityApi> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    throw new Error(NO_ACTIVE_SESSION_MESSAGE);
  }
  return host.harness;
}

function logCapabilityStatus(capability: CapabilityStatus, installed?: boolean): void {
  const payload = {
    capabilityId: capability.id,
    pluginId: capability.pluginId,
    installed,
    supported: capability.supported,
    state: capability.state,
    version: capability.version,
    install: capability.install,
    steps: capability.steps,
  };
  const hasStepIssues = capability.steps.some((step) => step.state !== 'ok');
  if (
    capability.install.error !== undefined ||
    (installed !== false && hasStepIssues)
  ) {
    log.warn('capability needs attention', payload);
  } else {
    log.info('capability status', payload);
  }
}

async function showPluginsPicker(
  host: SlashCommandHost,
  options?: ShowPluginsPickerOptions,
): Promise<void> {
  let plugins: readonly PluginSummary[];
  try {
    plugins = await (await resolvePluginApi(host)).listPlugins();
  } catch (error) {
    host.showError(`Failed to load plugins: ${formatErrorMessage(error)}`);
    return;
  }

  let capabilities: readonly CapabilityStatus[] = [];
  if (host.engineV2) {
    try {
      capabilities = await (await resolveCapabilityApi(host)).listCapabilities();
    } catch (error) {
      log.warn('capability status unavailable', { error });
    }
  }

  const installedIds = new Set(plugins.map((plugin) => plugin.id));
  for (const capability of capabilities) {
    logCapabilityStatus(capability, installedIds.has(capability.pluginId ?? capability.id));
  }

  const panel = new PluginsPanelComponent({
    installed: plugins,
    installedIds,
    capabilities,
    catalogIsDefault: isDefaultMarketplaceCatalog(options?.marketplaceSource),
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
    // Every tab except Custom needs the catalog: Official/Curated list it,
    // and Installed uses it to show update badges. The Installed/Custom tabs
    // keep working even when the marketplace is unreachable (badges simply stay
    // hidden until data arrives).
    onRequestMarketplace: () => {
      void loadMarketplaceCatalog(host, panel, options?.marketplaceSource, capabilities);
    },
  });
  host.mountEditorReplacement(panel);
  // Kick off the catalog fetch for any tab that needs it: Installed uses it for
  // update badges, Official/Curated list it. Custom never reads the catalog,
  // so skip the fetch there. Done here (after `panel` is initialized) rather
  // than inside the component constructor, because the callback above closes
  // over `panel`.
  if (options?.initialTab !== 'custom') {
    panel.setMarketplaceLoading();
    void loadMarketplaceCatalog(host, panel, options?.marketplaceSource, capabilities);
  }
}

/**
 * Adapt a capability from the engine's registry into a catalog row. The
 * engine is the single source of truth for what the built-in capabilities
 * are — the CLI only renders them. The `capability:<id>` source marker
 * routes installs through the capability flow (never a plain plugin
 * install), so the row needs no real URL.
 */
function capabilityMarketplaceEntry(capability: CapabilityStatus): PluginMarketplaceEntry {
  return {
    id: capability.id,
    displayName: capability.displayName,
    description: capability.description,
    tier: 'official',
    source: `capability:${capability.id}`,
    builtIn: true,
  };
}

/**
 * Injection is part of the DEFAULT catalog experience only: any explicit
 * replacement (the slash-command source or a user-set env override) opts out
 * wholesale. The dev marketplace server started by scripts/dev.mjs serves
 * this repo's own catalog and marks itself, so it still counts as default.
 */
function isDefaultMarketplaceCatalog(
  source: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source !== undefined) return false;
  if (env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV] === undefined) return true;
  return env['KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER'] === '1';
}

async function loadMarketplaceCatalog(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  source: string | undefined,
  capabilities: readonly CapabilityStatus[],
): Promise<void> {
  try {
    const marketplace = await loadPluginMarketplace({
      workDir: host.state.appState.workDir,
      source,
      builtInEntries:
        host.engineV2 && isDefaultMarketplaceCatalog(source)
          ? capabilities.map(capabilityMarketplaceEntry)
          : undefined,
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
    info = await (await resolvePluginApi(host)).getPluginInfo(id);
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
    displayName = (await (await resolvePluginApi(host)).getPluginInfo(id)).displayName;
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

async function confirmInstallTrust(
  host: SlashCommandHost,
  label: string,
  official: boolean,
): Promise<boolean> {
  // Kimi-built official plugins are trusted implicitly; anything else requires
  // the user to explicitly opt in via the trust prompt.
  if (official) return true;
  return new Promise((resolveConfirmed) => {
    host.mountEditorReplacement(
      new PluginInstallTrustConfirmComponent({
        label,
        onDone: (result: PluginInstallTrustConfirmResult) => {
          host.restoreEditor();
          resolveConfirmed(result.kind === 'confirm');
        },
      }),
    );
  });
}

const CAPABILITY_POLL_INTERVAL_MS = 700;
const CAPABILITY_POLL_ATTEMPTS = 260; // ~3 minutes of runtime setup budget

/** Client-injected v2 entries install their runtime and plugin together.
 * Trust keys on the parser-proof `builtIn` flag — the `capability:<id>`
 * source string stays purely diagnostic. */
function isCapabilityEntry(host: SlashCommandHost, entry: PluginMarketplaceEntry): boolean {
  return host.engineV2 && entry.builtIn === true;
}

/**
 * Closed-set plugin id check for the post-remove note. What must not happen
 * is answering membership by running `listCapabilities()`, which fires every
 * entry's detector (seconds of probes) just to print one hint line.
 */
function isCapabilityPluginId(host: SlashCommandHost, id: string): boolean {
  return (
    host.engineV2 &&
    (id === 'kimi-cu' || id === 'kimi-cu-win' || id === 'kimi-webbridge')
  );
}

/** Poll a background capability install until it settles (or we run out of budget). */
async function pollCapabilityInstall(
  host: SlashCommandHost,
  id: string,
): Promise<CapabilityStatus | undefined> {
  const api = await resolveCapabilityApi(host);
  let previousProgress = '';
  for (let attempt = 0; attempt < CAPABILITY_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, CAPABILITY_POLL_INTERVAL_MS);
    });
    const status = await api.getCapability(id);
    if (!status.install.running) return status;
    const progress = `${status.install.step ?? ''}:${status.install.percent ?? ''}`;
    if (progress !== previousProgress) {
      previousProgress = progress;
      log.info('capability install progress', {
        capabilityId: id,
        step: status.install.step,
        percent: status.install.percent,
      });
    }
  }
  return undefined;
}

export const __pluginsCommandInternals = {
  isCapabilityEntry,
  installCapabilityFromPanel,
  isDefaultMarketplaceCatalog,
  pollCapabilityInstall,
  removePlugin,
};

async function installCapabilityFromPanel(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  entry: PluginMarketplaceEntry,
): Promise<void> {
  const label = entry.displayName;
  // Capability entries are official by construction; the trust prompt is
  // reserved for unreviewed third-party plugins.
  panel.setInstalling(truncateForStatus(label));
  host.state.ui.requestRender();
  const api = await resolveCapabilityApi(host);
  log.info('capability install requested', { capabilityId: entry.id });
  try {
    // An install already running (started from another panel or client) is
    // followed, not restarted — the service rejects duplicate starts even
    // though the original is healthy.
    const alreadyRunning = await api
      .getCapability(entry.id)
      .then((status) => status.install.running, () => false);
    if (!alreadyRunning) {
      await api.installCapability(entry.id);
    } else {
      log.info('following running capability install', { capabilityId: entry.id });
    }
  } catch (error) {
    log.warn('capability install failed to start', { capabilityId: entry.id, error });
    panel.clearInstalling();
    host.state.ui.requestRender();
    host.showError(`Failed to install ${label}: ${formatErrorMessage(error)}`);
    host.restoreEditor();
    return;
  }
  let result: CapabilityStatus | undefined;
  try {
    result = await pollCapabilityInstall(host, entry.id);
  } catch (error) {
    log.warn('capability install polling failed', { capabilityId: entry.id, error });
    result = undefined;
  }
  panel.clearInstalling();
  // Close the panel so the result lines land in the transcript, matching the
  // plain plugin install flow.
  host.restoreEditor();
  if (result === undefined) {
    host.showStatus(`${label} installation is still running in the background.`);
    return;
  }
  logCapabilityStatus(result);
  if (result.install.error !== undefined) {
    host.showError(`${label} installation failed: ${result.install.error}`);
    host.showStatus('Fix the reported error, then install again from /plugins.', 'warning');
    return;
  }
  if (result.state !== 'ready') {
    const permissionsRequired =
      entry.id === 'kimi-cu' &&
      result.steps.some((step) => step.id === 'permissions' && step.state !== 'ok');
    if (permissionsRequired) {
      host.showStatus(
        'Grant Accessibility and Screen Recording in System Settings → Privacy & Security.',
        'warning',
      );
    } else {
      host.showError(
        `${label} installation did not complete. Check the logs and install again from /plugins.`,
      );
    }
    host.showStatus(PLUGIN_RELOAD_HINT, 'warning');
    return;
  }
  if (entry.id === 'kimi-webbridge') {
    host.showNotice(`${label} is installed.`);
    host.state.transcriptContainer.addChild(new Spacer(1));
    host.state.transcriptContainer.addChild(
      new Markdown(WEBBRIDGE_POST_INSTALL_MARKDOWN, 2, 0, createMarkdownTheme()),
    );
    host.state.ui.requestRender();
    return;
  }
  host.showStatus(`${label} is installed.`);
  host.showStatus(PLUGIN_RELOAD_HINT, 'warning');
}

async function installFromPanel(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  source: string,
  label: string,
  official: boolean,
): Promise<void> {
  if (!(await confirmInstallTrust(host, label, official))) {
    host.showStatus(`Install cancelled: ${label}.`);
    host.restoreEditor();
    return;
  }
  // Official installs keep the panel mounted and show the inline installing
  // state; third-party installs pass through a trust prompt that replaces the
  // panel, so fall back to a transcript status for those.
  if (official) {
    panel.setInstalling(truncateForStatus(label));
  } else {
    host.showStatus(`Installing or updating ${label} from marketplace...`);
  }
  host.state.ui.requestRender();
  try {
    await installPluginFromSource(host, source);
  } catch (error) {
    if (official) {
      panel.clearInstalling();
      host.state.ui.requestRender();
    } else {
      // The trust prompt replaced the panel; re-mount it so the user can retry
      // instead of being dropped back at the editor.
      host.mountEditorReplacement(panel);
    }
    host.showError(`Failed to install ${label}: ${formatErrorMessage(error)}`);
    return;
  }
  // Close the panel after installing so the result status and the
  // "/reload or /new" tip are visible in the transcript.
  host.restoreEditor();
}

async function applyPluginEnabled(
  host: SlashCommandHost,
  id: string,
  enabled: boolean,
  showStatus = true,
): Promise<string> {
  const session = await resolvePluginApi(host);
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
    case 'install':
      if (isCapabilityEntry(host, selection.entry)) {
        await installCapabilityFromPanel(host, panel, selection.entry);
        return;
      }
      await installFromPanel(
        host,
        panel,
        selection.entry.source,
        selection.entry.displayName,
        isOfficialPluginSource(selection.entry.source),
      );
      return;
    case 'install-source':
      await installFromPanel(
        host,
        panel,
        selection.source,
        selection.source,
        isOfficialPluginSource(selection.source),
      );
      return;
    case 'open-url':
      host.restoreEditor();
      openUrl(selection.url);
      host.showStatus(`Opening the ${selection.label} page in your browser…`, 'success');
      host.showStatus(`If it did not open, visit ${selection.url}`);
      return;
  }
}

async function handlePluginMcpSelection(
  host: SlashCommandHost,
  selection: PluginMcpSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'toggle':
      await (
        await resolvePluginApi(host)
      ).setPluginMcpServerEnabled(selection.pluginId, selection.server, selection.enabled);
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
  await (await resolvePluginApi(host)).removePlugin(id);
  host.showStatus(`Removed ${id}.`);
  if (isCapabilityPluginId(host, id)) {
    host.showStatus(
      'Note: the runtime binaries were left untouched, but Kimi Code plugin wiring is disabled for new sessions. Restart Kimi Code before reinstalling from the Official tab.',
    );
    return;
  }
  host.showStatus(PLUGIN_RELOAD_HINT, 'warning');
}

async function renderPluginsList(
  host: SlashCommandHost,
  plugins?: readonly PluginSummary[],
): Promise<void> {
  const currentPlugins = plugins ?? (await (await resolvePluginApi(host)).listPlugins());
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
  const info = await (await resolvePluginApi(host)).getPluginInfo(id);
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
  const session = await resolvePluginApi(host);
  const beforeList = await session.listPlugins();
  const summary = await session.installPlugin(
    resolvePluginInstallSource(source, host.state.appState.workDir),
  );
  showPluginInstallResult(host, beforeList, summary);
}

const PLUGIN_RELOAD_HINT = 'Run /new or /reload to apply plugin changes.';

const WEBBRIDGE_POST_INSTALL_MARKDOWN = [
  '*Two steps left to use Kimi WebBridge:*',
  '1. Install the browser extension',
  '',
  '   - [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)',
  '   - [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg)',
  '   - [Manual installation guide](https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html#install-the-browser-extension)',
  '',
  '2. Run `/reload` or `/new` to apply it.',
].join('\n');

const PLUGIN_QUOTA_NOTE = 'Note: This plugin consumes your quota.';

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
  // Gate on provenance, not just the id: a local/GitHub fork whose manifest
  // reuses a billed plugin's id is not the official quota-consuming build.
  if (QUOTA_CONSUMING_PLUGIN_IDS.includes(summary.id) && isOfficialPluginInstall(summary)) {
    host.showStatus(PLUGIN_QUOTA_NOTE, 'warning');
  }
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
  const summary = await (await resolvePluginApi(host)).reloadPlugins();
  const line = `Reload: +${summary.added.length} -${summary.removed.length}` +
    (summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : '');
  host.showStatus(line);
  // Rebuild the TUI's plugin slash-command list from the reloaded service so
  // newly added/enabled commands resolve in this session-less UI right away.
  await host.refreshPluginCommands(host.session);
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
