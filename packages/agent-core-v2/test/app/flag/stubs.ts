import { Event } from '#/_base/event';
import { IFlagService } from '#/app/flag/flag';
import type {
  BetaMasterSwitchState,
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
    profile: 'cli',
    onDidChangeFlags: Event.None as Event<void>,
    betaState: (): BetaMasterSwitchState => ({
      profile: 'cli',
      enabled: false,
      source: 'default',
      env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
    }),
    enabled: isEnabled,
    snapshot: (): ExperimentalFlagMap => ({}),
    enabledIds: () => [],
    exposedIds: () => [],
    explain: (): ExperimentalFeatureState | undefined => undefined,
    explainAll: () => [],
    setConfigOverrides: (_overrides: ExperimentalFlagConfig | undefined) => {},
  };
}
