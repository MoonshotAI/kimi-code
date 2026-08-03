/**
 * Service dispatch table for the rust transport. Service groups register
 * their method tables under their service name (`registerService`); the
 * channel resolves `(service, method)` through it. Unknown services/methods
 * surface the same RPC error the v2 dispatcher used for them.
 */

import { RPCError } from '../../core/errors.js';
import type { RustCallContext, RustServiceRegistry } from './types.js';

/** Mirrors the v2 dispatcher's unknown-service / unknown-method codes. */
const REQUEST_INVALID = 40001;

const registries = new Map<string, RustServiceRegistry>();

/** Register (or replace) a service's method table. */
export function registerService(service: string, impl: RustServiceRegistry): void {
  registries.set(service, impl);
}

/** Resolve a service's method table, or `undefined` when unknown. */
export function resolveService(service: string): RustServiceRegistry | undefined {
  return registries.get(service);
}

/** Dispatch one `(service, method)` call through the registered tables. */
export async function dispatchCall(
  service: string,
  method: string,
  ctx: RustCallContext,
): Promise<unknown> {
  const impl = resolveService(service)?.[method];
  if (impl === undefined) {
    throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
  }
  return impl(ctx);
}
