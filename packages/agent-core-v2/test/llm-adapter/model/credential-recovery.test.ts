import { describe, expect, it } from 'vitest';

import {
  runWithCredentialRecovery,
  streamWithCredentialRecovery,
} from '#/llm-adapter/model/credential-recovery';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';

const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
const forbidden = Object.assign(new Error('forbidden'), { status: 403 });

describe('runWithCredentialRecovery', () => {
  it('returns the result without touching credentials on success', async () => {
    let invalidations = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => undefined,
      canRecover: () => true,
      invalidate: () => (invalidations += 1),
    };
    const result = await runWithCredentialRecovery(provider, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(invalidations).toBe(0);
  });

  it('invalidates and retries once on a recoverable error', async () => {
    let invalidations = 0;
    let runs = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => undefined,
      canRecover: (error) => error === unauthorized,
      invalidate: () => (invalidations += 1),
    };
    const result = await runWithCredentialRecovery(provider, () => {
      runs += 1;
      return runs === 1 ? Promise.reject(unauthorized) : Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(runs).toBe(2);
    expect(invalidations).toBe(1);
  });

  it('rethrows when the error is not recoverable or the signal is aborted', async () => {
    const provider: LlmCredentialProvider = {
      resolve: () => undefined,
      canRecover: (error) => error === unauthorized,
      invalidate: () => {},
    };
    await expect(
      runWithCredentialRecovery(provider, () => Promise.reject(forbidden)),
    ).rejects.toBe(forbidden);

    const controller = new AbortController();
    controller.abort();
    await expect(
      runWithCredentialRecovery(provider, () => Promise.reject(unauthorized), controller.signal),
    ).rejects.toBe(unauthorized);
  });

  it('propagates the failure of the retry attempt', async () => {
    const provider: LlmCredentialProvider = {
      resolve: () => undefined,
      canRecover: () => true,
      invalidate: () => {},
    };
    let runs = 0;
    await expect(
      runWithCredentialRecovery(provider, () => {
        runs += 1;
        return Promise.reject(unauthorized);
      }),
    ).rejects.toBe(unauthorized);
    expect(runs).toBe(2);
  });
});

describe('streamWithCredentialRecovery', () => {
  async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of stream) items.push(item);
    return items;
  }

  it('re-creates the stream once after a recoverable error', async () => {
    let invalidations = 0;
    let factories = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => undefined,
      canRecover: (error) => error === unauthorized,
      invalidate: () => (invalidations += 1),
    };
    const items = await collect(
      streamWithCredentialRecovery(provider, async function* () {
        factories += 1;
        yield 'a';
        if (factories === 1) throw unauthorized;
        yield 'b';
      }),
    );
    expect(items).toEqual(['a', 'a', 'b']);
    expect(factories).toBe(2);
    expect(invalidations).toBe(1);
  });

  it('rethrows a second recoverable error and non-recoverable errors', async () => {
    const provider: LlmCredentialProvider = {
      resolve: () => undefined,
      canRecover: (error) => error === unauthorized,
      invalidate: () => {},
    };
    await expect(
      collect(
        streamWithCredentialRecovery(provider, async function* () {
          yield 'x';
          throw unauthorized;
        }),
      ),
    ).rejects.toBe(unauthorized);
    await expect(
      collect(
        streamWithCredentialRecovery(provider, async function* () {
          yield 'x';
          throw forbidden;
        }),
      ),
    ).rejects.toBe(forbidden);
  });
});
