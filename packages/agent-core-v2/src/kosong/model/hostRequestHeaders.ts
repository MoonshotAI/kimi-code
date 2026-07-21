/**
 * `kosong/model` domain (L2) — host-provided default headers for outbound
 * provider requests.
 *
 * Mirrors v1's `kimiRequestHeaders`: the host (CLI / server) builds the full
 * Kimi identity headers (`User-Agent` + `X-Msh-*`) through
 * `createKimiDefaultHeaders` and seeds them here. `ModelCatalog` merges them
 * per vendor — the full set for vendors whose definition declares
 * `hostHeaders: 'full'`, only the `User-Agent` for everyone else (so device
 * identity never leaks to third-party endpoints). Defaults to empty so
 * non-host contexts (tests, embedders) send no extra headers.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService, type ScopeSeed } from '#/_base/di/scope';

export interface IHostRequestHeaders {
  readonly headers: Readonly<Record<string, string>>;
}

export const IHostRequestHeaders = createDecorator<IHostRequestHeaders>('hostRequestHeaders');

export class HostRequestHeaders implements IHostRequestHeaders {
  constructor(readonly headers: Readonly<Record<string, string>> = {}) {}
}

export function hostRequestHeadersSeed(headers: Readonly<Record<string, string>>): ScopeSeed {
  return [[IHostRequestHeaders as ServiceIdentifier<unknown>, new HostRequestHeaders(headers)]];
}

registerScopedService(
  LifecycleScope.App,
  IHostRequestHeaders,
  HostRequestHeaders,
  InstantiationType.Eager,
  'model',
);
