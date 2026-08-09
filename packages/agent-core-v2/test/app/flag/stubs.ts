/**
 * `flag` test stubs — minimal `IFlagService` for unit tests.
 *
 * Lives under `test/` (not `src/`). Import from a relative path.
 */

import { IFlagService } from '#/app/flag/flag';
import type {
  ExperimentalFeatureState,
  ExperimentalFlagConfig,
  ExperimentalFlagMap,
} from '#/app/flag/flag';
import type { IFlagRegistry } from '#/app/flag/flagRegistry';

export function stubFlag(enabled: boolean | ((id: string) => boolean) = false): IFlagService {
  const isEnabled = typeof enabled === 'function' ? enabled : (): boolean => enabled;
  const registry: IFlagRegistry = {
    _serviceBrand: undefined,
    register: () => ({ dispose: () => {} }),
    get: () => undefined,
    list: () => [],
  };
  return {
    _serviceBrand: undefined,
    registry,
    enabled: isEnabled,
    snapshot: (): ExperimentalFlagMap => ({}),
    enabledIds: () => [],
    explain: (): ExperimentalFeatureState | undefined => undefined,
    explainAll: () => [],
    setConfigOverrides: (_overrides: ExperimentalFlagConfig | undefined) => {},
  };
}
