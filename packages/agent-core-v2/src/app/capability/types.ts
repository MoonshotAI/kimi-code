/**
 * `capability` domain types — built-in product capabilities (kimi-cu,
 * kimi-webbridge) that bundle a binary runtime + agent wiring + manual
 * user steps. A capability is NOT a plugin: plugins are declarative
 * contributions to a session, while capabilities own imperative install
 * orchestration and a layered readiness state machine for product-specific
 * runtimes (macOS app + launchd service + TCC permissions; local HTTP
 * daemon + browser extension). Steps marked `optional` never block
 * `ready`; `install.note` is a machine key clients localize.
 */

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
}

export interface CapabilityDetectResult {
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
}

export interface CapabilityStatus {
  readonly id: CapabilityId;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly state: CapabilityReadiness;
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
  readonly install: CapabilityInstallProgress;
}

export type CapabilityInstallReporter = (step: string, percent?: number) => void;

export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  detect(): Promise<CapabilityDetectResult>;
  install(report: CapabilityInstallReporter): Promise<void>;
}
