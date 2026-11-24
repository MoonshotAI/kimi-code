import type { Event } from '#/_base/event';
import { IFlagService } from '#/app/flag/flag';
import type {
  ExperimentalFeatureState,
  ExperimentalFlagConfig,
  ExperimentalFlagMap,
} from '#/app/flag/flag';
import type { IFlagRegistry } from '#/app/flag/flagRegistry';

export function stubFlag(
  enabled: boolean | ((id: string) => boolean) = false,
  onDidChange: Event<void> = () => ({ dispose: () => {} }),
): IFlagService {
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
    onDidChange,
    enabled: isEnabled,
    snapshot: (): ExperimentalFlagMap => ({}),
    enabledIds: () => [],
    exposedIds: () => [],
    explain: (): ExperimentalFeatureState | undefined => undefined,
    explainAll: () => [],
    setConfigOverrides: (_overrides: ExperimentalFlagConfig | undefined) => {},
  };
}
