import type { ClientIdentity, CredentialStore, Tracer } from '../contracts';
import { DaemonKimiWebApi } from './daemon/client';
import { HostRouter } from './hostRouting';
import type { KimiWebApi } from './types';

export interface CreateKimiWebApiDeps {
  origin: string;
  identity: ClientIdentity;
  tracer: Tracer;
  credentialStore: CredentialStore;
}

export function createKimiWebApi(deps: CreateKimiWebApiDeps): KimiWebApi {
  const clientFor = (origin: string, includeHosts = false): DaemonKimiWebApi =>
    new DaemonKimiWebApi({
      origin,
      identity: deps.identity,
      tracer: deps.tracer,
      credentialStore: deps.credentialStore,
      includeHosts,
    });
  return new HostRouter(clientFor(deps.origin, true), (hostId) =>
    clientFor(`${deps.origin}/api/v1/hosts/${encodeURIComponent(hostId)}/proxy`),
  ).createApi();
}
