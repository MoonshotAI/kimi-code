import type {
  AuthManagedUsageResult,
  ParsedManagedUsage,
} from '@moonshot-ai/kimi-code-oauth';

import { isManagedUsageProvider } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';

export const MANAGED_USAGE_CACHE_TTL_MS = 60_000;
export const MANAGED_USAGE_POLL_INTERVAL_MS = 5 * 60_000;

export interface ManagedUsageResult {
  readonly usage?: ParsedManagedUsage;
  readonly error?: string;
}

export interface ManagedUsageControllerHost {
  readonly currentProvider: () => string | undefined;
  readonly load: (provider: string) => Promise<AuthManagedUsageResult>;
  readonly update: (usage: ParsedManagedUsage | null) => void;
}

export interface ManagedUsageControllerOptions {
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Owns managed-plan usage refreshes outside the synchronous footer renderer.
 * The cache is provider-scoped, de-duplicates concurrent reads, and discards
 * responses that land after the user has switched providers.
 */
export class ManagedUsageController {
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly pollIntervalMs: number;
  private observedProvider: string | undefined;
  private cachedUsage: ParsedManagedUsage | undefined;
  private lastAttemptProvider: string | undefined;
  private lastAttemptAt = 0;
  private inFlight:
    | { readonly provider: string; readonly promise: Promise<ManagedUsageResult> }
    | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;

  constructor(
    private readonly host: ManagedUsageControllerHost,
    options: ManagedUsageControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? MANAGED_USAGE_CACHE_TTL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? MANAGED_USAGE_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.pollTimer !== undefined) return;
    this.syncProvider();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  syncProvider(): void {
    const provider = this.host.currentProvider();
    if (provider === this.observedProvider) return;
    this.observedProvider = provider;
    this.invalidate();
    if (!isManagedUsageProvider(provider)) {
      this.host.update(null);
      return;
    }
    void this.refresh({ force: true });
  }

  async refresh(options: { readonly force?: boolean } = {}): Promise<ManagedUsageResult | undefined> {
    const provider = this.host.currentProvider();
    if (!isManagedUsageProvider(provider)) {
      this.host.update(null);
      return undefined;
    }

    if (
      options.force !== true &&
      provider === this.lastAttemptProvider &&
      this.now() - this.lastAttemptAt < this.cacheTtlMs
    ) {
      return this.cachedUsage === undefined ? undefined : { usage: this.cachedUsage };
    }

    if (this.inFlight?.provider === provider) return this.inFlight.promise;

    const generation = ++this.generation;
    this.lastAttemptProvider = provider;
    this.lastAttemptAt = this.now();
    const promise = this.load(provider, generation);
    this.inFlight = { provider, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = undefined;
    }
  }

  dispose(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.invalidate();
  }

  private invalidate(): void {
    this.generation += 1;
    this.cachedUsage = undefined;
    this.lastAttemptProvider = undefined;
    this.lastAttemptAt = 0;
  }

  private async load(provider: string, generation: number): Promise<ManagedUsageResult> {
    let result: AuthManagedUsageResult;
    try {
      result = await this.host.load(provider);
    } catch (error) {
      const failure = { error: formatErrorMessage(error) };
      this.applyFailure(provider, generation);
      return failure;
    }

    if (result.kind === 'error') {
      this.applyFailure(provider, generation);
      return { error: result.message };
    }

    const usage: ParsedManagedUsage = {
      summary: result.summary,
      limits: result.limits,
      extraUsage: result.extraUsage,
    };
    if (this.isCurrent(provider, generation)) {
      this.cachedUsage = usage;
      this.host.update(usage);
    }
    return { usage };
  }

  private applyFailure(provider: string, generation: number): void {
    if (!this.isCurrent(provider, generation)) return;
    this.cachedUsage = undefined;
    this.host.update(null);
  }

  private isCurrent(provider: string, generation: number): boolean {
    return generation === this.generation && this.host.currentProvider() === provider;
  }
}
