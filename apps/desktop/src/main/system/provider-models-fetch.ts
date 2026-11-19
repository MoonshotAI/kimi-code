import { net } from 'electron';

export interface ProviderModelsFetchRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export type ProviderModelsFetchResult =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: 'timeout' | 'network' };

const MAX_TIMEOUT_MS = 30_000;
const MAX_HEADERS = 64;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 16_384;
const MAX_BODY_LENGTH = 1_048_576;

export function asProviderModelsFetchRequest(value: unknown): ProviderModelsFetchRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const url = raw['url'];
  if (typeof url !== 'string' || url === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const headers: Record<string, string> = {};
  const rawHeaders = raw['headers'];
  if (rawHeaders !== undefined) {
    if (rawHeaders === null || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      return null;
    }
    const entries = Object.entries(rawHeaders as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) return null;
    for (const [name, headerValue] of entries) {
      if (
        typeof headerValue !== 'string' ||
        name.length > MAX_HEADER_NAME_LENGTH ||
        headerValue.length > MAX_HEADER_VALUE_LENGTH
      ) {
        return null;
      }
      headers[name] = headerValue;
    }
  }
  const rawTimeout = raw['timeoutMs'];
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
      ? Math.min(Math.max(Math.floor(rawTimeout), 1), MAX_TIMEOUT_MS)
      : MAX_TIMEOUT_MS;
  return { url: parsed.toString(), headers, timeoutMs };
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}

export async function fetchProviderModelsViaNet(
  request: ProviderModelsFetchRequest,
): Promise<ProviderModelsFetchResult> {
  try {
    const response = await net.fetch(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const body = (await response.text()).slice(0, MAX_BODY_LENGTH);
    return { ok: true, status: response.status, body };
  } catch (err) {
    return { ok: false, kind: isTimeoutError(err) ? 'timeout' : 'network' };
  }
}
