import {
  KIMI_CODE_PROVIDER_NAME,
  OPEN_PLATFORMS,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  KimiConfig,
  MoonshotServiceConfig,
  RerankServiceConfig,
  ServicesConfig,
} from '@moonshot-ai/kimi-code-sdk';

import {
  ChoicePickerComponent,
  type ChoiceOption,
} from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { isExperimentalFlagEnabled } from './experimental-flags';
import { promptApiKey } from './prompts';

// ---------------------------------------------------------------------------
// /settings → Web Search — search and rerank provider configuration
// ---------------------------------------------------------------------------

const LANGSEARCH_EXPERIMENTAL_FLAG = 'langsearch-web-search';
const ROOT_SEARCH_PROVIDER = 'search-provider';
const ROOT_RERANK_PROVIDER = 'rerank-provider';

const SEARCH_PROVIDER_VALUES = ['moonshot', 'langsearch'] as const;
type SearchProviderChoice = (typeof SEARCH_PROVIDER_VALUES)[number];

const TIER_VALUES = ['free', 'tier1', 'tier2', 'tier3'] as const;
type LangSearchTier = (typeof TIER_VALUES)[number];

const RERANK_PROVIDER_VALUES = ['langsearch'] as const;
type RerankProviderChoice = (typeof RERANK_PROVIDER_VALUES)[number];

const RERANK_TOGGLE_VALUES = ['enabled', 'disabled'] as const;
type RerankToggle = (typeof RERANK_TOGGLE_VALUES)[number];

interface PickerOptions {
  readonly title: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  readonly notice?: string;
  readonly noticeTone?: 'success' | 'warning';
}

interface MoonshotOAuthSource {
  readonly baseUrl: string;
  readonly oauth: NonNullable<MoonshotServiceConfig['oauth']>;
}

/** Settings → Web Search entry with current provider state shown at the top. */
export async function showWebSearchConfig(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const services = config.services ?? {};
  const summary = currentProviderSummary(services);
  const action = await pickChoice(host, {
    title: 'Web Search',
    notice: `${summary.search}\n${summary.rerank}`,
    noticeTone: summary.hasWarning ? 'warning' : 'success',
    options: [
      {
        value: ROOT_SEARCH_PROVIDER,
        label: 'Web search provider',
        description: 'Configure Moonshot or LangSearch for web search.',
      },
      {
        value: ROOT_RERANK_PROVIDER,
        label: 'Rerank provider',
        description: 'Configure and manage semantic reranking.',
      },
    ],
  });
  if (action === ROOT_SEARCH_PROVIDER) {
    await showSearchProviderMenu(host);
  } else if (action === ROOT_RERANK_PROVIDER) {
    await showRerankProviderMenu(host);
  }
}

async function showSearchProviderMenu(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const services = config.services ?? {};
  const current = currentSearchProvider(services);
  const selected = await pickChoice(host, {
    title: 'Web search provider',
    currentValue: current,
    options: [
      {
        value: 'moonshot',
        label: 'Moonshot',
        description: 'Configure a Moonshot API key.',
      },
      {
        value: 'langsearch',
        label: 'LangSearch',
        description: isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG)
          ? 'Use the LangSearch Web Search API.'
          : 'Enable LangSearch web search under Settings → Experiments first.',
      },
    ],
  });
  if (!isSearchProviderChoice(selected)) return;
  if (
    selected === 'langsearch' &&
    !isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG)
  ) {
    showLangSearchExperimentalNotice(host);
    return;
  }

  if (selected === current) {
    await manageSearchProvider(host, selected);
  } else {
    await configureSearchProvider(host, selected);
  }
}

async function manageSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  const label = searchProviderLabel(provider);
  const action = await pickChoice(host, {
    title: `${label} web search`,
    options: [
      {
        value: 'edit',
        label: 'Edit configuration',
        description: `Replace the current ${label} search settings.`,
      },
      {
        value: 'remove',
        label: 'Remove provider',
        description: 'Remove this web search provider configuration.',
        tone: 'danger',
      },
    ],
  });
  if (action === 'edit') {
    await configureSearchProvider(host, provider);
  } else if (action === 'remove') {
    await removeSearchProvider(host, provider);
  }
}

async function configureSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  if (provider === 'langsearch') {
    await configureLangSearch(host);
  } else {
    await configureMoonshot(host);
  }
}

async function configureLangSearch(host: SlashCommandHost): Promise<void> {
  const apiKey = await promptApiKey(host, 'LangSearch', [
    'Your key will be saved to ~/.kimi-code/config.toml under [services.langsearch].',
  ]);
  if (apiKey === undefined) return;

  const tier = await pickTier(host);
  if (tier === undefined) return;

  try {
    await host.harness.replaceService('langsearch', {
      apiKey,
      tier,
    });
    await reloadSessionAfterWebSearchChange(host, 'LangSearch web search configured.');
  } catch (error) {
    host.showError(`Failed to save LangSearch config: ${formatErrorMessage(error)}`);
  }
}

