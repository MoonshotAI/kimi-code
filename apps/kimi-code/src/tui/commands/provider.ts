import {
  applyCustomRegistryEntries,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  type Catalog,
  type ModelAlias,
  type ProviderConfig,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '../components/dialogs/custom-registry-import';
import {
  OpenAIProviderImportDialogComponent,
  type OpenAIProviderImportResult,
  type OpenAIProviderImportValue,
} from '../components/dialogs/openai-provider-import';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import {
  promptApiKey,
  promptCatalogProviderSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

const DEFAULT_OPENAI_CONTEXT_TOKENS = 131_072;
const OPENAI_THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const DEFAULT_OPENAI_THINKING_EFFORT = 'medium';

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
    onEditProvider: (providerId) => {
      void handleOpenAIProviderAddOrEditViaDialog(host, providerId).catch((error: unknown) => {
        host.showError(`Edit provider failed: ${formatErrorMessage(error)}`);
        reopenProviderManager(host);
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
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
    return;
  }

  const activeProvider =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
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

  if (source === 'openai') {
    const handled = await handleOpenAIProviderAddOrEditViaDialog(host);
    if (!handled) reopenProviderManager(host);
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

type ProviderAddSource = 'openai' | 'known' | 'custom';

function promptProviderAddSource(
  host: SlashCommandHost,
): Promise<ProviderAddSource | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'openai', label: 'OpenAI-compatible provider' },
        { value: 'known', label: 'Known third-party provider' },
        { value: 'custom', label: 'Custom registry (api.json)' },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(
          value === 'openai' || value === 'known' || value === 'custom'
            ? value
            : undefined,
        );
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function handleOpenAIProviderAddOrEditViaDialog(
  host: SlashCommandHost,
  providerId?: string,
): Promise<boolean> {
  const existingProvider = providerId
    ? host.state.appState.availableProviders[providerId]
    : undefined;
  if (providerId !== undefined && existingProvider !== undefined && existingProvider.type !== 'openai') {
    host.showError(`Provider "${providerId}" is not OpenAI-compatible.`);
    return false;
  }

  const value = await promptOpenAIProviderImport(host, providerId, existingProvider);
  if (value === undefined) return false;

  const baseUrl = normalizeOpenAIBaseUrl(value.baseUrl);
  const spinner = host.showProgressSpinner(`Fetching models from ${baseUrl}/models`);
  let modelIds: readonly string[];
  try {
    modelIds = await fetchOpenAICompatibleModels(baseUrl, value.apiKey);
    spinner.stop({ ok: true, label: `Loaded ${String(modelIds.length)} models.` });
  } catch (error) {
    spinner.stop({ ok: false, label: 'Failed to load models.' });
    host.showError(`Failed to fetch models: ${formatErrorMessage(error)}`);
    return false;
  }

  if (modelIds.length === 0) {
    host.showError('The provider returned no usable models.');
    return false;
  }

  const config = await host.harness.getConfig();
  const isRenaming = providerId !== undefined && providerId !== value.providerId;
  if (isRenaming && config.providers[value.providerId] !== undefined) {
    host.showError(`Provider "${value.providerId}" already exists.`);
    return false;
  }

  if (providerId !== undefined && config.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  } else if (config.providers[value.providerId] !== undefined) {
    await host.harness.removeProvider(value.providerId);
  }

  const nextConfig = await host.harness.getConfig();
  applyOpenAICompatibleProvider(nextConfig, {
    providerId: value.providerId,
    baseUrl,
    apiKey: value.apiKey,
    modelIds,
  });

  await host.harness.setConfig({
    providers: nextConfig.providers,
    models: nextConfig.models,
  });
  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: value.providerId, method: 'openai-compatible' });
  host.showStatus(
    `${providerId === undefined ? 'Provider added' : 'Provider updated'}: ${value.providerId} (${String(modelIds.length)} models)`,
    'success',
  );

  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const firstAlias = Object.keys(stateModels).find((alias) =>
    alias.startsWith(`${value.providerId}/`),
  );
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstAlias,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: value.providerId,
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
  return true;
}

function promptOpenAIProviderImport(
  host: SlashCommandHost,
  providerId: string | undefined,
  provider: ProviderConfig | undefined,
): Promise<OpenAIProviderImportValue | undefined> {
  return new Promise((resolve) => {
    const dialog = new OpenAIProviderImportDialogComponent(
      (result: OpenAIProviderImportResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        providerId,
        baseUrl: provider?.baseUrl,
        apiKey: provider?.apiKey,
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

function normalizeOpenAIBaseUrl(raw: string): string {
  try {
    return new URL(raw.trim()).toString().replace(/\/+$/, '');
  } catch {
    throw new Error('Base URL must be a valid URL.');
  }
}

async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<readonly string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText}`.trim());
  }

  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new Error('Unexpected /models response: missing data array.');
  }
  const data = (payload as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('Unexpected /models response: data is not an array.');
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of data) {
    const id =
      typeof item === 'object' && item !== null && 'id' in item
        ? (item as { readonly id?: unknown }).id
        : undefined;
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

function applyOpenAICompatibleProvider(
  config: { providers: Record<string, ProviderConfig>; models?: Record<string, ModelAlias> },
  opts: {
    readonly providerId: string;
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly modelIds: readonly string[];
  },
): void {
  config.providers[opts.providerId] = {
    type: 'openai',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    source: { kind: 'openaiModels', baseUrl: opts.baseUrl },
  };

  const models = config.models ?? {};
  for (const modelId of opts.modelIds) {
    models[`${opts.providerId}/${modelId}`] = openAICompatibleModelAlias(
      opts.providerId,
      modelId,
    );
  }
  config.models = models;
}

function openAICompatibleModelAlias(providerId: string, modelId: string): ModelAlias {
  const thinking = isLikelyOpenAIThinkingModel(modelId);
  return {
    provider: providerId,
    model: modelId,
    maxContextSize: DEFAULT_OPENAI_CONTEXT_TOKENS,
    capabilities: thinking ? ['tool_use', 'thinking'] : ['tool_use'],
    displayName: modelId,
    ...(thinking
      ? {
          supportEfforts: [...OPENAI_THINKING_EFFORTS],
          defaultEffort: DEFAULT_OPENAI_THINKING_EFFORT,
        }
      : {}),
  };
}

function isLikelyOpenAIThinkingModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const finalSegment = normalized.split('/').at(-1) ?? normalized;
  return (
    normalized.includes('openai/') ||
    normalized.includes('/gpt-') ||
    finalSegment.startsWith('gpt-') ||
    finalSegment.startsWith('chatgpt-') ||
    /^o[134](?:-|$)/.test(finalSegment)
  );
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
    catalog = await fetchCatalog(DEFAULT_CATALOG_URL, controller.signal);
    spinner.stop({ ok: true, label: 'Catalog loaded.' });
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

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  const wire = inferWireType(entry);
  if (wire === undefined) {
    host.showError(`Provider "${providerId}" has unsupported wire type.`);
    return;
  }
  const baseUrl = catalogBaseUrl(entry, wire);

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

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };

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
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: thinkingEffortToConfig(effort),
  });
  await host.authFlow.refreshConfigAfterLogin();
  host.track('model_switch', { model: alias });
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
    entries = await fetchCustomRegistry(source);
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
  // catalog (known-provider) flow.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
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
