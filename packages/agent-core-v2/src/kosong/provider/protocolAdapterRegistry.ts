/**
 * `kosong/provider` domain (L2) — the single production implementation of
 * `IProtocolAdapterRegistry`.
 *
 * This is the one resolution point for "(protocol, providerType) → which base
 * + which traits" and the single construction point for composed
 * ChatProviders:
 *
 *  - `resolveAdapterIdentity` — the three branches: unregistered vendor (or
 *    none) → the protocol itself as base with no vendor traits; a definition
 *    whose base matches the protocol → its native traits; a definition running
 *    over a foreign transport → only its `dialects[protocol]` slice. The
 *    config `defaultHeaders` synthetic trait is ALWAYS appended last, so
 *    config headers win header aggregation; it declares no per-request hooks,
 *    so it can never shadow a real dialect hook in composition.
 *  - `createChatProvider` — re-binds every resolved trait's context to the
 *    full adapter config (identity resolution knows only
 *    `(protocol, providerType)`; composition needs the real config) and
 *    delegates to the registered base's contrib factory.
 *  - `resolveCapability` — the fixed fallback chain: definition → trait
 *    capability hooks (last declarer wins) → the base's own catalog →
 *    `UNKNOWN_CAPABILITY`.
 *
 * Bound at App scope, eager.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ModelCapability } from '#/kosong/contract/capability';
import { ChatProviderError } from '#/kosong/contract/errors';
import type { ChatProvider } from '#/kosong/contract/provider';
import {
  IProtocolAdapterRegistry,
  type Protocol,
  type ProtocolAdapterConfig,
} from '#/kosong/protocol/protocol';
import {
  getProtocolBase,
  listProtocolBases,
  type ProtocolBaseId,
  type ResolvedAdapterIdentity,
} from '#/kosong/protocol/protocolBase';
import type { ProtocolTrait, ResolvedTrait, TraitContext } from '#/kosong/protocol/protocolTrait';

import { getProviderDefinition } from './providerDefinition';

/**
 * The trailing synthetic trait that lets config `defaultHeaders` win: it is
 * appended after every vendor trait so its headers merge last in
 * `traitDefaultHeaders` aggregation. It declares nothing else — composition
 * (which picks the last `withThinking` declarer, etc.) is unaffected.
 */
const CONFIG_DEFAULT_HEADERS_TRAIT: ProtocolTrait = {
  defaultHeaders: (ctx) =>
    ctx.config.defaultHeaders === undefined ? undefined : { ...ctx.config.defaultHeaders },
};

export class ProtocolAdapterRegistry implements IProtocolAdapterRegistry {
  declare readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[] {
    return listProtocolBases().map((base) => base.id);
  }

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity {
    const definition = providerType === undefined ? undefined : getProviderDefinition(providerType);
    let baseId: ProtocolBaseId;
    let traits: readonly ProtocolTrait[];
    if (definition === undefined) {
      baseId = protocol;
      traits = [];
    } else if (definition.base === protocol) {
      baseId = definition.base;
      traits = definition.traits;
    } else {
      baseId = protocol;
      traits = definition.dialects?.[protocol] ?? [];
    }

    // Identity resolution has no live adapter config, so contexts are bound
    // to a stub here; `createChatProvider` re-binds them to the real config
    // before composition.
    const context: TraitContext = {
      config: { protocol, providerType, modelName: '' },
      providerId: providerType,
    };
    const resolved: ResolvedTrait[] = traits.map((trait) => ({ trait, context }));
    resolved.push({ trait: CONFIG_DEFAULT_HEADERS_TRAIT, context });
    return { baseId, traits: resolved };
  }

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId {
    const definition = providerType === undefined ? undefined : getProviderDefinition(providerType);
    if (definition !== undefined && definition.base === protocol) {
      return definition.base;
    }
    return protocol;
  }

  resolveCapability(protocol: Protocol, modelName: string, providerType?: string): ModelCapability {
    const definition = providerType === undefined ? undefined : getProviderDefinition(providerType);
    if (definition?.capability !== undefined) {
      return definition.capability;
    }

    const identity = this.resolveAdapterIdentity(protocol, providerType);
    let traitCapability: ModelCapability | undefined;
    for (const { trait, context } of identity.traits) {
      if (trait.capability === undefined) continue;
      const capability = trait.capability(modelName, context);
      if (capability !== undefined) {
        traitCapability = capability;
      }
    }
    if (traitCapability !== undefined) {
      return traitCapability;
    }

    return getProtocolBase(identity.baseId)?.capability?.(modelName) ?? UNKNOWN_CAPABILITY;
  }

  createChatProvider(config: ProtocolAdapterConfig): ChatProvider {
    const identity = this.resolveAdapterIdentity(config.protocol, config.providerType);
    const traits: ResolvedTrait[] = identity.traits.map(({ trait }) => ({
      trait,
      context: { config, providerId: config.providerType },
    }));
    const base = getProtocolBase(identity.baseId);
    if (base === undefined) {
      throw new ChatProviderError(
        `No protocol base registered for '${identity.baseId}'. Import the base's contrib module first.`,
      );
    }
    return base.createChatProvider({ config, traits });
  }
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  InstantiationType.Eager,
  'provider',
);
