import type {
  CatalogModel,
  CatalogModelDefinition,
  CatalogProviderHandle,
  CatalogProviderInfo as LlmCatalogProviderInfo,
} from '@moonshot-ai/agent-core/llm/catalog/index';
import { createStaticCredentialProvider } from '@moonshot-ai/agent-core/llm/builtin/policy/credentials';
import type {
  LlmCredentialProvider,
  LlmEndpoint,
  ModelThinkingMetadata,
} from '@moonshot-ai/agent-core/llm/request';
import type { LlmRequester } from '@moonshot-ai/agent-core/llm/requester';

import type { ConfigStore, ModelsSection } from '#/todo-features/config/index';

export type { CatalogModel, CatalogModelDefinition, CatalogProviderHandle };

export type CatalogModelConfig = ModelsSection[string];

export type CatalogOAuthRef = NonNullable<CatalogModelConfig['oauth']>;

export type CatalogModelOverrides = NonNullable<CatalogModelConfig['overrides']>;

export interface CatalogProviderInfo extends LlmCatalogProviderInfo {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly env?: Readonly<Record<string, string>>;
  readonly source?: Readonly<Record<string, unknown>>;
}

export function isOAuthBackedProvider(info: CatalogProviderInfo | undefined): boolean {
  return info?.oauth !== undefined || info?.modelSource === 'oauth-catalog';
}

export function catalogModelAlias(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export interface CatalogModelBinding {
  readonly providerId: string;
  readonly model: CatalogModel;
  readonly alias: string;
  readonly configKey?: string;
  readonly requester: LlmRequester<'protocol' | 'model'>;
}

export type CatalogModelRecords = Readonly<Record<string, CatalogModelConfig>>;

export interface AddProviderInput {
  readonly handle: CatalogProviderHandle;
  readonly init?: CatalogProviderInfo;
}

export interface ProviderRefreshInput {
  readonly providerId: string;
  readonly info: CatalogProviderInfo;
}

export interface ProviderRefreshContribution {
  match(info: CatalogProviderInfo): boolean;
  refresh(input: ProviderRefreshInput): Promise<CatalogModelRecords>;
}

export interface ProviderContribution {
  readonly handle: CatalogProviderHandle;
  readonly info?: CatalogProviderInfo;
}

function thinkingMetadataOf(record: CatalogModelConfig): ModelThinkingMetadata | undefined {
  const { supportEfforts, defaultEffort, offEffort, alwaysThinking, adaptiveThinking } = record;
  if (
    supportEfforts === undefined &&
    defaultEffort === undefined &&
    offEffort === undefined &&
    alwaysThinking === undefined &&
    adaptiveThinking === undefined
  ) {
    return undefined;
  }
  return { supportEfforts, defaultEffort, offEffort, alwaysThinking, adaptiveThinking };
}

function foldOverrides(record: CatalogModelConfig): CatalogModelConfig {
  const overrides = record.overrides;
  if (overrides === undefined) return record;
  const folded: CatalogModelConfig = { ...record, ...overrides };
  if (
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    folded.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(folded.defaultEffort)
  ) {
    const { defaultEffort: _dropped, ...rest } = folded;
    return rest;
  }
  return folded;
}

function protocolOptionsOf(record: CatalogModelConfig): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (record.reasoningKey !== undefined) options['reasoningKey'] = record.reasoningKey;
  if (record.betaApi !== undefined) options['betaApi'] = record.betaApi;
  if (record.vertexai !== undefined) options['vertexai'] = record.vertexai;
  return Object.keys(options).length > 0 ? options : undefined;
}

export interface CatalogModelDefinitionContext {
  readonly providerId: string;
  readonly provider?: CatalogProviderInfo;
  readonly config?: ConfigStore;
  resolveCredential(info: CatalogProviderInfo): LlmCredentialProvider | undefined;
}

interface ProviderEndpointDefinition {
  readonly apiKeyEnv: readonly string[];
  readonly baseUrlEnv: readonly string[];
  readonly defaultBaseUrl?: string;
}

