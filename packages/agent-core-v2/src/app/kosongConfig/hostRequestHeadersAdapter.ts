/**
 * `kosongConfig` domain — `IHostRequestHeaders` implementation.
 *
 * Bridges kosong's host-headers port to the host invocation args: the headers
 * are the ones the host stated in `BootstrapInput.args.requestHeaders`
 * (usually built through `createKimiDefaultHeaders`), exposed through
 * `IBootstrapService.args`. kosong's model catalog only sees the port. Bound
 * at App scope.
 *
 * The headers are a constructor snapshot (bootstrap args are frozen for the
 * process) while the identity slug is read lazily on each access: config loads
 * asynchronously, so a snapshot taken here would freeze the pre-load value and
 * silently drop a configured identity.
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

  get identitySlug(): string | undefined {
    return this.identity.slug;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostRequestHeaders,
  HostRequestHeadersAdapter,
  ScopeActivation.OnDemand,
  'kosongConfig',
);
