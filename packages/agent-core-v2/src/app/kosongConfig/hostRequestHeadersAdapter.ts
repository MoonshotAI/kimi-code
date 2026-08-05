/**
 * `kosongConfig` domain — `IHostRequestHeaders` implementation.
 *
 * Bridges kosong's host-headers port to the host invocation args: `headers`
 * is what the host stated in `BootstrapInput.args.requestHeaders` (usually
 * built through `createKimiDefaultHeaders`), verbatim; `thirdPartyHeaders` is
 * the `User-Agent`-only layer with the product token taken from the frozen
 * identity snapshot. kosong's model catalog only sees the port. Bound at App
 * scope.
 *
 * The third-party layer reads `agentIdentity.current()`, which throws until
 * config has first loaded — so a model materialized too early fails loudly
 * instead of caching headers that misstate the configured identity. Vendors
 * on the full-headers path never touch it.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';

export class HostRequestHeadersAdapter implements IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {
    this.headers = bootstrap.args.requestHeaders;
  }

  get thirdPartyHeaders(): Readonly<Record<string, string>> {
    const userAgent = this.identity.current().thirdPartyUserAgent;
    return userAgent === undefined ? {} : { 'User-Agent': userAgent };
  }

  get identitySlug(): string | undefined {
    return this.identity.current().slug;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostRequestHeaders,
  HostRequestHeadersAdapter,
  ScopeActivation.OnDemand,
  'kosongConfig',
);
