import { fetch as undiciFetch, EnvHttpProxyAgent } from 'undici';

const nativeFetch = globalThis.fetch;
let proxyAgent: EnvHttpProxyAgent | undefined;
let proxyFetch: typeof fetch | undefined;

/**
 * Return a `fetch` implementation that honours `HTTP_PROXY` / `HTTPS_PROXY`
 * (and their lower-case variants) as well as `NO_PROXY`.
 *
 * When no proxy environment variables are set this returns the global
 * `fetch` so there is no runtime overhead.
 *
 * Note: this module is intentionally duplicated in `packages/kosong/src/proxy.ts`
 * because `oauth` does not depend on `kosong`. Keep the two files in sync.
 */
export function getProxyFetch(): typeof fetch {
  if (proxyFetch !== undefined) {
    return proxyFetch;
  }

  const hasProxy =
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy'] ||
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'];

  if (!hasProxy) {
    proxyFetch = fetch;
    return proxyFetch;
  }

  const noProxyEnv = process.env['no_proxy'] ?? process.env['NO_PROXY'];
  const noProxy = noProxyEnv === undefined ? 'localhost,127.0.0.1' : noProxyEnv;

  proxyAgent = new EnvHttpProxyAgent({ noProxy });
  proxyFetch = (url, init) => {
    // If global fetch has been replaced (e.g. mocked in tests), delegate to it
    if (globalThis.fetch !== nativeFetch) {
      return globalThis.fetch(url, init);
    }
    return undiciFetch(
      url,
      { ...init, dispatcher: proxyAgent } as Parameters<typeof undiciFetch>[1],
    );
  };
  return proxyFetch;
}
