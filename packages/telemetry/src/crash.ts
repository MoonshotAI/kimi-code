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
  const recordedRejections = new Set<unknown>();
  const trackCrash = (errorType: string, source: string) => {
    try {
      client.track('crash', {
        error_type: errorType,
        where: phase,
        source,
      });
      client.flushSync();
    } catch {}
  };
  installedUncaughtHandler = (error, origin) => {
    if (isAbortError(error)) return;
    if (recordedRejections.has(error)) return;
    trackCrash(crashErrorType(error), origin);
  };
  process.on('uncaughtExceptionMonitor', installedUncaughtHandler);
  installedRejectionHandler = (reason: unknown) => {
    const soleListener = process.listenerCount('unhandledRejection') === 1;
    if (!isAbortError(reason)) {
      trackCrash(crashErrorType(reason), 'unhandledRejection');
      recordedRejections.add(reason);
    }
    if (soleListener && !isAbortError(reason)) {
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
