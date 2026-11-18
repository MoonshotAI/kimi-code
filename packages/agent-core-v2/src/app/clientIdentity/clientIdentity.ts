import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService, type ScopeSeed } from '#/_base/di/scope';
import { BugIndicatingError } from '#/_base/errors/errors';
import { IBootstrapService, type HostUiCapability } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import type { SessionClientIdentity } from '#/session/clientIdentity/sessionClientIdentity';

export interface IClientIdentity extends SessionClientIdentity {
  readonly _serviceBrand: undefined;
  readonly requestHeaders: Readonly<Record<string, string>>;
}

export const IClientIdentity: ServiceIdentifier<IClientIdentity> =
  createDecorator<IClientIdentity>('clientIdentity');

export class HostClientIdentity implements IClientIdentity {
  declare readonly _serviceBrand: undefined;

  constructor(@IBootstrapService private readonly bootstrap: IBootstrapService) {}

  get productName(): string {
    return this.bootstrap.clientIdentity.productName;
  }

  get version(): string {
    return this.bootstrap.clientIdentity.version;
  }

  get platform(): string {
    return this.bootstrap.clientIdentity.platform;
  }

  get userAgentSuffix(): string | undefined {
    return this.bootstrap.clientIdentity.userAgentSuffix;
  }

  get displayName(): string | undefined {
    return this.bootstrap.args.displayName;
  }

  get replyStyleGuide(): string | undefined {
    return this.bootstrap.args.replyStyleGuide;
  }

  get uiCapabilities(): readonly HostUiCapability[] | undefined {
    return this.bootstrap.args.uiCapabilities;
  }

  get requestHeaders(): Readonly<Record<string, string>> {
    return this.bootstrap.args.requestHeaders;
  }
}

registerScopedService(
  LifecycleScope.App,
  IClientIdentity,
  HostClientIdentity,
  ScopeActivation.OnDemand,
  'clientIdentity',
);

const clientIdentityScopedServices = new Map<ServiceIdentifier<unknown>, SyncDescriptor<unknown>>();

export function registerClientIdentityScopedService<T>(
  id: ServiceIdentifier<T>,
  ctor: new (...args: never[]) => T,
): void {
  if (clientIdentityScopedServices.has(id)) {
    throw new BugIndicatingError(
      `duplicate client identity scoped service registration for '${String(id)}'`,
    );
  }
  clientIdentityScopedServices.set(id, new SyncDescriptor<unknown>(ctor));
}

export function clientIdentityScopedServiceSeed(): ScopeSeed {
  return [...clientIdentityScopedServices];
}
