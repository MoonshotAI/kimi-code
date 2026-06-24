/**
 * Centralised reporting for unexpected, non-actionable errors. Listener
 * callbacks (registered via `Emitter.event(...)`) may throw; the Emitter
 * routes those exceptions through `onUnexpectedError` rather than swallowing
 * them silently or letting them bubble through `fire()`.
 *
 * Ported from `packages/agent-core/src/errors/unexpectedError.ts`. Kept in
 * `_base` so the DI subsystem (and `_base` in general) has no business-domain
 * dependency.
 */

export type UnexpectedErrorHandler = (err: unknown) => void;

const defaultHandler: UnexpectedErrorHandler = (err) => {
  // eslint-disable-next-line no-console
  console.error('[unexpected]', err);
};

let currentHandler: UnexpectedErrorHandler = defaultHandler;

export function setUnexpectedErrorHandler(handler: UnexpectedErrorHandler): void {
  currentHandler = handler;
}

export function resetUnexpectedErrorHandler(): void {
  currentHandler = defaultHandler;
}

export function onUnexpectedError(err: unknown): void {
  try {
    currentHandler(err);
  } catch (handlerErr) {
    // eslint-disable-next-line no-console
    console.error('[unexpected] handler threw', handlerErr, 'while reporting', err);
  }
}

export function safelyCallListener(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    onUnexpectedError(err);
  }
}
