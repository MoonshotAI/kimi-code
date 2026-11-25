import type { ClientIdentity, CredentialStore, Tracer } from '../contracts';
import { DaemonKimiWebApi } from './daemon/client';
import { DeviceRouter } from './deviceRouting';
import type { KimiWebApi } from './types';

export interface CreateKimiWebApiDeps {
  origin: string;
  identity: ClientIdentity;
  tracer: Tracer;
  credentialStore: CredentialStore;
}

export function createKimiWebApi(deps: CreateKimiWebApiDeps): KimiWebApi {
  const clientFor = (origin: string, includeDevices = false): DaemonKimiWebApi =>
    new DaemonKimiWebApi({
      origin,
      identity: deps.identity,
      tracer: deps.tracer,
      credentialStore: deps.credentialStore,
      includeDevices,
    });
  return new DeviceRouter(clientFor(deps.origin, true), (deviceId) =>
    clientFor(`${deps.origin}/api/v1/devices/${encodeURIComponent(deviceId)}/proxy`),
  ).createApi();
}
