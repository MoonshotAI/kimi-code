/**
 * `plan` domain (L4) — plan-mode state machine.
 *
 * Defines the public contract of plan mode: the `IPlanService` used to enter,
 * cancel, exit, and clear plan mode and to query whether it is active.
 * Agent-scoped — one instance per agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IPlanService {
  readonly _serviceBrand: undefined;
  readonly active: boolean;
  enter(): Promise<void>;
  cancel(): void;
  exit(): Promise<void>;
  clear(): void;
}

export const IPlanService: ServiceIdentifier<IPlanService> =
  createDecorator<IPlanService>('planService');
