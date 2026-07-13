/**
 * `faultInjection` domain (L4) — `IFaultInjectionService` implementation.
 *
 * Agent-scope one-shot latch: `arm` (flag-gated) stores the next fault,
 * `take` (the llmRequester's per-attempt consumption point) consumes and
 * records it. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IFlagService } from '#/app/flag/flag';
import { ErrorCodes, Error2 } from '#/errors';

import { FAULT_INJECTION_FLAG_ID } from './flag';
import {
  IFaultInjectionService,
  type FaultInjectionStatus,
  type FaultKind,
} from './faultInjection';

export class FaultInjectionService implements IFaultInjectionService {
  declare readonly _serviceBrand: undefined;

  private armed: FaultKind | undefined;
  private readonly fired: FaultKind[] = [];

  constructor(@IFlagService private readonly flags: IFlagService) {}

  arm(kind: FaultKind): void {
    if (!this.flags.enabled(FAULT_INJECTION_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Fault injection is disabled; enable the fault-injection experimental flag ' +
          '(KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION=1, the master flag, or the ' +
          '[experimental] config section).',
      );
    }
    this.armed = kind;
  }

  status(): FaultInjectionStatus {
    return { armed: this.armed, fired: [...this.fired] };
  }

  clear(): void {
    this.armed = undefined;
    this.fired.length = 0;
  }

  take(): FaultKind | undefined {
    const kind = this.armed;
    if (kind === undefined) return undefined;
    this.armed = undefined;
    this.fired.push(kind);
    return kind;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IFaultInjectionService,
  FaultInjectionService,
  InstantiationType.Delayed,
  'faultInjection',
);
