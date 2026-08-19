import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

/**
 * Session-local handoff of opaque skill payloads (`SkillDefinition.data`)
 * from an activation to in-process consumers, keyed by activation id. The
 * data deliberately stays out of message provenance, durable records, and
 * wire events: it never persists and never leaves the process.
 */
export interface ISkillActivationDataService {
  readonly _serviceBrand: undefined;

  put(activationId: string, data: unknown): void;
  take(activationId: string): unknown;
}

export const ISkillActivationDataService: ServiceIdentifier<ISkillActivationDataService> =
  createDecorator<ISkillActivationDataService>('skillActivationData');

const MAX_ENTRIES = 32;

export class SkillActivationDataService extends Disposable implements ISkillActivationDataService {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, unknown>();

  put(activationId: string, data: unknown): void {
    if (data === undefined) return;
    this.entries.set(activationId, data);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  take(activationId: string): unknown {
    const data = this.entries.get(activationId);
    this.entries.delete(activationId);
    return data;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISkillActivationDataService,
  SkillActivationDataService,
  ScopeActivation.OnDemand,
  'skillActivationData',
);
