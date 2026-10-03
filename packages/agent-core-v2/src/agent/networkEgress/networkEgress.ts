

import {
  createDecorator,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import type { EgressDecision } from '#/os/sandbox/networkProxy';

export interface SandboxProxyEnvironment {
  readonly env: Record<string, string>;
  readonly httpPort: number;
  readonly socksPort: number;
  readonly token: string;
}

export interface INetworkEgressPolicy {
  readonly _serviceBrand: undefined;

  decide(host: string, protocol?: 'http' | 'connect' | 'socks5'): Promise<EgressDecision>;

  acquireProxyEnvironment(): Promise<SandboxProxyEnvironment | undefined>;
}

export const INetworkEgressPolicy: ServiceIdentifier<INetworkEgressPolicy> =
  createDecorator<INetworkEgressPolicy>('networkEgressPolicy');
