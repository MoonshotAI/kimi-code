import { collection } from '#/_base/di/collection';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { LifecycleScope } from '#/app/scopes';

export interface ContributedFeatureService {
  readonly scope: LifecycleScope;
  readonly id: ServiceIdentifier<unknown>;
}

export const FeatureServiceContribution = collection<ContributedFeatureService>(
  'feature-service',
  {
    validate(value, existing) {
      if (existing.some((entry) => entry.scope === value.scope && entry.id === value.id)) {
        throw new Error(
          `Service ${String(value.id)} is already contributed at scope ${value.scope}`,
        );
      }
    },
  },
);
