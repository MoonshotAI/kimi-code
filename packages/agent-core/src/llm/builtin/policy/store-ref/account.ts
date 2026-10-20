import { headerValue, type ResolvedEndpoint } from '#/llm/endpoint';
import type { LlmModelSpec } from '#/llm/request';
import { sha256Hex } from '#/utils/hash';

function decodeBase64Url(text: string): string {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function stableJwtSubject(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(parts[1]!));
    if (typeof payload !== 'object' || payload === null) return undefined;
    const { sub, user_id: userId } = payload as { sub?: unknown; user_id?: unknown };
    if (typeof sub === 'string' && sub.length > 0) return sub;
    return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
  } catch {
    return undefined;
  }
}

export async function endpointIdentity(endpoint: ResolvedEndpoint): Promise<string> {
  const authorization = headerValue(endpoint.headers ?? {}, 'authorization');
  const identity =
    authorization !== undefined
      ? `authorization\0${authorization.trim()}`
      : endpoint.apiKey !== undefined && endpoint.apiKey.length > 0
        ? `api-key\0${stableJwtSubject(endpoint.apiKey) ?? endpoint.apiKey}`
        : undefined;
  if (identity === undefined) return 'no-key';
  return (await sha256Hex(new TextEncoder().encode(identity))).slice(0, 16);
}

export async function accountOf(model: LlmModelSpec, endpoint: ResolvedEndpoint): Promise<string> {
  return [model.provider, endpoint.baseUrl ?? '', await endpointIdentity(endpoint)].join('\0');
}
