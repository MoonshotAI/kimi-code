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
  /**
   * Protocol token of the configured custom identity, or `undefined` when none
   * is configured — in which case `headers` must reach providers untouched.
   *
   * It travels with the headers because it is the same concern: what this host
   * calls itself on the wire. `ModelCatalog` applies it to the `User-Agent` on
   * the third-party path; vendors that receive the full host header set
   * (`hostHeaders: 'full'`) keep the host's own product token, which that
   * header set is built around.
   */
  readonly identitySlug?: string;
}

export const IHostRequestHeaders = createDecorator<IHostRequestHeaders>('hostRequestHeaders');
