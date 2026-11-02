export interface TelemetryShutdownDeadline {
  readonly expiresAtMs: number;
  remainingMs(): number;
  run(pipeline: (remainingMs: number) => Promise<void>): Promise<void>;
}

const TELEMETRY_SHUTDOWN_WARNING_PREFIX = 'Warning: telemetry shutdown failed:';

export function formatTelemetryShutdownWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${TELEMETRY_SHUTDOWN_WARNING_PREFIX} ${message}\n`;
}

/**
 * One process-exit budget shared by every telemetry pipeline owned by a CLI
 * entrypoint. Pipelines remain independent: each receives the current budget,
 * and a failure never prevents the next owner from attempting its cleanup.
 */
export function createTelemetryShutdownDeadline(
  timeoutMs: number,
  onError: (error: unknown) => void,
  now: () => number = Date.now,
): TelemetryShutdownDeadline {
  const expiresAtMs = now() + timeoutMs;
  const remainingMs = (): number => Math.max(0, expiresAtMs - now());
  return {
    expiresAtMs,
    remainingMs,
    run: async (pipeline) => {
      const budgetMs = remainingMs();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pipeline(budgetMs),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Telemetry shutdown timed out')), budgetMs);
          }),
        ]);
      } catch (error) {
        try {
          onError(error);
        } catch {
          // A broken stderr/logger boundary must not block later cleanup.
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
