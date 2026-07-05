import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createKimiClient, KimiClientError } from './client.js';
import type { Config } from '../config.js';

async function getError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw');
}

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'tg-token',
    databasePath: ':memory:',
    pairingCodeTtlMinutes: 10,
    logLevel: 'info',
    kimiServerUrl: 'http://localhost:58627',
    kimiBearerToken: 'kimi-token',
    kimiTokenFile: '~/.kimi-code/token',
    ...overrides,
  };
}

describe('createKimiClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'prompt-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('submitPrompt sends the correct request', async () => {
    const client = createKimiClient(createTestConfig());
    await client.submitPrompt('session-1', 'Hello');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'http://localhost:58627/api/v1/sessions/session-1/prompts'
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer kimi-token',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Hello' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('submitPrompt includes reply_to_message_id when provided', async () => {
    const client = createKimiClient(createTestConfig());
    await client.submitPrompt('session-1', 'Hello', 'parent-id');

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'Hello',
      reply_to_message_id: 'parent-id',
    });
  });

  it('submitPrompt URL-encodes the session id', async () => {
    const client = createKimiClient(createTestConfig());
    await client.submitPrompt('session with spaces', 'Hello');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'http://localhost:58627/api/v1/sessions/session%20with%20spaces/prompts'
    );
  });

  it('submitPrompt returns the prompt id on success', async () => {
    const client = createKimiClient(createTestConfig());
    const result = await client.submitPrompt('session-1', 'Hello');
    expect(result).toEqual({ id: 'prompt-1' });
  });

  it('throws KimiClientError on non-2xx response', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    const client = createKimiClient(createTestConfig());
    const error = await getError(() =>
      client.submitPrompt('session-1', 'Hello')
    );

    expect(error).toBeInstanceOf(KimiClientError);
    expect(error).toMatchObject({
      status: 401,
      responseBody: 'Unauthorized',
    });
  });

  it('throws KimiClientError with response body on server error', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'internal' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createKimiClient(createTestConfig());
    const error = await getError(() =>
      client.submitPrompt('session-1', 'Hello')
    );

    expect(error).toBeInstanceOf(KimiClientError);
    expect(error).toMatchObject({
      status: 500,
      responseBody: JSON.stringify({ error: 'internal' }),
    });
  });

  it('throws when response body is not valid JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createKimiClient(createTestConfig());
    const error = await getError(() =>
      client.submitPrompt('session-1', 'Hello')
    );

    expect(error).toBeInstanceOf(KimiClientError);
    expect((error as Error).message).toMatch(/invalid json/i);
  });

  it('throws when response id is not a string', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: 123 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createKimiClient(createTestConfig());
    await expect(
      client.submitPrompt('session-1', 'Hello')
    ).rejects.toThrowError(/missing id/i);
  });

  it('throws when response JSON is missing the id field', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createKimiClient(createTestConfig());
    await expect(
      client.submitPrompt('session-1', 'Hello')
    ).rejects.toThrowError(/invalid response/i);
  });

  it('throws when response body is a primitive JSON value', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify('ok'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createKimiClient(createTestConfig());
    const error = await getError(() =>
      client.submitPrompt('session-1', 'Hello')
    );

    expect(error).toBeInstanceOf(KimiClientError);
    expect((error as Error).message).toMatch(/missing id/i);
  });

  it('preserves response body in invalid JSON error', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createKimiClient(createTestConfig());
    const error = await getError(() =>
      client.submitPrompt('session-1', 'Hello')
    );

    expect(error).toBeInstanceOf(KimiClientError);
    expect(error).toMatchObject({ responseBody: 'not-json' });
  });

  it('serializes special characters in request body', async () => {
    const client = createKimiClient(createTestConfig());
    await client.submitPrompt('session-1', 'line1\nline2 "quote" \u00e9');

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'line1\nline2 "quote" \u00e9',
    });
  });

  it('wraps fetch network errors in KimiClientError', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const client = createKimiClient(createTestConfig());
    const error = await getError(() =>
      client.submitPrompt('session-1', 'Hello')
    );

    expect(error).toBeInstanceOf(KimiClientError);
    expect(error).toMatchObject({ status: 0 });
    expect((error as Error).message).toMatch(/fetch failed/);
  });

  it('uses a 30-second timeout for fetch', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal);

    const client = createKimiClient(createTestConfig());
    await client.submitPrompt('session-1', 'Hello');

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutSpy.mockRestore();
  });
});
