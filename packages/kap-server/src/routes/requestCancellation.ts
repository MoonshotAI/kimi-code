import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

const context = new AsyncLocalStorage<AbortSignal>();

export function withRequestCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return context.run(signal, () => new Promise<T>((resolve, reject) => {
    work().then(resolve, reject);
  }));
}

export function requestCancellation(raw: IncomingMessage, response?: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  raw.once('aborted', cancel);
  raw.once('error', cancel);
  const inherited = context.getStore();
  if (inherited === undefined && response !== undefined) {
    response.once('close', () => {
      if (!response.writableFinished) cancel();
    });
  }
  return inherited === undefined ? controller.signal : AbortSignal.any([inherited, controller.signal]);
}
