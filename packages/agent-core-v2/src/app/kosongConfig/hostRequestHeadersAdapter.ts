import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
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
