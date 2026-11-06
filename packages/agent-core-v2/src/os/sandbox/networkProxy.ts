

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type EgressDecision = 'allow' | 'deny';

export type EgressDecider = (
  host: string,
  protocol: 'http' | 'connect' | 'socks5',
) => EgressDecision | Promise<EgressDecision>;

export interface NetworkProxyRegistration {
  readonly token: string;
  readonly httpPort: number;
  readonly socksPort: number;

  readonly env: Record<string, string>;
  dispose(): void;
}

export interface INetworkProxyService {
  readonly _serviceBrand: undefined;

  acquire(decide: EgressDecider): Promise<NetworkProxyRegistration | undefined>;

  release(token: string): void;
}

export const INetworkProxyService: ServiceIdentifier<INetworkProxyService> =
  createDecorator<INetworkProxyService>('networkProxyService');
