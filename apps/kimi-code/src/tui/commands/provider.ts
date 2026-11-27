import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  type Catalog,
  type ModelAlias,
  type RefreshProviderModelsResponse,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeUserAgent } from '#/cli/host-identity';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import { refreshKimiRegion } from '#/utils/region';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
  type CustomRegistryImportValue,
} from '../components/dialogs/custom-registry-import';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DOCK_MODEL_SELECTOR_ROWS } from '../constant/rendering';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { effectiveModelForHost } from '../utils/model-switch';
import {
  promptApiKey,
  promptBaseUrl,
  promptCatalogProviderSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

export async function handleProviderCommand(host: SlashCommandHost, rawArgs = ''): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  if (args[0] === 'refresh') {
    if (args.length > 2) {
      host.showError('Usage: /provider [refresh [providerId]]');
      return;
    }
    await handleProviderRefresh(host, args[1]);
    return;
  }
  if (args.length > 0) {
    host.showError('Usage: /provider [refresh [providerId]]');
    return;
  }
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

async function handleProviderRefresh(
  host: SlashCommandHost,
  providerId: string | undefined,
): Promise<void> {
  const spinner = host.showProgressSpinner(
    providerId === undefined
      ? 'Refreshing models for all providers…'
      : `Refreshing models for ${providerId}…`,
  );
  let result: RefreshProviderModelsResponse;
  try {
    result = await host.authFlow.refreshProviderModels(
      providerId === undefined ? undefined : { providerId },
    );
  } catch (error) {
    spinner.stop({ ok: false, label: 'Refresh failed.' });
    host.showError(`Failed to refresh models: ${formatErrorMessage(error)}`);
    return;
  }
  spinner.stop({ ok: true, label: 'Refresh finished.' });
  reportProviderRefresh(host, result);
  if (result.retired_default !== undefined) {
    await host.modelMigration.retire(result.retired_default);
  }
}

function reportProviderRefresh(
  host: SlashCommandHost,
  result: RefreshProviderModelsResponse,
): void {
  for (const change of result.changed) {
    if (change.added === 0 && change.removed === 0) {
      host.showStatus(`${change.provider_name}: model metadata updated.`);
      continue;
    }
    const parts: string[] = [];
    if (change.added > 0) parts.push(`+${change.added}`);
    if (change.removed > 0) parts.push(`-${change.removed}`);
    const total = change.added + change.removed;
    host.showStatus(
      `${change.provider_name}: ${parts.join(' / ')} model${total === 1 ? '' : 's'}.`,
      change.removed > 0 ? 'warning' : undefined,
    );
  }
  for (const failure of result.failed) {
    host.showStatus(`Skipped refreshing ${failure.provider}: ${failure.reason}`, 'warning');
  }
  if (result.changed.length === 0 && result.failed.length === 0) {
    const count = result.unchanged.length;
    host.showStatus(
      `No model changes (${count} provider${count === 1 ? '' : 's'} up to date).`,
    );
  }
}

function buildProviderManagerOptions(host: SlashCommandHost): ProviderManagerOptions {
  const activeProviderId =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: host.state.appState.availableProviders,
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(`Add provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onDeleteSource: (providerIds) => {
      void handleProviderManagerDeleteSource(host, providerIds).catch((error: unknown) => {
        host.showError(`Remove provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
}

async function handleProviderManagerDeleteSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Failed to delete provider ${providerId}: ${msg}`);
    }
  }
  reopenProviderManager(host);
}

async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
  if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    refreshKimiRegion();
    await host.authFlow.refreshConfigAfterLogout();
    return;
  }

  const activeProvider =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers ?? {},
      availableModels: config.models ?? {},
    });
  }
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await promptProviderAddSource(host);
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }

  if (source === 'known') {
    await handleCatalogProviderAdd(host);
    return;
  }
  const handled = await handleCustomRegistryAddViaDialog(host);
  if (!handled) {
    reopenProviderManager(host);
  }
}

function reopenProviderManager(host: SlashCommandHost): void {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

function promptProviderAddSource(
  host: SlashCommandHost,
): Promise<'known' | 'custom' | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'known', label: 'Known third-party provider' },
        { value: 'custom', label: 'Custom registry (api.json)' },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value === 'known' || value === 'custom' ? value : undefined);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showLoginProgressSpinner(`Fetching catalog from ${DEFAULT_CATALOG_URL}`);
  let catalog: Catalog | undefined;
  try {
    const loaded = await fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
      signal: controller.signal,
      userAgent: createKimiCodeUserAgent(),
    });
    catalog = loaded.catalog;
    spinner.stop({
      ok: true,
      label: loaded.fromBuiltIn
        ? 'Catalog loaded from built-in snapshot (models.dev unreachable).'
        : 'Catalog loaded.',
    });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: 'Aborted.' });
    } else {
      const hint = error instanceof CatalogFetchError ? ` (HTTP ${error.status})` : '';
      spinner.stop({ ok: false, label: 'Failed to load catalog.' });
      host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(`Provider "${providerId}" has no usable models in this catalog.`);
    return;
  }

  let resolution = resolveCatalogImport(entry);
  if (resolution.kind === 'needs-base-url') {
    const entered = await promptBaseUrl(host, entry.name ?? providerId);
    if (entered === undefined) return;
    resolution = resolveCatalogImport(entry, entered);
  }
  if (resolution.kind !== 'ok') {
    if (resolution.kind === 'invalid') {
      if (resolution.reason === 'unknown-explicit-type') {
        host.showError(
          `Provider "${providerId}" declares protocol "${entry.type}" in the catalog, which this client version does not support.`,
        );
      } else if (resolution.reason === 'proprietary-sdk') {
        host.showError(
          `Provider "${providerId}" uses a proprietary SDK this client cannot speak (e.g. Amazon Bedrock or Cohere); it cannot be imported from the catalog.`,
        );
      } else {
        host.showError(
          `Base URL contains an env placeholder or is empty. Enter the resolved URL instead.`,
        );
      }
    }
    return;
  }
  const { wire, baseUrl } = resolution;

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '',
    thinking: false,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: providerId, method: 'catalog' });
  host.showStatus(`Provider added: ${entry.name ?? providerId}`);
  if (resolution.guessed) {
    host.showStatus(
      `Protocol guessed as "openai" for ${providerId} — edit "type" in config.toml if requests fail.`,
    );
  }

  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  mountProviderDefaultModelSelector(
    host,
    stateModels,
    Object.keys(stateModels).find((alias) => alias.startsWith(`${providerId}/`)),
    providerId,
  );
}

export async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  const model = host.state.appState.availableModels[alias];
  const thinking = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model),
  );
  if (host.session === undefined) {
    await host.waitForSessionAssembly();
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking,
  });
  const refreshed = await host.authFlow.refreshConfigAfterLogin(effort);
  const gateOwnsSwitch = refreshed === 'gated';
  let engineTrackedSwitch = refreshed === 'gated' ? true : refreshed;
  if (!gateOwnsSwitch && thinking.effort === undefined && effort !== 'off' && effort !== 'on') {
    engineTrackedSwitch =
      (await host.authFlow.activateModelAfterLogin(alias, effort)) || engineTrackedSwitch;
  }
  if (!engineTrackedSwitch) {
    host.track('model_switch', { model: alias });
  }
  host.showStatus(`Default model set to ${alias} with thinking ${effort}.`);
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  let result: ImportCustomRegistryResult;
  try {
    result = await host.harness.importCustomRegistry({
      url: value.url,
      apiKey: value.apiKey,
      setDefaultWhenUnset: false,
    });
  } catch (error) {
    if (error instanceof RegistryImportError && error.phase === 'empty') {
      host.showStatus('Registry contained no providers.');
      return false;
    }
    const phase =
      error instanceof RegistryImportError && error.phase === 'fetch' ? 'import' : 'apply';
    host.showError(`Failed to ${phase} registry: ${formatErrorMessage(error)}`);
    if (
      value.apiKey === undefined &&
      error instanceof RegistryImportError &&
      (error.status === 401 || error.status === 403)
    ) {
      host.showStatus('This registry requires authentication — paste its Bearer token.', 'warning');
    }
    return false;
  }
  try {
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to apply registry: ${formatErrorMessage(error)}`);
    return false;
  }
  const addedProviderIds = result.providers.map((provider) => provider.id);
  const count = addedProviderIds.length;
  host.showStatus(
    count === 1
      ? 'Imported 1 provider from registry.'
      : `Imported ${String(count)} providers from registry.`,
    'success',
  );
  for (const [id, envName] of Object.entries(result.credentialEnv)) {
    host.showStatus(
      `provider "${id}" declares credential env var "${envName}" — set api_key_env in config.toml to use it`,
    );
  }

  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const firstNewAlias = Object.keys(stateModels).find((a) =>
    addedProviderIds.some((pid) => a.startsWith(`${pid}/`)),
  );
  const firstNewProvider = firstNewAlias
    ? stateModels[firstNewAlias]?.provider
    : addedProviderIds[0];
  mountProviderDefaultModelSelector(host, stateModels, firstNewAlias, firstNewProvider);
  return true;
}

function mountProviderDefaultModelSelector(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  selectedValue: string | undefined,
  initialTabId: string | undefined,
): void {
  const selector = new TabbedModelSelectorComponent({
    models,
    currentValue: host.state.appState.model,
    selectedValue,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId,
    layout:
      host.state.dockContainer === undefined
        ? undefined
        : { maxBodyRows: DOCK_MODEL_SELECTOR_ROWS },
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<CustomRegistryImportValue | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomRegistryImportDialogComponent(
      (result: CustomRegistryImportResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog);
  });
}
