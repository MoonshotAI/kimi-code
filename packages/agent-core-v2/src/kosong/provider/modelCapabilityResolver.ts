/**
 * `kosong/provider` domain (L2) — extension point for capability sources
 * owned by higher layers. Resolvers run after protocol traits but before
 * protocol-base static catalogs. Registration returns a disposable so tests
 * and embedding hosts can restore process-global state.
 */

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type {
  CapabilityResolutionContext,
  ExplainedCapability,
  Protocol,
} from '#/kosong/protocol/protocol';

export interface ModelCapabilityQuery extends CapabilityResolutionContext {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly modelName: string;
}

export type ModelCapabilityResolver = (
  query: ModelCapabilityQuery,
) => ExplainedCapability | undefined;

const resolvers: ModelCapabilityResolver[] = [];

export function registerModelCapabilityResolver(
  resolver: ModelCapabilityResolver,
): IDisposable {
  resolvers.push(resolver);
  return toDisposable(() => {
    const index = resolvers.lastIndexOf(resolver);
    if (index >= 0) resolvers.splice(index, 1);
  });
}

export function explainRegisteredModelCapability(
  query: ModelCapabilityQuery,
): ExplainedCapability | undefined {
  for (let index = resolvers.length - 1; index >= 0; index -= 1) {
    const explained = resolvers[index]?.(query);
    if (explained !== undefined) return explained;
  }
  return undefined;
}
