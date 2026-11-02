import type { EnvironmentAccess, EnvironmentCapability, EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';

export function acquireEnvironmentLease(
  environment: EnvironmentAccess,
  required: readonly EnvironmentCapability[] = [],
): EnvironmentLease | undefined {
  try {
    return environment.acquire(required);
  } catch (error) {
    if (error instanceof EnvironmentError) return undefined;
    throw error;
  }
}
