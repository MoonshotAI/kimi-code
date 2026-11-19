export type SleepPreventionMode = 'allow-sleep' | 'prevent-app-suspension' | 'prevent-display-sleep';

export function isSleepPreventionMode(value: unknown): value is SleepPreventionMode {
  return value === 'allow-sleep' || value === 'prevent-app-suspension' || value === 'prevent-display-sleep';
}

export interface PreventSleepState {
  system: SleepPreventionMode;
  lid: boolean;
  lidSupported: boolean;
  lidNeedsRepair?: boolean;
}
