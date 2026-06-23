import { ChatProviderError } from '#/errors';
import type { ProviderRequestAuth } from '#/provider';
import OpenAI from 'openai';

import {
  OpenAILegacyChatProvider,
  type OpenAILegacyOptions,
} from './openai-legacy';
import { mergeRequestHeaders, requireProviderApiKey } from './request-auth';

export type AzureFoundryOptions = OpenAILegacyOptions;

function normalizeAzureFoundryBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.replace(/\/+$/, '');
}

function requireAzureFoundryBaseUrl(baseUrl: string | undefined): string {
  const normalized = normalizeAzureFoundryBaseUrl(baseUrl);
  if (normalized === undefined) {
    throw new ChatProviderError(
      'AzureFoundryChatProvider: baseUrl is required. Set base_url in config.toml or AZURE_FOUNDRY_BASE_URL in [providers.<name>.env]. Example: https://YOUR-RESOURCE.openai.azure.com/openai/v1',
    );
  }
  return normalized;
}

function buildAzureFoundryClient(
  apiKey: string,
  baseUrl: string,
  defaultHeaders: Record<string, string> | undefined,
  httpClient: unknown,
  auth?: ProviderRequestAuth,
): OpenAI {
  const key = requireProviderApiKey('AzureFoundryChatProvider', auth, apiKey);
  const headers: Record<string, string | null> = { authorization: null, 'api-key': key };
  const merged = mergeRequestHeaders(defaultHeaders, auth?.headers);
  if (merged !== undefined) {
    for (const [name, value] of Object.entries(merged)) {
      headers[name.toLowerCase()] = value;
    }
  }
  headers['api-key'] = key;

  const clientOpts: Record<string, unknown> = {
    apiKey: key,
    baseURL: baseUrl,
    defaultHeaders: headers,
  };
  if (httpClient !== undefined) {
    clientOpts['httpClient'] = httpClient;
  }
  return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
}

/**
 * Microsoft Foundry chat provider.
 *
 * Targets Foundry's OpenAI v1-compatible inference route
 * (`https://{resource}.openai.azure.com/openai/v1`) and authenticates with
 * the Foundry `api-key` header rather than Bearer auth.
 *
 * Foundry-hosted Kimi models use a shared input+output context window. Pass
 * `sharedContextWindowTokens` (wired from `max_context_size` in config) so
 * completion budgets are clamped against the serialized prompt before each
 * request.
 */
export class AzureFoundryChatProvider extends OpenAILegacyChatProvider {
  override readonly name = 'azure-foundry';

  constructor(options: AzureFoundryOptions) {
    const baseUrl = requireAzureFoundryBaseUrl(options.baseUrl);
    const apiKey = options.apiKey;
    super({
      ...options,
      baseUrl,
      clientFactory: (auth) =>
        buildAzureFoundryClient(
          apiKey ?? '',
          requireAzureFoundryBaseUrl(baseUrl),
          options.defaultHeaders,
          options.httpClient,
          auth,
        ),
    });
  }
}
