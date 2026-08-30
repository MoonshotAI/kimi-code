import type { ManagedKimiCodeModelInfo } from './managed-kimi-code';
import { isRecord } from './utils';

// OpenAI-compatible `/models` responses omit context length, so assume a
// conservative window. Users can override per-model in config.toml; this only
// seeds the alias so the model is selectable until a richer source is used.
export const OPENAI_COMPATIBLE_DEFAULT_CONTEXT = 131072;

export interface FetchOpenAIProviderModelsOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

/**
 * Fetches the model list from an OpenAI-compatible provider's `/models`
 * endpoint and normalizes it to {@link ManagedKimiCodeModelInfo}. OpenAI's wire
 * shape is `{ data: [{ id }] }`; some gateways report `object: 'model'` per
 * entry, which we tolerate. Providers that do not serve a recognizable
 * `/models` contract throw so the caller can report the failure instead of
 * silently skipping the provider.
 */
export async function fetchOpenAIProviderModels(
  baseUrl: string,
  apiKey: string,
  options: FetchOpenAIProviderModelsOptions = {},
): Promise<ManagedKimiCodeModelInfo[]> {
  const { signal = AbortSignal.timeout(15_000), fetchImpl = fetch, userAgent } = options;
  const trimmedBase = (baseUrl ?? '').replace(/\/+$/, '');
  if (trimmedBase.length === 0) {
    throw new Error('Provider baseUrl is empty; cannot fetch models.');
  }
  const url = `${trimmedBase}/models`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (userAgent !== undefined) {
    headers['User-Agent'] = userAgent;
  }
  const init: RequestInit = { headers };
  if (signal !== undefined) init.signal = signal;

  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Failed to fetch OpenAI-compatible models from ${url} (HTTP ${response.status})${text ? `: ${text}` : ''}`,
    );
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response from ${url}: expected { data: [...] }.`);
  }

  const out: ManagedKimiCodeModelInfo[] = [];
  for (const raw of payload['data']) {
    if (!isRecord(raw)) continue;
    const id = raw['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    out.push({
      id,
      contextLength: OPENAI_COMPATIBLE_DEFAULT_CONTEXT,
      supportsReasoning: false,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: true,
    });
  }
  return out;
}