async function configureMoonshot(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const oauthSource = findMoonshotOAuthSource(config);
  const options: ChoiceOption[] = [];
  if (oauthSource !== undefined) {
    options.push({
      value: 'oauth',
      label: 'Kimi Code OAuth',
      description: 'Reuse the credentials from your existing Kimi Code login.',
    });
  }
  options.push({
    value: 'api-key',
    label: 'Moonshot API key',
    description: 'Configure Moonshot Search using an API key.',
  });

  const authMethod = await pickChoice(host, {
    title: 'Moonshot authentication',
    currentValue:
      config.services?.moonshotSearch?.oauth !== undefined ? 'oauth' : undefined,
    options,
  });
  if (authMethod === 'oauth' && oauthSource !== undefined) {
    await saveMoonshotConfig(host, {
      baseUrl: oauthSource.baseUrl,
      apiKey: '',
      oauth: oauthSource.oauth,
    });
  } else if (authMethod === 'api-key') {
    await configureMoonshotApiKey(host);
  }
}

async function configureMoonshotApiKey(host: SlashCommandHost): Promise<void> {
  const platformId = await pickChoice(host, {
    title: 'Moonshot API region',
    options: OPEN_PLATFORMS.map((platform) => ({
      value: platform.id,
      label: platform.name,
      description: platform.baseUrl,
    })),
  });
  const platform = OPEN_PLATFORMS.find((candidate) => candidate.id === platformId);
  if (platform === undefined) return;

  const apiKey = await promptApiKey(host, platform.name, [
    `${'search URL'.padEnd(12)}${searchUrlFromBaseUrl(platform.baseUrl)}`,
    `${'saved to'.padEnd(12)}~/.kimi-code/config.toml`,
  ]);
  if (apiKey === undefined) return;

  await saveMoonshotConfig(host, {
    baseUrl: searchUrlFromBaseUrl(platform.baseUrl),
    apiKey,
  });
}

async function saveMoonshotConfig(
  host: SlashCommandHost,
  service: MoonshotServiceConfig,
): Promise<void> {
  try {
    const config = await host.harness.getConfig();
    const langsearch = config.services?.langsearch;
    const rerank = config.services?.rerank;
    await host.harness.replaceService('moonshotSearch', service);
    if (
      rerank?.provider === 'langsearch' &&
      !isNonEmpty(rerank.apiKey) &&
      isNonEmpty(langsearch?.apiKey)
    ) {
      await host.harness.replaceService('rerank', {
        ...rerank,
        apiKey: langsearch.apiKey,
      });
    }
    if (langsearch !== undefined) {
      await host.harness.removeService('langsearch');
    }
    await reloadSessionAfterWebSearchChange(host, 'Moonshot web search configured.');
  } catch (error) {
    host.showError(`Failed to save Moonshot config: ${formatErrorMessage(error)}`);
  }
}

async function removeSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  try {
    await host.harness.removeService(
      provider === 'moonshot' ? 'moonshotSearch' : 'langsearch',
    );
    await reloadSessionAfterWebSearchChange(
      host,
      `${searchProviderLabel(provider)} web search removed.`,
    );
  } catch (error) {
    host.showError(
      `Failed to remove ${searchProviderLabel(provider)}: ${formatErrorMessage(error)}`,
    );
  }
}

async function showRerankProviderMenu(host: SlashCommandHost): Promise<void> {
  if (!isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG)) {
    showLangSearchExperimentalNotice(host);
    return;
  }
  const config = await host.harness.getConfig();
  const rerank = config.services?.rerank;
  const selected = await pickChoice(host, {
    title: 'Rerank provider',
    currentValue: rerank?.provider,
    options: [
      {
        value: 'langsearch',
        label: 'LangSearch',
        description: 'Reorder web search results using semantic relevance.',
      },
    ],
  });
  if (!isRerankProviderChoice(selected)) return;

  if (rerank?.provider === selected) {
    await editRerankProvider(host, rerank);
  } else {
    await setupRerankProvider(host, selected);
  }
}

