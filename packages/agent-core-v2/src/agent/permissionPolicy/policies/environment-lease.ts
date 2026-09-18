import type { EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';

export function acquireEnvironmentLease(
  environment: IAgentEnvironmentService,
): EnvironmentLease | undefined {
  try {
    return environment.acquire();
  } catch (error) {
    if (error instanceof EnvironmentError) return undefined;
    throw error;
  }
}
