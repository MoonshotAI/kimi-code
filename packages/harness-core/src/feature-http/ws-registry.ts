import { createFacadeToken } from '@moonshot-ai/agent-core/kernel/index';

export interface WsRegistryEntry {
  readonly id: string;
  readonly connectedAt: string;
  readonly subscriptions: readonly string[];
  readonly agents: Record<string, Record<string, string>>;
  readonly protocol?: string;
  readonly hasClientHello?: boolean;
  readonly remoteAddress?: string;
  readonly userAgent?: string;
}

export interface WsRegistry {
  list(): readonly WsRegistryEntry[];
}

export const WsRegistryRef = createFacadeToken<WsRegistry>('http.wsRegistry');

export interface WsRegistrySource {
  readonly id: string;
  readonly connectedAt: string;
  readonly protocol: 'native' | 'kap-v1';
  readonly remoteAddress?: string;
  readonly userAgent?: string;
  subscriptions(): readonly string[];
  agents(): Record<string, Record<string, string>>;
  hasClientHello?(): boolean;
}

export interface WsRegistryStore extends WsRegistry {
  add(source: WsRegistrySource): () => void;
}

export function createWsRegistry(): WsRegistryStore {
  const sources = new Map<string, WsRegistrySource>();
  return {
    add: (source) => {
      sources.set(source.id, source);
      return () => {
        sources.delete(source.id);
      };
    },
    list: () =>
      [...sources.values()].map((source) => ({
        id: source.id,
        connectedAt: source.connectedAt,
        subscriptions: source.subscriptions(),
        agents: source.agents(),
        protocol: source.protocol,
        hasClientHello: source.hasClientHello?.(),
        remoteAddress: source.remoteAddress,
        userAgent: source.userAgent,
      })),
  };
}