async function setupRerankProvider(
  host: SlashCommandHost,
  provider: RerankProviderChoice,
): Promise<void> {
  const apiKey = await promptRerankApiKey(host);
  if (apiKey === undefined) return;
  const config = await host.harness.getConfig();
  if (!isNonEmpty(apiKey) && !isNonEmpty(config.services?.langsearch?.apiKey)) {
    host.showError(
      'A LangSearch API key is required when the search provider is not LangSearch.',
    );
    return;
  }

  const toggle = await pickRerankToggle(host);
  if (toggle === undefined) return;

  try {
    await host.harness.replaceService('rerank', {
      enabled: toggle === 'enabled',
      provider,
      apiKey: isNonEmpty(apiKey) ? apiKey : undefined,
    });
    await reloadSessionAfterWebSearchChange(host, 'Rerank configured.');
  } catch (error) {
    host.showError(`Failed to save rerank config: ${formatErrorMessage(error)}`);
  }
}

async function editRerankProvider(
  host: SlashCommandHost,
  rerank: RerankServiceConfig,
): Promise<void> {
  const action = await pickChoice(host, {
    title: 'LangSearch rerank',
    notice: `Current status: ${rerank.enabled === false ? 'disabled' : 'enabled'}`,
    options: [
      {
        value: 'status',
        label: 'Status',
        description: rerank.enabled === false ? 'Disabled' : 'Enabled',
      },
      {
        value: 'api-key',
        label: 'API key',
        description:
          isNonEmpty(rerank.apiKey)
            ? 'A dedicated rerank API key is configured.'
            : 'Reuses the LangSearch web search API key.',
      },
      {
        value: 'remove',
        label: 'Remove provider',
        description: 'Delete the rerank provider configuration.',
        tone: 'danger',
      },
    ],
  });

  if (action === 'status') {
    await editRerankStatus(host, rerank);
  } else if (action === 'api-key') {
    await editRerankApiKey(host, rerank);
  } else if (action === 'remove') {
    await removeRerankProvider(host);
  }
}

async function editRerankStatus(
  host: SlashCommandHost,
  rerank: RerankServiceConfig,
): Promise<void> {
  const current: RerankToggle = rerank.enabled === false ? 'disabled' : 'enabled';
  const toggle = await pickRerankToggle(host, current);
  if (toggle === undefined || toggle === current) return;

  try {
    await host.harness.replaceService('rerank', {
      ...rerank,
      enabled: toggle === 'enabled',
    });
    await reloadSessionAfterWebSearchChange(host, `Rerank ${toggle}.`);
  } catch (error) {
    host.showError(`Failed to update rerank status: ${formatErrorMessage(error)}`);
  }
}

async function editRerankApiKey(
  host: SlashCommandHost,
  rerank: RerankServiceConfig,
): Promise<void> {
  const apiKey = await promptRerankApiKey(host);
  if (apiKey === undefined) return;
  const config = await host.harness.getConfig();
  if (!isNonEmpty(apiKey) && !isNonEmpty(config.services?.langsearch?.apiKey)) {
    host.showError(
      'A LangSearch API key is required when the search provider is not LangSearch.',
    );
    return;
  }

  try {
    await host.harness.replaceService('rerank', {
      ...rerank,
      apiKey: isNonEmpty(apiKey) ? apiKey : undefined,
    });
    await reloadSessionAfterWebSearchChange(host, 'Rerank API key updated.');
  } catch (error) {
    host.showError(`Failed to update rerank API key: ${formatErrorMessage(error)}`);
  }
}

async function removeRerankProvider(host: SlashCommandHost): Promise<void> {
  try {
    await host.harness.removeService('rerank');
    await reloadSessionAfterWebSearchChange(host, 'Rerank provider removed.');
  } catch (error) {
    host.showError(`Failed to remove rerank provider: ${formatErrorMessage(error)}`);
  }
}

function promptRerankApiKey(host: SlashCommandHost): Promise<string | undefined> {
  return promptApiKey(
    host,
    'LangSearch Rerank',
    ['API key for rerank. Leave empty to reuse the LangSearch search key.'],
    { allowEmpty: true },
  );
}

function pickTier(host: SlashCommandHost): Promise<LangSearchTier | undefined> {
  return pickChoice(host, {
    title: 'LangSearch tier',
    options: TIER_VALUES.map((value) => ({
      value,
      label: value,
      description:
        value === 'free'
          ? 'Free tier — lowest rate limits.'
          : `${value} — higher rate limits.`,
    })),
  }).then((value) => (isLangSearchTier(value) ? value : undefined));
}

function pickRerankToggle(
  host: SlashCommandHost,
  currentValue?: RerankToggle,
): Promise<RerankToggle | undefined> {
  return pickChoice(host, {
    title: 'Rerank status',
    currentValue,
    options: [
      {
        value: 'enabled',
        label: 'Enabled',
        description: 'Rerank search results by relevance.',
      },
      {
        value: 'disabled',
        label: 'Disabled',
        description: 'Keep rerank configured but turned off.',
      },
    ],
  }).then((value) => (isRerankToggle(value) ? value : undefined));
}

