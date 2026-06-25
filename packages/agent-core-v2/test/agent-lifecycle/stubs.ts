/**
 * `agent-lifecycle` test stubs — shared `IAgentLifecycleService` placeholder.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../agent-lifecycle/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';

/**
 * Register an empty `IAgentLifecycleService` placeholder. Tests that need a
 * lifecycle service with handles should register a custom fake via
 * `additionalServices` instead.
 */
export function registerAgentLifecycleServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(IAgentLifecycleService, {});
}
