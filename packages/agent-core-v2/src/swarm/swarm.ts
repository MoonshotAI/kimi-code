/**
 * `swarm` domain (L4) — multi-agent swarm mode.
 *
 * Defines the public contract of swarm mode: the `ISwarmService` used to enter
 * and exit swarm mode and to query whether it is active. Agent-scoped — one
 * instance per agent.
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
