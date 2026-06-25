/**
 * Centralised reporting for unexpected, non-actionable errors. The pattern: listener
 * callbacks (registered via `Emitter.event(...)`) may throw; the Emitter
 * routes those exceptions through `onUnexpectedError` rather than swallowing
 * them silently or letting them bubble through `fire()`.
 *
 * **Startup-timing constraint (plan §4.5)**: the default handler intentionally
 * does NOT resolve `ILogService` at module-load time. At import time the DI
 * container is empty — touching `ILogService` would NPE. Instead, the default
 * stays as a plain `console.error` until the daemon's `startServer` later
 * calls `setUnexpectedErrorHandler(...)` with a logger-bound version (once
 * `ILogger` has been resolved from the accessor). Until that handoff,
 * exceptions routed here surface on stderr — visible but unstructured.
 */

export type UnexpectedErrorHandler = (err: unknown) => void;

/**
 * Default handler. NOTE: do not touch `ILogService` here — this module is
 * imported eagerly and the DI container has no logger registered at module-
 * load time. Falling back to `console.error` keeps startup safe.
 */
const defaultHandler: UnexpectedErrorHandler = (err) => {
  // eslint-disable-next-line no-console
  console.error('[unexpected]', err);
};

let currentHandler: UnexpectedErrorHandler = defaultHandler;

/**
 * Install a new global handler. Replaces any previously-installed handler.
 * `startServer` calls this once after the DI container is fully wired so
 * later exceptions route through `ILogService` instead of stderr.
 */
export function setUnexpectedErrorHandler(handler: UnexpectedErrorHandler): void {
  currentHandler = handler;
}

/**
 * Reset the global handler to the module-default `console.error` handler.
 * Primarily used by tests so a handler installed by one test does not leak
 * into the next.
 */
export function resetUnexpectedErrorHandler(): void {
  currentHandler = defaultHandler;
}

/**
 * Report an unexpected error through the currently-installed handler. The
 * handler itself MUST NOT throw; if it does, we fall back to `console.error`
 * so a single broken handler does not silently lose the original error.
 */
export function onUnexpectedError(err: unknown): void {
  try {
    currentHandler(err);
  } catch (handlerErr) {
    // eslint-disable-next-line no-console
    console.error('[unexpected] handler threw', handlerErr, 'while reporting', err);
  }
}

/**
 * Helper used by `Emitter.fire()` to safely invoke a single listener: any
 * synchronous exception is routed through `onUnexpectedError` so siblings
 * still run and listener failures don't propagate up the `fire()` call site.
 */
export function safelyCallListener(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    onUnexpectedError(err);
  }
}
