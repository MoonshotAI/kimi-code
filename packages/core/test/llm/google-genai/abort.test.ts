import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';

import { runGenerate, testModule, useAimockServer } from '../harness';

type MountedHandler = (request: IncomingMessage, res: ServerResponse) => Promise<void>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Google GenAI cancellation', () => {
  const server = useAimockServer();
  const responses = new Set<ServerResponse>();
  let onStreamRequest: MountedHandler;
  let onUnaryRequest: MountedHandler;

  beforeAll(() => {
    server().llm.mount('/v1beta/models/test-model:streamGenerateContent', {
      handleRequest: async (request, res) => {
        responses.add(res);
        await onStreamRequest(request, res);
        return true;
      },
    });
    server().llm.mount('/v1beta/models/test-model:generateContent', {
      handleRequest: async (request, res) => {
        responses.add(res);
        await onUnaryRequest(request, res);
        return true;
      },
    });
  });

  beforeEach(() => {
    onStreamRequest = async () => {
      throw new Error('Unexpected stream request');
    };
    onUnaryRequest = async () => {
      throw new Error('Unexpected unary request');
    };
  });

  afterEach(() => {
    for (const res of responses) res.destroy();
    responses.clear();
  });

  const endpoint = () => ({
    baseUrl: `${server().url}/v1beta`,
    credentials: { resolve: () => ({ apiKey: 'test-key' }) },
  });

  it('aborts a stalled stream after the first chunk, closes the HTTP connection, and keeps received usage', async () => {
    const closed = deferred();
    let rawBody = '';
    onStreamRequest = async (request, res) => {
      for await (const chunk of request) rawBody += String(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: '1' }] } }],
        usageMetadata: { promptTokenCount: 18, cachedContentTokenCount: 0, candidatesTokenCount: 4 },
      })}\n\n`);
      res.on('close', closed.resolve);
    };

    const controller = new AbortController();
    const { outcome, events } = await runGenerate(googleGenAIProtocol, {
      module: testModule(),
      endpoint: endpoint(),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'llm.delta.part') controller.abort();
      },
    });
    await closed.promise;

    expect(outcome).toMatchObject({
      type: 'aborted',
      usage: { inputOther: 18, output: 4, inputCacheRead: 0, inputCacheCreation: 0 },
      reason: { kind: 'abort' },
    });
    expect(events).toContainEqual({
      type: 'llm.delta.usage',
      usage: {
        inputOther: 18,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: { promptTokenCount: 18, cachedContentTokenCount: 0, candidatesTokenCount: 4 },
      },
    });
    expect(rawBody).not.toContain('abortSignal');
  });

  it('aborts a stalled stream before the first chunk and closes the HTTP connection', async () => {
    const started = deferred();
    const closed = deferred();
    onStreamRequest = async (request, res) => {
      request.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.on('close', closed.resolve);
      started.resolve();
    };

    const controller = new AbortController();
    const pending = runGenerate(googleGenAIProtocol, {
      module: testModule(),
      endpoint: endpoint(),
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    const { outcome } = await pending;
    await closed.promise;

    expect(outcome).toMatchObject({ type: 'aborted' });
  });

  it('aborts a stalled non-streaming request and closes the HTTP connection', async () => {
    const started = deferred();
    const closed = deferred();
    onUnaryRequest = async (request, res) => {
      request.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.on('close', closed.resolve);
      started.resolve();
    };

    const controller = new AbortController();
    const pending = runGenerate(googleGenAIProtocol, {
      module: testModule(),
      endpoint: endpoint(),
      stream: false,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    const { outcome } = await pending;
    await closed.promise;

    expect(outcome).toMatchObject({ type: 'aborted' });
  });
});
