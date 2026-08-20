export type CapabilityId = 'kimi-cu' | 'kimi-webbridge';

export type CapabilityReadiness = 'not_installed' | 'partial' | 'ready' | 'unsupported';

export type CapabilityStepState = 'ok' | 'missing' | 'failed';

export interface CapabilityStep {
  readonly id: string;
  readonly state: CapabilityStepState;
  readonly detail?: string;
  readonly optional?: boolean;
}

export interface CapabilityInstallProgress {
  readonly running: boolean;
  readonly step?: string;
  readonly percent?: number;
  readonly error?: string;
  readonly note?: string;
}

export interface CapabilityDetectResult {
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
}

export interface CapabilityStatus {
  readonly id: CapabilityId;
  /** Plugin identifier used to provide this capability's agent wiring. */
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly state: CapabilityReadiness;
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
  readonly install: CapabilityInstallProgress;
}

export type CapabilityInstallReporter = (step: string, percent?: number) => void;

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
}

export interface CapabilityInstallChange {
  readonly id: CapabilityId;
  readonly install: CapabilityInstallProgress;
}

export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  detect(): Promise<CapabilityDetectResult>;
  install(report: CapabilityInstallReporter): Promise<string | undefined>;
}
