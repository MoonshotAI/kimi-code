import type { EnvironmentCapability, EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';

export function acquireEnvironmentLease(
  environment: IAgentEnvironmentService,
  required: readonly EnvironmentCapability[] = [],
): EnvironmentLease | undefined {
  try {
    return environment.acquire(required);
  } catch (error) {
    if (error instanceof EnvironmentError) return undefined;
    throw error;
  }
}
