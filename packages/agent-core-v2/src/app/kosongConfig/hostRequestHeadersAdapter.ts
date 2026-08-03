/**
 * `kosongConfig` domain — `IHostRequestHeaders` implementation.
 *
 * Bridges kosong's host-headers port to the host invocation args: the headers
 * are the ones the host stated in `BootstrapInput.args.requestHeaders`
 * (usually built through `createKimiDefaultHeaders`), exposed through
 * `IBootstrapService.args`. kosong's model catalog only sees the port. Bound
 * at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';

export class HostRequestHeadersAdapter implements IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    this.headers = bootstrap.args.requestHeaders;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostRequestHeaders,
  HostRequestHeadersAdapter,
  ScopeActivation.OnDemand,
  'kosongConfig',
);
