import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import {
  IClientIdentity,
  registerClientIdentityScopedService,
} from '#/app/clientIdentity/clientIdentity';
import { IHostRequestHeaders } from '#/llm-adapter/model/host-request-headers';

export class HostRequestHeadersAdapter implements IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    @IClientIdentity client: IClientIdentity,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {
    this.headers = client.requestHeaders;
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
registerClientIdentityScopedService(IHostRequestHeaders, HostRequestHeadersAdapter);
