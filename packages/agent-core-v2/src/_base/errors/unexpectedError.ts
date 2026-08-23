export type UnexpectedErrorHandler = (err: unknown) => void;

const defaultHandler: UnexpectedErrorHandler = (err) => {
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
