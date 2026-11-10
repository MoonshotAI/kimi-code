import { describe, expect, it } from 'vitest';

import { createBedrockTokenProvider } from '#human/llm/builtin/provider/bedrock/credentials';
import { inferBedrockProtocol } from '#human/llm/builtin/provider/bedrock/routing';

const LIVE_REGION = 'us-west-2';
const LIVE_MODEL = 'global.moonshotai.kimi-k3';
const LIVE_RESPONSES_MODEL = 'global.openai.gpt-6-astra';

const hasAwsChain = await probeAwsChain();

async function probeAwsChain(): Promise<boolean> {
  try {
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    const credential = await provider.resolve();
    return credential !== undefined;
  } catch {
    return false;
  }
}

describe.skipIf(!hasAwsChain)('bedrock live integration (ambient AWS credentials)', () => {
  it('generates a usable bearer token and streams a chat completion', async () => {
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    const credential = await provider.resolve();
    expect(credential?.apiKey).toMatch(/^bedrock-api-key-/);

    const res = await fetch(
      `https://bedrock-runtime.${LIVE_REGION}.amazonaws.com/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential?.apiKey}`,
        },
        body: JSON.stringify({
          model: LIVE_MODEL,
          max_tokens: 24,
          stream: true,
          service_tier: 'flex',
          messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('data:');
  }, 60_000);

  it('regenerates a working token after invalidate (401 recovery)', async () => {
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    await provider.resolve();
    provider.invalidate?.();
    const refreshed = await provider.resolve();
    expect(refreshed?.apiKey).toMatch(/^bedrock-api-key-/);

    const res = await fetch(
      `https://bedrock-runtime.${LIVE_REGION}.amazonaws.com/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${refreshed?.apiKey}`,
        },
        body: JSON.stringify({
          model: LIVE_MODEL,
          max_tokens: 8,
          service_tier: 'flex',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );
    expect(res.status).toBe(200);
  }, 60_000);

  it('routes kimi-k3 to chat completions via inferBedrockProtocol', async () => {
    expect(inferBedrockProtocol(LIVE_MODEL)).toBe('openai');
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    const credential = await provider.resolve();
    const res = await fetch(
      `https://bedrock-runtime.${LIVE_REGION}.amazonaws.com/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential?.apiKey}`,
        },
        body: JSON.stringify({
          model: LIVE_MODEL,
          max_tokens: 16,
          service_tier: 'flex',
          messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        }),
      },
    );
    expect(res.status).toBe(200);
  }, 60_000);

  it('routes an openai gpt model to the responses wire via inferBedrockProtocol', async () => {
    expect(inferBedrockProtocol(LIVE_RESPONSES_MODEL)).toBe('openai_responses');
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    const credential = await provider.resolve();
    const res = await fetch(
      `https://bedrock-runtime.${LIVE_REGION}.amazonaws.com/openai/v1/responses`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential?.apiKey}`,
        },
        body: JSON.stringify({
          model: LIVE_RESPONSES_MODEL,
          input: 'Reply with exactly: PONG',
          max_output_tokens: 16,
        }),
      },
    );
    expect(res.status).toBe(200);
  }, 60_000);
});
