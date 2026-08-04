/**
 * `kosong/model` domain (L2) — host-provided default headers for outbound
 * provider requests (port contract).
 *
 * Mirrors v1's `kimiRequestHeaders`: the host (CLI / server) states its Kimi
 * identity headers (`User-Agent` + `X-Msh-*`) in
 * `BootstrapInput.args.requestHeaders`; the app-side adapter
 * (`app/kosongConfig/hostRequestHeadersAdapter`) bridges
 * `IBootstrapService.args` to this port so kosong stays a pure abstraction
 * layer. `ModelCatalog` merges them per vendor — the full set for vendors
 * whose definition declares `hostHeaders: 'full'`, only the `User-Agent` for
 * everyone else (so device identity never leaks to third-party endpoints).
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;
}

export const IHostRequestHeaders = createDecorator<IHostRequestHeaders>('hostRequestHeaders');

const FIRST_PARTY_HOSTS = new Set(['api.moonshot.ai', 'api.moonshot.cn']);

/**
 * True when a base URL points at the vendor's own endpoint, the only place
 * the full host identity set (device id included) may be forwarded to.
 * HTTPS is required: the same hostname over plain HTTP must not receive
 * those headers in the clear. An unset base URL means the vendor's default
 * endpoint, which is first-party by definition.
 */
export function isFirstPartyBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) {
    return true;
  }
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && FIRST_PARTY_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
