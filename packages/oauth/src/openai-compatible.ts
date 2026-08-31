import type { ManagedKimiCodeModelInfo } from './managed-kimi-code';
import { isRecord } from './utils';

// Honor a provider-supplied context length (OpenRouter's `context_length`,
// OpenAI's `context_window`) when present; fall back to a conservative 256K
// window only when the value is missing or invalid. Users can still override
// per-model in config.toml. The `/refresh-catalog` path preserves a curated
// `maxContextSize` and only uses this default for brand-new aliases.
export const OPENAI_COMPATIBLE_DEFAULT_CONTEXT = 262144;

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
    const rawCtx = raw['context_length'] ?? raw['context_window'];
    const parsedCtx = Number(rawCtx);
    const reportedContextLength =
      Number.isInteger(parsedCtx) && parsedCtx > 0 ? parsedCtx : undefined;
    // Every normalized model carries a positive context window: use the
    // endpoint-reported value when present, otherwise the conservative 256K
    // default. `reportedContextLength` stays undefined when the endpoint said
    // nothing, so the catalog refresh can preserve a curated `maxContextSize`.
    const contextLength = reportedContextLength ?? OPENAI_COMPATIBLE_DEFAULT_CONTEXT;
    const rawName = raw['name'];
    const displayName = typeof rawName === 'string' && rawName.length > 0 ? rawName : undefined;
    out.push({
      id,
      contextLength,
      ...(reportedContextLength !== undefined ? { reportedContextLength } : {}),
      displayName,
      supportsReasoning: false,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: true,
    });
  }
  return out;
}
