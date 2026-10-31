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

export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

export function isOpenCodeEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return false;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === 'opencode.ai' || hostname.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

export function withOpencodeSessionHeader(
  baseUrl: string | undefined,
  headers: Record<string, string> | undefined,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return headers;
  }
  if (!isOpenCodeEndpoint(baseUrl)) {
    return headers;
  }
  if (
    headers !== undefined &&
    Object.keys(headers).some((key) => key.toLowerCase() === OPENCODE_SESSION_HEADER)
  ) {
    return headers;
  }
  return { ...headers, [OPENCODE_SESSION_HEADER]: sessionId };
}
