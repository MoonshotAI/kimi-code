import { isDaemonNetworkError } from '@moonshot-ai/app-core/api';

const RETRY_DELAYS_MS = [500, 1500];

export async function submitWithNetworkRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isDaemonNetworkError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
