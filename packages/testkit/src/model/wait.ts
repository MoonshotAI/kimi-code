import { FakeModelClosedError } from '#/errors';
import { waitForEvent, type EventWaitOptions } from '#/fixtures/wait';

export function waitForModelEvent<T>(
  closing: AbortSignal,
  subscribe: (settle: (value: T) => void) => () => void,
  options: EventWaitOptions,
): Promise<T> {
  if (closing.aborted) {
    const waiting = Promise.reject<T>(new FakeModelClosedError());
    void waiting.catch(() => undefined);
    return waiting;
  }
  const waiting = waitForEvent<T>((settle, fail) => {
    const onClose = (): void => {
      void waiting.catch(() => undefined);
      fail(new FakeModelClosedError());
    };
    closing.addEventListener('abort', onClose, { once: true });
    const unsubscribe = subscribe(settle);
    return () => {
      closing.removeEventListener('abort', onClose);
      unsubscribe();
    };
  }, options);
  return waiting;
}
