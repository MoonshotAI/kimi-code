import { describe, expect, it } from 'vitest';

import { createBedrockTokenProvider } from '#human/llm/builtin/provider/bedrock/credentials';
import { inferBedrockProtocol } from '#human/llm/builtin/provider/bedrock/routing';
import { anthropicProtocol } from '#human/llm/builtin/protocol/anthropic/index';

const LIVE_REGION = 'us-west-2';
const LIVE_MODEL = 'global.moonshotai.kimi-k3.1';
const LIVE_RESPONSES_MODEL = 'global.openai.gpt-6.1-terra';
const LIVE_ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6';

const OPT_IN = process.env['KIMI_BEDROCK_LIVE_TEST'] === '1';

async function probeAwsChain(): Promise<boolean> {
  try {
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    const credential = await provider.resolve();
    return credential !== undefined;
  } catch {
    return false;
  }
}

describe.skipIf(!OPT_IN)('bedrock live integration (ambient AWS credentials)', () => {
  it('requires an ambient AWS credential chain when opted in', async () => {
    expect(
      await probeAwsChain(),
      'KIMI_BEDROCK_LIVE_TEST=1 is set but no usable AWS credential chain was found; configure AWS_REGION/AWS_PROFILE or shared credentials',
    ).toBe(true);
  });
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

  it('authenticates a claude model on the anthropic wire via Authorization: Bearer', async () => {
    expect(inferBedrockProtocol(LIVE_ANTHROPIC_MODEL)).toBe('anthropic');
    const provider = createBedrockTokenProvider({ region: LIVE_REGION });
    const credential = await provider.resolve();
    expect(credential?.headers?.['authorization']).toMatch(/^Bearer bedrock-api-key-/);

    const client = anthropicProtocol.client(
      {
        baseUrl: `https://bedrock-runtime.${LIVE_REGION}.amazonaws.com/anthropic`,
        apiKey: credential?.apiKey,
        headers: credential?.headers,
      },
      undefined,
    );
    const res = await client.messages.create({
      model: LIVE_ANTHROPIC_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    expect(res.content.length).toBeGreaterThan(0);
  }, 60_000);
});
