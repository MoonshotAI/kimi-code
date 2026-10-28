import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, EnvHttpProxyAgent } from 'undici';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, type Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmClientContext, LlmRequestEvent } from '#/llm/requester/requester';
import {
  createLlmStreamWatchdog,
  DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  getLlmDispatcher,
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  resolveLlmStreamIdleTimeoutMs,
  StreamIdleTimeoutError,
} from '#/llm/requester/timeout';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamOf<T>(chunks: readonly T[], gapMs = 0): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (gapMs > 0) await delay(gapMs);
        yield chunk;
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveLlmStreamIdleTimeoutMs', () => {
  it('defaults to 300 seconds when unset or blank', () => {
    expect(resolveLlmStreamIdleTimeoutMs({})).toBe(DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS);
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '  ' })).toBe(
      DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
    );
  });

  it('accepts a positive integer override', () => {
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '60000' })).toBe(60_000);
  });

  it('rejects non-positive or non-integer values', () => {
    for (const raw of ['0', '-5', '1.5', 'abc', '10ms']) {
      expect(() =>
        resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: raw }),
      ).toThrow(LLM_STREAM_IDLE_TIMEOUT_ENV);
    }
  });

  it('rejects values above the timer maximum', () => {
    for (const raw of ['2147483648', '9999999999999']) {
      expect(() =>
        resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: raw }),
      ).toThrow(LLM_STREAM_IDLE_TIMEOUT_ENV);
    }
  });
});

describe('createLlmStreamWatchdog', () => {
  const parent = () => new AbortController().signal;

  it('lets a continuously streaming response run well past the idle limit', async () => {
    const watchdog = createLlmStreamWatchdog(parent(), 80);
    const received: number[] = [];
    for await (const chunk of watchdog.watch(streamOf([1, 2, 3, 4, 5, 6, 7, 8], 25))) {
      received.push(chunk);
    }
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(watchdog.signal.aborted).toBe(false);
  });

  it('aborts a stream silent for longer than the idle limit', async () => {
    const watchdog = createLlmStreamWatchdog(parent(), 50);
    const stalled = (async () => {
      const received: number[] = [];
      for await (const chunk of watchdog.watch(streamOf([1, 2, 3], 150))) {
        received.push(chunk);
      }
      return received;
    })();
    await expect(stalled).rejects.toThrow(StreamIdleTimeoutError);
    await expect(stalled).rejects.toThrow(/50 ms/);
    await Promise.resolve();
    expect(watchdog.signal.aborted).toBe(true);
  });

  it('times out before the first chunk when the stream never starts', async () => {
    const watchdog = createLlmStreamWatchdog(parent(), 40);
    const hanging: AsyncIterable<number> = {
      async *[Symbol.asyncIterator]() {
        await delay(500);
        yield 1;
      },
    };
    const stalled = (async () => {
      for await (const _ of watchdog.watch(hanging)) {
        throw new Error('no chunk expected');
      }
    })();
    await expect(stalled).rejects.toThrow(StreamIdleTimeoutError);
  });

  it('surfaces the idle timeout even when the pending read rejects on abort', async () => {
    const watchdog = createLlmStreamWatchdog(parent(), 40);
    const sdkLike: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<never>((_, reject) => {
              watchdog.signal.addEventListener('abort', () => {
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                reject(error);
              });
            }),
        };
      },
    };
    const stalled = (async () => {
      for await (const _ of watchdog.watch(sdkLike)) {
        throw new Error('no chunk expected');
      }
    })();
    await expect(stalled).rejects.toThrow(StreamIdleTimeoutError);
  });

  it('propagates stream errors unchanged', async () => {
    const watchdog = createLlmStreamWatchdog(parent(), 1000);
    const broken: AsyncIterable<number> = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw new Error('boom');
      },
    };
    const failed = (async () => {
      for await (const _ of watchdog.watch(broken)) {
      }
    })();
    await expect(failed).rejects.toThrow('boom');
  });

  it('lets the consumer stop early without aborting the watch signal', async () => {
    const watchdog = createLlmStreamWatchdog(parent(), 50);
    for await (const chunk of watchdog.watch(streamOf([1, 2, 3, 4]))) {
      if (chunk === 2) break;
    }
    expect(watchdog.signal.aborted).toBe(false);
  });

  it('propagates caller aborts to the linked signal', async () => {
    const controller = new AbortController();
    const watchdog = createLlmStreamWatchdog(controller.signal, 60_000);
    expect(watchdog.signal.aborted).toBe(false);
    controller.abort();
    expect(watchdog.signal.aborted).toBe(true);
  });
});

