import type { IProtocolAdapterRegistry, Protocol } from '../protocol/protocol';
import { getProviderDefinitions } from '../provider/provider-definition';

export interface ThinkingConfig {
  enabled?: boolean;
  effort?: string;
  forcedEffort?: string;
  keep?: string;
}

export function drivesThinkingThroughTraits(providerType: string | undefined): boolean {
  if (providerType === undefined) return false;
  return getProviderDefinitions(providerType).some(
    (definition) => definition.thinkingDriven === true,
  );
}

export function usesTraitDrivenThinking(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  return registry.resolveAdapterIdentity(protocol, providerType).thinkingDriven === true;
}

export function requiresStrictThinkingValidation(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  if (providerType === undefined) return false;
  return registry.resolveAdapterIdentity(protocol, providerType).strictThinkingValidation === true;
}

export function wireHasProtocolThinkingDisable(protocol: string | undefined): boolean {
  return protocol === 'anthropic' || protocol === 'kimi';
}
