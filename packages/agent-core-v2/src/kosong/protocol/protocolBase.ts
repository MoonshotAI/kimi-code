/**
 * `kosong/protocol` domain (L1) — protocol base identity, definition, and
 * the module-level base registry.
 *
 * A protocol base is the component that actually understands one wire
 * format: it implements `ChatProvider` and exposes a `hooks?` option through
 * which composed traits flow in. The base itself never knows this registry
 * exists — registration happens in the L2 `*.contrib.ts` side-effect
 * modules, and composition happens inside the contrib factories.
 *
 * This module only holds the data structures and the registry functions; it
 * deliberately registers nothing on its own.
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { ChatProvider } from '#/kosong/contract/provider';

import type { Protocol, ProtocolAdapterConfig } from './protocol';
import type { ResolvedTrait } from './protocolTrait';

/**
 * Identifies a registered protocol base. One base serves one wire protocol
 * today, so the id is simply the protocol it speaks; the alias keeps call
 * sites honest about which side of the relationship they mean.
 */
export type ProtocolBaseId = Protocol;

/**
 * What a contrib factory receives from the adapter registry when it is asked
 * to construct a provider: the adapter config, plus the resolved traits for
 * the (protocol, providerType) pair with their contexts already bound. The
 * factory aggregates the construction-time declarations (endpoint, headers,
 * `provides`), composes the hook set, and bakes both into the base's
 * options.
 */
export interface ProtocolBaseContext {
  readonly config: ProtocolAdapterConfig;
  readonly traits: readonly ResolvedTrait[];
}

export interface ProtocolBaseDefinition {
  readonly id: ProtocolBaseId;
  /**
   * The base's own capability catalog — the final fallback of capability
   * resolution (definition → traits → base). Absent or `undefined` means the
   * base knows nothing about the model.
   */
  capability?(modelName: string): ModelCapability | undefined;
  createChatProvider(context: ProtocolBaseContext): ChatProvider;
}

/**
 * The resolved answer to "which base + which traits serve this
 * (protocol, providerType) pair" — the L1 shape returned by
 * `IProtocolAdapterRegistry.resolveAdapterIdentity`.
 */
export interface ResolvedAdapterIdentity {
  readonly baseId: ProtocolBaseId;
  readonly traits: readonly ResolvedTrait[];
}

const protocolBases = new Map<ProtocolBaseId, ProtocolBaseDefinition>();

/**
 * Register a protocol base. Called only from L2 `*.contrib.ts` side-effect
 * modules at import time. Duplicate registration of the same id is a
 * programming error and throws — silently overwriting a base would make
 * composed providers depend on import order.
 */
export function registerProtocolBase(definition: ProtocolBaseDefinition): void {
  if (protocolBases.has(definition.id)) {
    throw new Error(`protocol base '${definition.id}' is already registered`);
  }
  protocolBases.set(definition.id, definition);
}

export function getProtocolBase(id: ProtocolBaseId): ProtocolBaseDefinition | undefined {
  return protocolBases.get(id);
}

/**
 * All registered bases in registration order. `supportedProtocols()` on the
 * adapter registry is derived from this list.
 */
export function listProtocolBases(): readonly ProtocolBaseDefinition[] {
  return [...protocolBases.values()];
}
