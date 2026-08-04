/**
 * `kosong/model` domain (L2) — host-provided default headers for outbound
 * provider requests (port contract).
 *
 * Mirrors v1's `kimiRequestHeaders`: the host (CLI / server) states its Kimi
 * identity headers (`User-Agent` + `X-Msh-*`) in
 * `BootstrapInput.args.requestHeaders`; the app-side adapter
 * (`app/kosongConfig/hostRequestHeadersAdapter`) bridges
 * `IBootstrapService.args` to this port so kosong stays a pure abstraction
 * layer. The port carries two finished layers and `ModelCatalog` picks one
 * per vendor — `headers`, the full verbatim set, for vendors whose definition
 * declares `hostHeaders: 'full'`; `thirdPartyHeaders`, at most the
 * `User-Agent`, for everyone else (so device identity never leaks to
 * third-party endpoints). Any custom-identity rewriting happens on the app
 * side before the layers reach this port; kosong applies them as given.
 *
 * `identitySlug` is provenance metadata only — the configured custom
 * identity's token, surfaced by `inspect` to label where the third-party
 * `User-Agent`'s product token came from. No resolution logic reads it.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly thirdPartyHeaders: Readonly<Record<string, string>>;
  readonly identitySlug?: string;
}

export const IHostRequestHeaders = createDecorator<IHostRequestHeaders>('hostRequestHeaders');
