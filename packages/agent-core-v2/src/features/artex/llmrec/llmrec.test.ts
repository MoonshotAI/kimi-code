import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createUserMessage } from '@moonshot-ai/core/llm/message';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';

import {
  ArtexLlmRecorder,
  ArtexLlmWireCapture,
  applyCostLedger,
  computeTokenCost,
  parseArtexSessionId,
  usageBucketFromTokenUsage,
  wrapFetchWithCapture,
  type ArtexLlmUsageEntry,
} from './index';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artex-llmrec-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('ArtexLlmWireCapture', () => {
  it('preserves a single response verbatim and delimits retried attempts in order', async () => {
    const capture = new ArtexLlmWireCapture();
    capture.setRequest('{"model":"m1"}');
    capture.setRequest('{"model":"ignored"}');
    expect(capture.rawRequest()).toBe('{"model":"m1"}');

    const sse = 'data: {"text":"hi"}\n\ndata: [DONE]\n\n';
    const stream = capture.teeResponse(
      200,
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
    );
    expect(await new Response(stream).text()).toBe(sse);
    expect(capture.rawResponse()).toBe(sse);

    const retryCapture = new ArtexLlmWireCapture();
    retryCapture.recordResponse(429, '{"error":"rate_limit"}');
    retryCapture.recordResponse(200, 'data: ok\n');
    const combined = retryCapture.rawResponse();
    expect(combined).toContain('===== attempt 1/2 — HTTP 429 =====');
    expect(combined).toContain('{"error":"rate_limit"}');
    expect(combined).toContain('===== attempt 2/2 — HTTP 200 =====');
    expect(combined).toContain('data: ok');
    expect(combined.indexOf('rate_limit')).toBeLessThan(combined.indexOf('data: ok'));
    expect(retryCapture.attempts()).toEqual([
      { status: 429, body: '{"error":"rate_limit"}' },
      { status: 200, body: 'data: ok\n' },
    ]);
  });

  it('wraps fetch transparently while teeing wire request and response bodies', async () => {
    const capture = new ArtexLlmWireCapture();
    const wrapped = wrapFetchWithCapture(async () => {
      return new Response('{"ok":true}', { status: 200 });
    }, capture);

    const res = await wrapped('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: '{"prompt":"ping"}',
    });
    expect(await res.text()).toBe('{"ok":true}');
    expect(capture.rawRequest()).toBe('{"prompt":"ping"}');
    expect(capture.rawResponse()).toBe('{"ok":true}');
  });
});

