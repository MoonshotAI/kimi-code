import {
  applyCustomRegistryEntries,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type Catalog,
  type ProviderConfig,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeUserAgent } from '#/cli/version';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import { refreshKimiRegion } from '#/utils/region';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '../components/dialogs/custom-registry-import';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { effectiveModelForHost, performModelSwitch } from './config';
import {
  promptApiKey,
  promptBaseUrl,
  promptCatalogProviderSelection,
  promptKeyName,
  promptProxyUrl,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

export async function handleProviderCommand(host: SlashCommandHost): Promise<void> {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
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
    onAddKey: (providerId) => {
      void handleProviderKeyAdd(host, providerId).catch((error: unknown) => {
        host.showError(`Add API key failed: ${formatErrorMessage(error)}`);
      });
    },
    onRemoveKey: (providerId, keyId) => {
      void handleProviderKeyRemove(host, providerId, keyId).catch((error: unknown) => {
        host.showError(`Remove API key failed: ${formatErrorMessage(error)}`);
      });
    },
    onSetActiveKey: (providerId, keyId) => {
      void handleProviderKeySetActive(host, providerId, keyId).catch((error: unknown) => {
        host.showError(`Set active API key failed: ${formatErrorMessage(error)}`);
      });
    },
    onSetProxyUrl: (providerId) => {
      void handleProviderProxyUrl(host, providerId).catch((error: unknown) => {
        host.showError(`Set proxy URL failed: ${formatErrorMessage(error)}`);
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
    // Drop the process-wide region cache with the credential: derived
    // endpoints (updates, marketplace, site links, telemetry) must fall back
    // to the marker/default profile, not the logged-out region.
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

// ---------------------------------------------------------------------------
// API Key management for providers
// ---------------------------------------------------------------------------

async function handleProviderKeyAdd(host: SlashCommandHost, providerId: string): Promise<void> {
  const provider = host.state.appState.availableProviders[providerId];
  if (!provider) {
    host.showError(`Provider ${providerId} not found`);
    return;
  }

  // Prompt for key name
  const name = await promptKeyName(host);
  if (name === undefined) {
    reopenProviderManager(host);
    return;
  }

  // Prompt for API key value
  const apiKey = await promptApiKey(host, `API key for ${providerId}/${name}`);
  if (apiKey === undefined) {
    reopenProviderManager(host);
    return;
  }

  // Generate a unique key ID
  const keyId = generateKeyId(provider);

  const config = await host.harness.getConfig();
  const providers = { ...config.providers };
  const existingProvider = providers[providerId];
  if (!existingProvider) {
    host.showError(`Provider ${providerId} not found in config`);
    return;
  }

  const apiKeys = existingProvider.apiKeys ? { ...existingProvider.apiKeys } : {};
  apiKeys[keyId] = { key: apiKey, name };

  providers[providerId] = {
    ...existingProvider,
    apiKeys,
    activeApiKeyId: existingProvider.activeApiKeyId ?? keyId, // First key becomes active
  };

  // Use replaceConfigSections if available (v2) to ensure full replacement,
  // otherwise fall back to setConfig (v1 deep merge).
  if (host.harness.supportsAtomicSectionReplace()) {
    await host.harness.replaceConfigSections({ providers });
  } else {
    await host.harness.setConfig({ providers });
  }
  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(`Added API key "${name}" to ${providerId}`);
  reopenProviderManager(host);
}

async function handleProviderKeyRemove(host: SlashCommandHost, providerId: string, keyId: string): Promise<void> {
  const config = await host.harness.getConfig();
  const providers = { ...config.providers };
  const provider = providers[providerId];
  if (!provider || !provider.apiKeys || !provider.apiKeys[keyId]) {
    host.showError(`API key not found`);
    return;
  }

  const apiKeys = { ...provider.apiKeys };
  const keyEntry = apiKeys[keyId];
  if (!keyEntry) {
    host.showError(`API key not found`);
    return;
  }
  const keyName = keyEntry.name;
  delete apiKeys[keyId];

  let activeApiKeyId = provider.activeApiKeyId;
  if (activeApiKeyId === keyId) {
    // Select another key as active if available
    const remainingKeys = Object.keys(apiKeys);
    activeApiKeyId = remainingKeys.length > 0 ? remainingKeys[0] : undefined;
  }

  if (Object.keys(apiKeys).length === 0) {
    // No keys left, remove the apiKeys field entirely
    const { apiKeys: _, activeApiKeyId: __, ...rest } = provider;
    providers[providerId] = rest;
  } else {
    providers[providerId] = { ...provider, apiKeys, activeApiKeyId };
  }

  // Use replaceConfigSections if available (v2) to ensure full replacement,
  // otherwise fall back to setConfig (v1 deep merge).
  if (host.harness.supportsAtomicSectionReplace()) {
    await host.harness.replaceConfigSections({ providers });
  } else {
    await host.harness.setConfig({ providers });
  }
  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(`Removed API key "${keyName}" from ${providerId}`);
  reopenProviderManager(host);
}

async function handleProviderKeySetActive(host: SlashCommandHost, providerId: string, keyId: string): Promise<void> {
  const config = await host.harness.getConfig();
  const providers = { ...config.providers };
  const provider = providers[providerId];
  if (!provider || !provider.apiKeys || !provider.apiKeys[keyId]) {
    host.showError(`API key not found`);
    return;
  }

  providers[providerId] = { ...provider, activeApiKeyId: keyId };
  // Use replaceConfigSections if available (v2) to ensure full replacement,
  // otherwise fall back to setConfig (v1 deep merge).
  if (host.harness.supportsAtomicSectionReplace()) {
    await host.harness.replaceConfigSections({ providers });
  } else {
    await host.harness.setConfig({ providers });
  }
  await host.authFlow.refreshConfigAfterLogin();
  const keyName = provider.apiKeys[keyId].name;
  host.showStatus(`Set active API key to "${keyName}" for ${providerId}`);
  reopenProviderManager(host);
}

function generateKeyId(provider: ProviderConfig): string {
  const existingKeys = provider.apiKeys ? Object.keys(provider.apiKeys) : [];
  let counter = 1;
  let keyId = `key${counter}`;
  while (existingKeys.includes(keyId)) {
    counter++;
    keyId = `key${counter}`;
  }
  return keyId;
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

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
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
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false,    // will be resolved by the model selector
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

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  // The v1 runtime may carry the synthesized `__secondary__` derived entry —
  // never selectable in a picker.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };
  delete mergedModels[SECONDARY_DERIVED_MODEL_ALIAS];

  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId}/`)),
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onSessionOnlySelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void performModelSwitch(host, alias, thinking, false);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

export async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  // Resolve efforts the same way the /model path does (effectiveModelForHost
  // applies overrides and the protocol-profile inference): catalog entries for
  // e.g. Anthropic models declare no support_efforts on the alias, and without
  // the inference an above-default pick would slip through as a persisted effort.
  const model = host.state.appState.availableModels[alias];
  const thinking = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model),
  );
  if (host.session === undefined && host.engineV2) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // pick lands on the new session instead of racing its assembly (same
    // coordination as the /model path).
    await host.waitForLazyCreation();
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking,
  });
  // Whether activation made the engine emit model_switch (it reached a live
  // session AND changed the bound alias — both engines track only an actual
  // change). Recorded at activation time rather than snapshotted at entry: a
  // lazy session can come live while the config writes above are pending; a
  // session created BY activation (v1) or a same-alias rebind does not count
  // — both bind the model without an engine event.
  let engineTrackedSwitch = await host.authFlow.refreshConfigAfterLogin();
  // refreshConfigAfterLogin reactivates from the persisted config, so a pick
  // the gate keeps session-only never reaches the runtime — apply it after
  // the refresh, or the persisted value would clobber it.
  if (thinking.effort === undefined && effort !== 'off' && effort !== 'on') {
    engineTrackedSwitch =
      (await host.authFlow.activateModelAfterLogin(alias, effort)) || engineTrackedSwitch;
  }
  // When the engine never emitted (no live session, or the alias was already
  // bound), the TUI stays the sole producer for the pick.
  if (!engineTrackedSwitch) {
    host.track('model_switch', { model: alias });
  }
  host.showStatus(`Default model set to ${alias} with thinking ${effort}.`);
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url: value.url,
    apiKey: value.apiKey,
  };

  let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  try {
    entries = await fetchCustomRegistry(source, { userAgent: createKimiCodeUserAgent() });
  } catch (error) {
    host.showError(`Failed to import registry: ${formatErrorMessage(error)}`);
    return false;
  }

  const addedProviderIds = Object.values(entries).map((entry) => entry.id);
  try {
    const config = await host.harness.getConfig();
    applyCustomRegistryEntries(
      config as unknown as ManagedKimiConfigShape,
      entries,
      source,
    );
    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to apply registry: ${formatErrorMessage(error)}`);
    return false;
  }

  const count = addedProviderIds.length;
  if (count === 0) {
    host.showStatus('Registry contained no providers.');
    return false;
  }
  host.showStatus(
    count === 1
      ? 'Imported 1 provider from registry.'
      : `Imported ${String(count)} providers from registry.`,
    'success',
  );

  // Offer the model selector so the user can pick a default, just like the
  // catalog (known-provider) flow. Copy without the v1-synthesized
  // `__secondary__` derived entry — never selectable in a picker.
  const stateModels = { ...(await host.harness.getConfig().then((c) => c.models ?? {})) };
  delete stateModels[SECONDARY_DERIVED_MODEL_ALIAS];
  const firstNewAlias = Object.keys(stateModels).find((a) =>
    addedProviderIds.some((pid) => a.startsWith(`${pid}/`)),
  );
  const firstNewProvider = firstNewAlias
    ? stateModels[firstNewAlias]?.provider
    : addedProviderIds[0];
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstNewAlias,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: firstNewProvider,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onSessionOnlySelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void performModelSwitch(host, alias, thinking, false);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
  return true;
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<{ readonly url: string; readonly apiKey: string } | undefined> {
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

async function handleProviderProxyUrl(host: SlashCommandHost, providerId: string): Promise<void> {
  const provider = host.state.appState.availableProviders[providerId];
  if (!provider) {
    host.showError(`Provider ${providerId} not found`);
    return;
  }

  const proxyUrl = await promptProxyUrl(host, providerId);
  if (proxyUrl === undefined) {
    reopenProviderManager(host);
    return;
  }

  const config = await host.harness.getConfig();
  const providers = { ...config.providers };
  const existingProvider = providers[providerId];
  if (!existingProvider) {
    host.showError(`Provider ${providerId} not found in config`);
    return;
  }

  providers[providerId] = {
    ...existingProvider,
    proxyUrl,
  };

  // Use replaceConfigSections if available (v2) to ensure full replacement,
  // otherwise fall back to setConfig (v1 deep merge).
  if (host.harness.supportsAtomicSectionReplace()) {
    await host.harness.replaceConfigSections({ providers });
  } else {
    await host.harness.setConfig({ providers });
  }
  await host.authFlow.refreshConfigAfterLogin();
  const display = proxyUrl ? proxyUrl : 'disabled';
  host.showStatus(`Proxy for ${providerId} set to ${display}`);
  reopenProviderManager(host);
}

// ---------------------------------------------------------------------------
// /refresh-catalog command
// ---------------------------------------------------------------------------

/**
 * On-demand OpenAI-compatible catalog refresh. Fetches each matching provider's
 * `/models` endpoint, preserves curated `maxContextSize`, and enriches names from
 * models.dev. Pass `providerId` to scope the refresh to a single provider.
 */
export async function handleRefreshCatalogCommand(
  host: SlashCommandHost,
  providerId: string | undefined,
): Promise<void> {
  if (providerId !== undefined && host.state.appState.availableProviders[providerId] === undefined) {
    host.showError(`Provider ${providerId} not found`);
    return;
  }

  const spinner = host.showProgressSpinner('Refreshing OpenAI-compatible catalogs…');
  let result: Awaited<ReturnType<typeof host.authFlow.refreshCatalogModels>>;
  try {
    result = await host.authFlow.refreshCatalogModels(providerId);
  } catch (error) {
    spinner.stop({ ok: false, label: 'Catalog refresh failed.' });
    host.showError(`Catalog refresh failed: ${formatErrorMessage(error)}`);
    return;
  }

  if (result.failed.length > 0) {
    const reasons = result.failed
      .map((f) => `${f.provider}: ${f.reason}`)
      .join('; ');
    spinner.stop({ ok: false, label: 'Some catalogs failed to refresh.' });
    host.showError(`Catalog refresh partial: ${reasons}`);
    return;
  }

  const changed = result.changed.length;
  const label =
    changed === 0
      ? 'Catalogs up to date.'
      : `Refreshed ${String(changed)} provider catalog${changed === 1 ? '' : 's'}.`;
  spinner.stop({ ok: true, label });
  host.showStatus(label, 'success');
}
