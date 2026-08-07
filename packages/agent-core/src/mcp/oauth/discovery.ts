import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;

export interface McpOAuthDiscoveryOptions {
  readonly timeoutMs?: number;
}

export function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'authorization');
}

export function createMcpOAuthFetch(
  serverUrl: string | URL,
  configuredHeaders: Record<string, string> | undefined,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
): FetchLike {
  const resourceOrigin = new URL(serverUrl).origin;
  const extraHeaders = new Headers(configuredHeaders);
  const hasConfiguredHeaders = [...extraHeaders].length > 0;
  const deadlineMs = Date.now() + timeoutMs;

  return async (input, init = {}) => {
    const initialUrl = input instanceof Request ? input.url : input;
    const initialHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => {
      initialHeaders.set(name, value);
    });
    let url = new URL(initialUrl);
    let requestInit: RequestInit = { ...init, headers: initialHeaders };

    for (let redirectCount = 0; ; redirectCount++) {
      const headers = new Headers(requestInit.headers);
      if (url.origin === resourceOrigin) {
        extraHeaders.forEach((value, name) => {
          if (!headers.has(name)) headers.set(name, value);
        });
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) throw new Error('MCP OAuth discovery timeout exceeded');
      const timeoutSignal = AbortSignal.timeout(remainingMs);
      const signal = requestInit.signal
        ? AbortSignal.any([requestInit.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetch(url, {
        ...requestInit,
        headers,
        redirect: 'manual',
        signal,
      });
      if (!isRedirect(response.status)) return response;

      const location = response.headers.get('location');
      if (location === null) return response;
      if (redirectCount >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new Error(`OAuth discovery exceeded ${MAX_REDIRECTS} redirects`);
      }
      const nextUrl = new URL(location, url);
      if (hasConfiguredHeaders && nextUrl.origin !== url.origin) {
        await response.body?.cancel();
        throw new Error(
          `OAuth discovery redirect to non-same-origin URL rejected: ${nextUrl.toString()}`,
        );
      }
      await response.body?.cancel();
      requestInit = redirectedRequestInit(requestInit, response.status);
      url = nextUrl;
    }
  };
}

export async function discoverMcpOAuth(
  serverUrl: string | URL,
  configuredHeaders: Record<string, string> | undefined,
  options: McpOAuthDiscoveryOptions = {},
): Promise<OAuthDiscoveryState | undefined> {
  const resourceUrl = new URL(serverUrl);
  const fetchFn = createMcpOAuthFetch(resourceUrl, configuredHeaders, options.timeoutMs);
  let resourceMetadata;
  let resourceMetadataUrl: URL | undefined;

  const response = await fetchFn(resourceUrl, {
    method: 'GET',
    headers: { Accept: 'application/json, text/event-stream' },
  });
  try {
    if (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429
    ) {
      throw new Error(
        `HTTP ${response.status} probing MCP OAuth support at ${resourceUrl.toString()}`,
      );
    }
    if (response.status === 401) {
      resourceMetadataUrl = extractWWWAuthenticateParams(response).resourceMetadataUrl;
    }
  } finally {
    await response.body?.cancel();
  }

  if (resourceMetadataUrl !== undefined) {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      resourceUrl,
      { resourceMetadataUrl },
      fetchFn,
    );
  } else {
    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(
        resourceUrl,
        undefined,
        fetchFn,
      );
    } catch (error) {
      if (!isMissingProtectedResourceMetadata(error)) throw error;
    }
  }

  if (
    resourceMetadata !== undefined &&
    !checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(resourceUrl),
      configuredResource: resourceMetadata.resource,
    })
  ) {
    throw new Error(
      `Protected resource ${resourceMetadata.resource} does not match expected ${resourceUrlFromServerUrl(resourceUrl).toString()}`,
    );
  }
  let authorizationServerUrl =
    resourceMetadata?.authorization_servers?.[0] ?? resourceUrl.toString();
  let authorizationServerMetadata = await discoverMcpAuthorizationServerMetadata(
    authorizationServerUrl,
    fetchFn,
  );
  if (authorizationServerMetadata === undefined && resourceMetadata === undefined) {
    const legacyRootUrl = new URL('/', resourceUrl).toString();
    if (legacyRootUrl !== authorizationServerUrl) {
      const legacyRootMetadata = await discoverMcpAuthorizationServerMetadata(
        legacyRootUrl,
        fetchFn,
      );
      if (legacyRootMetadata !== undefined) {
        authorizationServerUrl = legacyRootUrl;
        authorizationServerMetadata = legacyRootMetadata;
      }
    }
  }
  if (authorizationServerMetadata === undefined) return undefined;
  return {
    authorizationServerUrl,
    authorizationServerMetadata,
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
    ...(resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: resourceMetadataUrl.toString() }),
  };
}

async function discoverMcpAuthorizationServerMetadata(
  authorizationServerUrl: string | URL,
  fetchFn: FetchLike,
) {
  const expectedIssuer = new URL(authorizationServerUrl).toString();
  return discoverAuthorizationServerMetadata(authorizationServerUrl, {
    fetchFn: async (input, init) => {
      const response = await fetchFn(input, init);
      if (!response.ok) return response;
      const metadata = JSON.parse(await response.text()) as Record<string, unknown>;
      const issuer = metadata['issuer'];
      if (issuer === undefined) {
        metadata['issuer'] = expectedIssuer;
      } else if (
        typeof issuer === 'string' &&
        new URL(issuer).toString() !== expectedIssuer
      ) {
        throw new Error(
          `Authorization server issuer ${issuer} does not match expected ${expectedIssuer}`,
        );
      }
      return new Response(JSON.stringify(metadata), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}

function isMissingProtectedResourceMetadata(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('does not implement OAuth 2.0 Protected Resource Metadata')
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectedRequestInit(init: RequestInit, status: number): RequestInit {
  const method = init.method?.toUpperCase();
  if (status !== 303 && !((status === 301 || status === 302) && method === 'POST')) return init;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  headers.delete('content-type');
  return { ...init, method: 'GET', body: undefined, headers };
}