describe('ArtexLlmRecorder', () => {
  it('parses ARTEX exploration session ids cleanly', () => {
    expect(parseArtexSessionId('exp12-worker-i99')).toEqual({
      taskId: '12',
      explorationId: 12,
      worker: 'worker',
    });
    expect(parseArtexSessionId('exp4-planner')).toEqual({
      taskId: '4',
      explorationId: 4,
      worker: 'planner',
    });
    expect(parseArtexSessionId('conv-abc')).toEqual({
      taskId: '',
      explorationId: 0,
      worker: '',
    });
  });

  it('respects opt-in recording toggle while still metering usage when enabled', async () => {
    const dir = createTempDir();
    const seenUsage: ArtexLlmUsageEntry[] = [];
    const recorder = new ArtexLlmRecorder({
      recordDir: dir,
      enabled: false,
      onUsage: (entry) => seenUsage.push(entry),
    });

    const recorded = await recorder.recordCall({
      sessionId: 'exp7-worker-i2',
      model: 'kimi-k2',
      profileName: 'primary',
      latencyMs: 120,
      usage: { inputOther: 100, output: 20, inputCacheRead: 50, inputCacheCreation: 0 },
      status: 'ok',
    });

    expect(recorded).toBeUndefined();
    expect(seenUsage).toHaveLength(1);
    expect(seenUsage[0]).toMatchObject({
      explorationId: 7,
      worker: 'worker',
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 50,
    });
    expect(await recorder.readRecords()).toEqual([]);
    expect(await recorder.readUsage()).toHaveLength(1);
  });

  it('writes bounded JSONL records and blob files when opt-in recording is enabled', async () => {
    const dir = createTempDir();
    const recorder = new ArtexLlmRecorder({
      recordDir: dir,
      enabled: true,
      maxInlineBytes: 256,
      maxBlobBytes: 512,
    });

    const capture = new ArtexLlmWireCapture();
    const hugeBody = 'A'.repeat(1024);
    capture.setRequest(hugeBody);
    capture.recordResponse(200, 'B'.repeat(1024));

    const outcome: LlmOutcome = {
      type: 'done',
      message: {
        role: 'assistant',
        content: [
          { type: 'think', think: 'hmm' },
          { type: 'text', text: 'final answer' },
        ],
        toolCalls: [],
        attributes: { source: 'llm' },
      },
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      usage: { inputOther: 200, output: 50, inputCacheRead: 100, inputCacheCreation: 10 },
    };

    const entry = await recorder.recordOutcome(outcome, {
      sessionId: 'exp3-planner',
      profileName: 'planner-main',
      latencyMs: 345,
      request: {
        protocol: { base: {} as never },
        model: { spec: { provider: 'openai', name: 'gpt-test' } },
        profile: {
          tools: [{ name: 'Bash', description: 'run shell', parameters: { type: 'object' } }],
        },
        content: { messages: [createUserMessage('hello')] },
      },
      capture,
    });

    expect(entry).toBeDefined();
    expect(entry!.rawRequestPreview).toContain('truncated');
    expect(entry!.rawRequestBlob).toBeDefined();
    expect(entry!.rawResponseBlob).toBeDefined();
    expect(entry!.requestSummary).toContain('"tools":["Bash"]');

    const reqBlob = await recorder.readBlob(entry!.rawRequestBlob!);
    expect(reqBlob).toContain('truncated, 1024 bytes total');
    expect(Buffer.byteLength(reqBlob, 'utf8')).toBeLessThan(700);

    const records = await recorder.readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.responseSummary).toContain('final answer');
  });
});

describe('applyCostLedger', () => {
  it('computes EUR and USD costs without double-counting cache_read tokens', () => {
    const priced = applyCostLedger(
      [
        {
          profileName: 'cost-eur',
          inputTokens: 2_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 0,
        },
        {
          profileName: 'cost-usd',
          inputTokens: 1_000_000,
          outputTokens: 200_000,
          cacheReadTokens: 1_500_000, // exceeds inputTokens: fresh input clamps at 0
          cacheWriteTokens: 100_000,
        },
        {
          profileName: 'unpriced',
          inputTokens: 10_000,
          outputTokens: 5_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      [
        {
          profileName: 'cost-eur',
          currency: 'EUR',
          inputPerM: 1.5,
          outputPerM: 4.0,
          cacheReadPerM: 0.15,
        },
        {
          profileName: 'cost-usd',
          currency: 'USD',
          inputPerM: 3.0,
          outputPerM: 15.0,
          cacheReadPerM: 0.3,
          cacheWritePerM: 3.75,
        },
      ],
      { usdPerEur: 1.1 },
    );

    expect(priced[0]!.costEur).toBeCloseTo(1.0 * 1.5 + 0.5 * 4.0 + 1.0 * 0.15, 6);
    expect(priced[0]!.costUsd).toBeCloseTo(priced[0]!.costEur! * 1.1, 6);

    expect(priced[1]!.costUsd).toBeCloseTo(
      0 + 0.2 * 15.0 + 1.5 * 0.3 + 0.1 * 3.75,
      6,
    );
    expect(priced[1]!.costEur).toBeCloseTo(priced[1]!.costUsd! / 1.1, 6);

    expect(priced[2]!.costEur).toBeUndefined();
    expect(priced[2]!.costUsd).toBeUndefined();
  });

  it('converts @moonshot-ai/core TokenUsage cleanly without double-counting cache reads', () => {
    const bucket = usageBucketFromTokenUsage('kimi', {
      inputOther: 400_000,
      output: 100_000,
      inputCacheRead: 600_000,
      inputCacheCreation: 0,
    });
    expect(bucket.inputTokens).toBe(1_000_000);
    const cost = computeTokenCost(bucket, {
      profileName: 'kimi',
      inputPerM: 2.0,
      outputPerM: 8.0,
      cacheReadPerM: 0.2,
    });
    expect(cost).toBeCloseTo(0.4 * 2.0 + 0.1 * 8.0 + 0.6 * 0.2, 6);
  });
});