describe('getLlmDispatcher', () => {
  it('returns a body-timeout-free agent for direct connections', () => {
    const dispatcher = getLlmDispatcher(undefined, { NO_PROXY: undefined });
    expect(dispatcher).toBeInstanceOf(Agent);
    expect(getLlmDispatcher(undefined, { NO_PROXY: undefined })).toBe(dispatcher);
  });

  it('applies the headers timeout override and caches it separately', () => {
    const withoutOverride = getLlmDispatcher(undefined, { NO_PROXY: undefined });
    const withOverride = getLlmDispatcher(45_000, { NO_PROXY: undefined });
    expect(withOverride).toBeInstanceOf(Agent);
    expect(withOverride).not.toBe(withoutOverride);
  });

  it('honors HTTP proxy environment', () => {
    const dispatcher = getLlmDispatcher(undefined, {
      https_proxy: 'http://proxy.example.test:8080',
    });
    expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it('falls back to the global dispatcher for SOCKS proxies', () => {
    const dispatcher = getLlmDispatcher(undefined, { all_proxy: 'socks5://127.0.0.1:1080' });
    expect(dispatcher).toBeUndefined();
  });

  it('rebuilds when the proxy environment changes', () => {
    const first = getLlmDispatcher(undefined, { https_proxy: 'http://a.example.test:8080' });
    const second = getLlmDispatcher(undefined, { https_proxy: 'http://b.example.test:8080' });
    expect(first).not.toBe(second);
  });
});

describe('openai requester stream idle timeout', () => {
  const model: LlmModel = {
    provider: 'test',
    model: 'test-model',
    capability: UNKNOWN_CAPABILITY,
    baseUrl: 'https://example.test/v1',
  };
  const messages: readonly Message[] = [createUserMessage('hi')];

  const chunkOf = (text: string, finish: string | null = null) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
  });

  function stubClient(chunks: readonly Record<string, unknown>[], gapMs: number): {
    clientFactory: (request: LlmClientContext) => never;
  } {
    return {
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create: () => ({
                withResponse: async () => ({
                  data: streamOf(chunks, gapMs),
                  response: new Response(null),
                }),
              }),
            },
          },
        }) as never,
    };
  }

  async function collectEvents(gapMs: number): Promise<LlmRequestEvent[]> {
    const requester = createOpenAIRequester(stubClient([chunkOf('a'), chunkOf('b', 'stop')], gapMs));
    const events: LlmRequestEvent[] = [];
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    return events;
  }

  it('completes a slow but steadily streaming request without failing', async () => {
    vi.stubEnv(LLM_STREAM_IDLE_TIMEOUT_ENV, '100');
    const events = await collectEvents(40);
    expect(events.map((event) => event.type)).toContain('llm.done');
    expect(events.some((event) => event.type === 'llm.failed.remote')).toBe(false);
  });

  it('fails a stalled request with a retryable timeout instead of a connection error', async () => {
    vi.stubEnv(LLM_STREAM_IDLE_TIMEOUT_ENV, '60');
    const events = await collectEvents(180);
    const failed = events.filter((event) => event.type === 'llm.failed.remote');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ error: { kind: 'timeout' } });
    expect(events.map((event) => event.type)).not.toContain('llm.done');
  });
});
