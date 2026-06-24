/**
 * `plan` domain (L4) — plan-mode state machine.
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
