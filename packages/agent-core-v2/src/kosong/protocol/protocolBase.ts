import { BugIndicatingError } from '#/_base/errors/errors';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ChatProvider } from '#/kosong/contract/provider';

import type { Protocol, ProtocolAdapterConfig } from './protocol';
import type { ResolvedTrait } from './protocolTrait';

export type ProtocolBaseId = Protocol;

export interface ProtocolBaseContext {
  readonly config: ProtocolAdapterConfig;
  readonly traits: readonly ResolvedTrait[];
}

export interface ProtocolBaseDefinition {
  readonly id: ProtocolBaseId;
  capability?(modelName: string): ModelCapability | undefined;
  createChatProvider(context: ProtocolBaseContext): ChatProvider;
}

export interface ResolvedAdapterIdentity {
  readonly baseId: ProtocolBaseId;
  readonly traits: readonly ResolvedTrait[];
}

const protocolBases = new Map<ProtocolBaseId, ProtocolBaseDefinition>();

export function registerProtocolBase(definition: ProtocolBaseDefinition): void {
  if (protocolBases.has(definition.id)) {
    throw new BugIndicatingError(`protocol base '${definition.id}' is already registered`);
  }
  protocolBases.set(definition.id, definition);
}

export function getProtocolBase(id: ProtocolBaseId): ProtocolBaseDefinition | undefined {
  return protocolBases.get(id);
}

export function listProtocolBases(): readonly ProtocolBaseDefinition[] {
  return [...protocolBases.values()];
}
