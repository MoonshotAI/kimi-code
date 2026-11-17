import type { LlmEndpoint } from '#/llm/request';

export interface ResolvedEndpoint {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

export type LlmEndpointEnvironment = Readonly<Record<string, string | undefined>>;

export interface LlmEndpointDeclaration {
  readonly apiKeyEnv?: string;
  readonly baseUrlEnv?: string;
  readonly defaultBaseUrl?: string;
}

export interface ResolvedLlmEndpointDeclaration {
  readonly apiKey?: string;
  readonly apiKeyEnvName?: string;
  readonly baseUrl?: string;
  readonly baseUrlEnvName?: string;
  readonly baseUrlIsDefault?: boolean;
}

function firstEnvironmentValue(
  names: readonly string[],
  env: LlmEndpointEnvironment,
): { readonly name: string; readonly value: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return { name, value };
  }
  return undefined;
}

export function resolveEndpointDeclaration(
  source: LlmEndpointDeclaration | readonly LlmEndpointDeclaration[] | undefined,
  env: LlmEndpointEnvironment = process.env,
): ResolvedLlmEndpointDeclaration {
  const declarations = source === undefined ? [] : Array.isArray(source) ? source : [source];
  const apiKey = firstEnvironmentValue(
    declarations.flatMap((declaration) => declaration.apiKeyEnv ?? []),
    env,
  );
  const baseUrl = firstEnvironmentValue(
    declarations.flatMap((declaration) => declaration.baseUrlEnv ?? []),
    env,
  );
  const defaultBaseUrl = declarations.findLast(
    (declaration) => declaration.defaultBaseUrl !== undefined,
  )?.defaultBaseUrl;
  return {
    apiKey: apiKey?.value,
    apiKeyEnvName: apiKey?.name,
    baseUrl: baseUrl?.value ?? defaultBaseUrl,
    baseUrlEnvName: baseUrl?.name,
    baseUrlIsDefault: baseUrl === undefined && defaultBaseUrl !== undefined ? true : undefined,
  };
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
