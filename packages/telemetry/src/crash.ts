import { getDefaultTelemetryClient, type TelemetryClient } from './client';

export type CrashPhase = 'startup' | 'runtime' | 'shutdown';

let phase: CrashPhase = 'startup';
let installed = false;
let installedUncaughtHandler:
  | ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void)
  | null = null;
let installedRejectionHandler: ((reason: unknown) => void) | null = null;

export function setCrashPhase(nextPhase: CrashPhase): void {
  phase = nextPhase;
}

export function installCrashHandlers(): () => void {
  return installCrashHandlersForClient(getDefaultTelemetryClient());
}

export function installCrashHandlersForClient(client: TelemetryClient): () => void {
  if (installed && installedUncaughtHandler !== null && installedRejectionHandler !== null) {
    return () => {
      uninstallCrashHandlers();
    };
  }
  // Rejections recorded by the rejection handler below and then rethrown to
  // preserve Node's default crash; the monitor must not report them twice.
  // A Set (not WeakSet) so primitive reasons dedupe by value too.
  const recordedRejections = new Set<unknown>();
  const trackCrash = (errorType: string, source: string) => {
    try {
      client.track('crash', {
        error_type: errorType,
        where: phase,
        source,
      });
      client.flushSync();
    } catch {
      // Crash telemetry must never mask the original exception.
    }
  };
  installedUncaughtHandler = (error, origin) => {
    if (isAbortError(error)) return;
    if (recordedRejections.has(error)) return;
    // `error` is typed Error but can be anything a rejection rethrow sent
    // through (primitives, null) — classify it null-safely.
    trackCrash(crashErrorType(error), origin);
  };
  process.on('uncaughtExceptionMonitor', installedUncaughtHandler);
  // `uncaughtExceptionMonitor` never fires for a rejection that has a
  // listener — and the TUI always registers one, converting the rejection
  // into a silent exit(1) with no telemetry at all. Observe rejections
  // directly so those crashes still leave a trace. Registering a real
  // listener suppresses Node's default crash-on-rejection, so when we are
  // the only listener (print / server modes) rethrow to preserve it; the
  // dedupe set above keeps the monitor from double-reporting that path.
  installedRejectionHandler = (reason: unknown) => {
    const soleListener = process.listenerCount('unhandledRejection') === 1;
    if (!isAbortError(reason)) {
      trackCrash(crashErrorType(reason), 'unhandledRejection');
      recordedRejections.add(reason);
    }
    if (soleListener) {
      throw reason;
    }
  };
  process.on('unhandledRejection', installedRejectionHandler);
  installed = true;
  return () => {
    uninstallCrashHandlers();
  };
}

export function uninstallCrashHandlers(): void {
  if (!installed) return;
  if (installedUncaughtHandler !== null) {
    process.off('uncaughtExceptionMonitor', installedUncaughtHandler);
  }
  if (installedRejectionHandler !== null) {
    process.off('unhandledRejection', installedRejectionHandler);
  }
  installedUncaughtHandler = null;
  installedRejectionHandler = null;
  installed = false;
}

function crashErrorType(reason: unknown): string {
  if (reason instanceof Error) return reason.name || reason.constructor.name;
  return typeof reason;
}

function isAbortError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'AbortError'
  );
}
