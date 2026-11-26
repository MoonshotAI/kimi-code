import { readApiErrorDetails } from './api-error';
import { parseKimiCodeCustomHeaders } from './identity';

export interface ManagedEndpointFetchOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ManagedEndpointError {
  readonly kind: 'error';
  readonly status?: number;
  readonly errorCode?: string;
  readonly message: string;
}

export async function fetchManagedJson(
  url: string,
  accessToken: string,
  resourceLabel: string,
  opts: ManagedEndpointFetchOptions & { readonly status404Message?: string } = {},
): Promise<{ readonly kind: 'ok'; readonly payload: unknown } | ManagedEndpointError> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(url, {
      headers: {
        ...parseKimiCodeCustomHeaders(),
        ...opts.headers,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status = res.status;
      const fallback =
        status === 401
          ? 'Authorization failed. Please check your API key (try /login).'
          : status === 404 && opts.status404Message !== undefined
            ? opts.status404Message
            : `Failed to fetch ${resourceLabel}: HTTP ${String(status)}`;
      const details = await readApiErrorDetails(res, fallback);
      return {
        kind: 'error',
        status,
        ...(details.code !== undefined ? { errorCode: details.code } : {}),
        message: details.message,
      };
    }
    const json: unknown = await res.json();
    return { kind: 'ok', payload: json };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: `Failed to fetch ${resourceLabel}: request timed out.` };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch ${resourceLabel}: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
