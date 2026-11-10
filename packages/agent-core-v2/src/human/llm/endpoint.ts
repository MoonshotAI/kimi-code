import type { LlmEndpoint } from '#/llm/request';

export interface ResolvedEndpoint {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function mergeHeaders(
  ...sources: readonly (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (source !== undefined) Object.assign(merged, source);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function resolveEndpoint(endpoint: LlmEndpoint | undefined): Promise<ResolvedEndpoint> {
  const credential = await endpoint?.credentials?.resolve();
  return {
    baseUrl: endpoint?.baseUrl ?? endpoint?.defaultBaseUrl,
    apiKey: credential?.apiKey,
    headers: mergeHeaders(endpoint?.headers, credential?.headers),
    fetch: endpoint?.fetch,
  };
}
