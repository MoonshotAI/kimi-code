/**
 * `swarm` domain (L4) — multi-agent swarm mode.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISwarmService {
  readonly _serviceBrand: undefined;
  readonly active: boolean;
  enter(): Promise<void>;
  exit(): void;
}

export const ISwarmService: ServiceIdentifier<ISwarmService> =
  createDecorator<ISwarmService>('swarmService');