function pickChoice(
  host: SlashCommandHost,
  options: PickerOptions,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: options.title,
      options: options.options,
      currentValue: options.currentValue,
      notice: options.notice,
      noticeTone: options.noticeTone,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function reloadSessionAfterWebSearchChange(
  host: SlashCommandHost,
  statusMessage: string,
): Promise<void> {
  if (host.session === undefined) {
    host.showStatus(statusMessage);
    return;
  }
  await host.session.reloadSession();
  await host.reloadCurrentSessionView(host.session, `${statusMessage} Session reloaded.`);
}

function findMoonshotOAuthSource(config: KimiConfig): MoonshotOAuthSource | undefined {
  const managed = config.providers[KIMI_CODE_PROVIDER_NAME];
  if (managed?.oauth !== undefined && isNonEmpty(managed.baseUrl)) {
    return {
      baseUrl: searchUrlFromBaseUrl(managed.baseUrl),
      oauth: managed.oauth,
    };
  }

  const service = config.services?.moonshotSearch;
  if (service?.oauth !== undefined && isNonEmpty(service.baseUrl)) {
    return {
      baseUrl: service.baseUrl,
      oauth: service.oauth,
    };
  }
  return undefined;
}

function currentSearchProvider(
  services: ServicesConfig,
): SearchProviderChoice | undefined {
  if (
    isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG) &&
    isNonEmpty(services.langsearch?.apiKey)
  ) {
    return 'langsearch';
  }
  if (isNonEmpty(services.moonshotSearch?.baseUrl)) return 'moonshot';
  return undefined;
}

function currentProviderSummary(services: ServicesConfig): {
  readonly search: string;
  readonly rerank: string;
  readonly hasWarning: boolean;
} {
  const langSearchEnabled = isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG);
  const current = currentSearchProvider(services);
  const langSearchDisabled = !langSearchEnabled && isNonEmpty(services.langsearch?.apiKey);
  const search =
    current === 'langsearch'
      ? `Current web search: LangSearch (tier: ${services.langsearch?.tier ?? 'free'})`
      : current === 'moonshot'
        ? `Current web search: Moonshot (${services.moonshotSearch?.oauth !== undefined ? 'OAuth' : 'API key'})`
        : langSearchDisabled
          ? 'Current web search: LangSearch configured, experimental feature disabled'
          : 'Current web search: not configured';

  const rerank = services.rerank;
  if (rerank?.provider === undefined) {
    return {
      search,
      rerank: 'Current rerank: not configured',
      hasWarning: current === undefined || langSearchDisabled,
    };
  }
  const rerankLabel = rerankProviderLabel(rerank.provider);
  if (!langSearchEnabled) {
    return {
      search,
      rerank: `Current rerank: ${rerankLabel} configured, experimental feature disabled`,
      hasWarning: true,
    };
  }
  if (rerank.enabled === false) {
    return {
      search,
      rerank: `Current rerank: ${rerankLabel} disabled`,
      hasWarning: current === undefined,
    };
  }

  const hasKey = isNonEmpty(rerank.apiKey) || isNonEmpty(services.langsearch?.apiKey);
  return {
    search,
    rerank: `Current rerank: ${rerankLabel} ${hasKey ? 'enabled' : 'missing API key'}`,
    hasWarning: current === undefined || !hasKey,
  };
}

function searchProviderLabel(provider: SearchProviderChoice): string {
  return provider === 'moonshot' ? 'Moonshot' : 'LangSearch';
}

function rerankProviderLabel(provider: RerankProviderChoice): string {
  return provider === 'langsearch' ? 'LangSearch' : provider;
}

function showLangSearchExperimentalNotice(host: SlashCommandHost): void {
  host.showNotice(
    'Enable “LangSearch web search” under Settings → Experiments before configuring LangSearch or rerank.',
  );
}

function searchUrlFromBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/search`;
}

function isSearchProviderChoice(value: string | undefined): value is SearchProviderChoice {
  return value !== undefined && (SEARCH_PROVIDER_VALUES as readonly string[]).includes(value);
}

function isLangSearchTier(value: string | undefined): value is LangSearchTier {
  return value !== undefined && (TIER_VALUES as readonly string[]).includes(value);
}

function isRerankProviderChoice(value: string | undefined): value is RerankProviderChoice {
  return value !== undefined && (RERANK_PROVIDER_VALUES as readonly string[]).includes(value);
}

function isRerankToggle(value: string | undefined): value is RerankToggle {
  return value !== undefined && (RERANK_TOGGLE_VALUES as readonly string[]).includes(value);
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