const PROVIDER_ENDPOINTS: Readonly<Record<string, ProviderEndpointDefinition>> = {
  kimi: {
    apiKeyEnv: ['KIMI_API_KEY'],
    baseUrlEnv: ['KIMI_BASE_URL'],
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
  },
  openai: {
    apiKeyEnv: ['OPENAI_API_KEY'],
    baseUrlEnv: ['OPENAI_BASE_URL'],
  },
  openai_responses: {
    apiKeyEnv: ['OPENAI_API_KEY'],
    baseUrlEnv: ['OPENAI_BASE_URL'],
  },
  anthropic: {
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    baseUrlEnv: ['ANTHROPIC_BASE_URL'],
  },
  'google-genai': {
    apiKeyEnv: ['VERTEXAI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrlEnv: ['GOOGLE_VERTEX_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
  },
  vertexai: {
    apiKeyEnv: ['VERTEXAI_API_KEY'],
    baseUrlEnv: ['GOOGLE_VERTEX_BASE_URL'],
  },
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function firstEnvHit(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function explainProviderEndpoint(
  type: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): { readonly apiKey?: string; readonly baseUrl?: string } {
  const definition = type === undefined ? undefined : PROVIDER_ENDPOINTS[type];
  if (definition === undefined) return {};
  const baseUrlHit = firstEnvHit(definition.baseUrlEnv, env);
  return {
    apiKey: nonEmpty(firstEnvHit(definition.apiKeyEnv, env)),
    baseUrl: nonEmpty(baseUrlHit ?? definition.defaultBaseUrl),
  };
}

export function catalogProviderIdOf(
  record: CatalogModelConfig,
  defaultProvider?: string,
): string {
  const referenced = record.providerId ?? record.provider ?? defaultProvider;
  if (referenced !== undefined) return referenced;
  const baseUrl = nonEmpty(record.baseUrl) ?? '';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function credentialConflictMessage(
  kind: 'Model' | 'Provider',
  name: string,
  first: string,
  second: string,
): string {
  return `${kind} "${name}" has both ${first} and ${second} set in config.toml - they are mutually exclusive. Remove one.`;
}

export interface CatalogProviderCredential {
  readonly inlineApiKey?: string;
  readonly apiKeyEnv?: string;
  readonly endpointApiKey?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly conflict?: string;
}

export function catalogProviderCredentialOf(
  providerId: string,
  provider: CatalogProviderInfo | undefined,
  protocol?: string,
): CatalogProviderCredential {
  const inlineApiKey = nonEmpty(provider?.apiKey);
  const apiKeyEnv = nonEmpty(provider?.apiKeyEnv);
  const endpointApiKey = explainProviderEndpoint(provider?.type ?? protocol, provider?.env).apiKey;
  const oauth = provider?.oauth;
  let conflict: string | undefined;
  if (inlineApiKey !== undefined && apiKeyEnv !== undefined) {
    conflict = credentialConflictMessage('Provider', providerId, 'apiKey', 'apiKeyEnv');
  } else if (apiKeyEnv !== undefined && oauth !== undefined) {
    conflict = credentialConflictMessage('Provider', providerId, 'apiKeyEnv', 'oauth');
  } else if (inlineApiKey !== undefined && oauth !== undefined) {
    conflict = credentialConflictMessage('Provider', providerId, 'apiKey', 'oauth');
  } else if (endpointApiKey !== undefined && oauth !== undefined) {
    conflict = credentialConflictMessage('Provider', providerId, 'apiKey', 'oauth');
  }
  return { inlineApiKey, apiKeyEnv, endpointApiKey, oauth, conflict };
}

export function catalogProviderHasApiKey(
  credential: CatalogProviderCredential,
  env: (name: string) => string | undefined,
): boolean {
  if (credential.inlineApiKey !== undefined) return true;
  if (credential.apiKeyEnv !== undefined) {
    return nonEmpty(env(credential.apiKeyEnv)) !== undefined;
  }
  return credential.endpointApiKey !== undefined;
}

function oauthCredential(
  oauth: CatalogOAuthRef,
  provider: CatalogProviderInfo | undefined,
  context: CatalogModelDefinitionContext,
): LlmCredentialProvider {
  return (
    context.resolveCredential({
      ...provider,
      apiKey: undefined,
      apiKeyEnv: undefined,
      env: undefined,
      oauth,
    }) ?? createStaticCredentialProvider()
  );
}

function credentialOf(
  configKey: string,
  record: CatalogModelConfig,
  context: CatalogModelDefinitionContext,
): LlmCredentialProvider | undefined {
  const modelApiKey = nonEmpty(record.apiKey);
  if (modelApiKey !== undefined && record.oauth !== undefined) {
    throw new Error(credentialConflictMessage('Model', configKey, 'apiKey', 'oauth'));
  }
  if (modelApiKey !== undefined) return createStaticCredentialProvider(modelApiKey);
  if (record.oauth !== undefined) return oauthCredential(record.oauth, context.provider, context);

  const provider = context.provider;
  const credential = catalogProviderCredentialOf(context.providerId, provider, record.protocol);
  if (credential.conflict !== undefined) throw new Error(credential.conflict);
  if (credential.inlineApiKey !== undefined) {
    return createStaticCredentialProvider(credential.inlineApiKey);
  }
  if (credential.apiKeyEnv !== undefined) {
    const apiKeyEnv = credential.apiKeyEnv;
    return {
      resolve: () => {
        const apiKey = nonEmpty(context.config?.env(apiKeyEnv));
        if (apiKey === undefined) {
          throw new Error(
            `Provider "${context.providerId}" declares api_key_env = "${apiKeyEnv}" in config.toml, but the environment variable is not set or is empty.`,
          );
        }
        return { apiKey };
      },
    };
  }
  if (credential.endpointApiKey !== undefined) {
    return createStaticCredentialProvider(credential.endpointApiKey);
  }
  if (credential.oauth !== undefined) return oauthCredential(credential.oauth, provider, context);
  return undefined;
}

function endpointOf(
  configKey: string,
  record: CatalogModelConfig,
  context?: CatalogModelDefinitionContext,
): LlmEndpoint | undefined {
  if (context === undefined) {
    const endpoint: LlmEndpoint = {
      baseUrl: record.baseUrl,
      headers: record.defaultHeaders === undefined ? undefined : { ...record.defaultHeaders },
      credentials:
        record.apiKey === undefined ? undefined : createStaticCredentialProvider(record.apiKey),
    };
    return Object.values(endpoint).some((value) => value !== undefined) ? endpoint : undefined;
  }
  const provider = context.provider;
  const endpoint = explainProviderEndpoint(provider?.type ?? record.protocol, provider?.env);
  const headers =
    provider?.customHeaders === undefined && record.defaultHeaders === undefined
      ? undefined
      : { ...provider?.customHeaders, ...record.defaultHeaders };
  const value: LlmEndpoint = {
    baseUrl: nonEmpty(record.baseUrl) ?? nonEmpty(provider?.baseUrl) ?? endpoint.baseUrl,
    headers,
    credentials: credentialOf(configKey, record, context),
  };
  return Object.values(value).some((item) => item !== undefined) ? value : undefined;
}

export function catalogModelDefinitionOf(
  configKey: string,
  record: CatalogModelConfig,
  context?: CatalogModelDefinitionContext,
): CatalogModelDefinition {
  const folded = foldOverrides(record);
  if (context !== undefined && folded.name === undefined && folded.model === undefined) {
    throw new Error(`Model "${configKey}" must define a wire-facing name in config.toml.`);
  }
  const aliases = [
    ...(folded.aliases ?? []),
    ...(folded.name === undefined ? [] : [folded.name]),
  ];
  return {
    id: folded.model ?? configKey,
    name: folded.name ?? folded.model ?? configKey,
    provider: context?.providerId ?? catalogProviderIdOf(folded),
    aliases: aliases.length === 0 ? undefined : aliases,
    displayName: folded.displayName,
    capability: folded.capability,
    thinking: thinkingMetadataOf(folded),
    maxContextSize: folded.maxContextSize,
    maxInputSize: folded.maxInputSize,
    maxOutputTokens: folded.maxOutputSize,
    protocol: folded.protocol,
    protocolOptions: protocolOptionsOf(folded),
    endpoint: endpointOf(configKey, folded, context),
    extras: { ...folded.extras, record },
  };
}
