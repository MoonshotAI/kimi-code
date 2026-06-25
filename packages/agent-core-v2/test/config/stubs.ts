/**
 * `config` test stubs — shared config collaborators for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../config/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IAgentConfigService, IConfigRegistry, IConfigService } from '#/config/config';
import { ConfigRegistry } from '#/config/configService';

/**
 * Register the default config collaborators: a real `ConfigRegistry` plus empty
 * `IConfigService` / `IAgentConfigService` placeholders. Tests exercising the
 * real `ConfigService` / `AgentConfigService` should override the placeholder
 * via `additionalServices`.
 */
export function registerConfigServices(reg: ServiceRegistration): void {
  reg.defineInstance(IConfigRegistry, new ConfigRegistry());
  reg.definePartialInstance(IConfigService, {});
  reg.definePartialInstance(IAgentConfigService, {});
}
