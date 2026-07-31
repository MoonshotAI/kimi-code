/**
 * `kosong/model` domain — host-provided default headers for outbound
 * provider requests.
 *
 * The host (CLI / server) builds the full Kimi identity headers (`User-Agent`
 * + `X-Msh-*`) and seeds them here. Defaults to empty so non-host contexts
 * (tests, embedders) send no extra headers.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
  type ScopeSeed,
} from '#/_base/di/scope';

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
  ScopeActivation.OnScopeCreated,
  'model',
);
