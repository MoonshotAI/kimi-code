import { describe, expect, it } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';
import {
  kimiAnthropicProtocol,
  kimiOpenAIProtocol,
  kimiResponsesProtocol,
} from '#/llm/builtin/provider/kimi/protocol';
import { isQuotaExhaustedMessage } from '#/llm/protocol/rules/status';
import { createRequester } from '#/llm/requester';

import { TEST_MODEL, failedOutcome, jsonResponse, testModule } from './harness';

describe('isQuotaExhaustedMessage', () => {
  it.each([
    '{"error":{"code":"insufficient_quota"}}',
    'exceeded_current_quota_error',
    'RESOURCE_EXHAUSTED',
    'You exceeded your current quota, please check your plan and billing details.',
    'billing_not_active',
    'Your billing account is suspended',
    'credit balance is too low',
    'insufficient funds, please top up',
    'quota exceeded',
    'quota exhausted',
  ])('matches billing/quota exhaustion text: %s', (message) => {
    expect(isQuotaExhaustedMessage(message)).toBe(true);
  });

  it.each([
    'status 429: rate limit exceeded',
    'RESOURCE_EXHAUSTED: rate limit exceeded',
    'too many requests per minute',
    'quota exceeded for quota metric GenerateRequestsPerMinutePerProjectPerBaseModel',
    'RESOURCE_EXHAUSTED: TPM quota exceeded',
    'tokens per minute quota exceeded',
    'rate_limit_exceeded: requests per second',
    'RPM limit reached, please check your billing tier',
    'status 401: invalid api key',
    'status 401: insufficient_quota',
    'HTTP 403: billing_hard_limit_reached',
    'status 500: internal server error',
    'status=503: insufficient_quota',
    'context length exceeded',
  ])('excludes transient rate-limit and non-failover status text: %s', (message) => {
    expect(isQuotaExhaustedMessage(message)).toBe(false);
  });
});

describe('429 quota exhaustion decoding across providers', () => {
  it('classifies OpenAI 429 billing/quota body as non-retryable quota_exhausted without 10 retries', async () => {
    let calls = 0;
    const mod = testModule();
    const requester = createRequester().with({
      protocol: { base: openAIProtocol, stream: false },
      endpoint: {
        baseUrl: 'https://example.test/v1',
        credentials: { resolve: () => ({ apiKey: 'test-key' }) },
        fetch: async () => {
          calls += 1;
          return jsonResponse(
            {
              error: {
                type: 'rate_limit_error',
                message: 'You exceeded your current quota, please check your plan and billing details.',
              },
            },
            { status: 429 },
          );
        },
      },
    });

    const outcome = failedOutcome(
      await requester.generate(
        { model: mod.model, profile: mod.profile, content: mod.content },
        { signal: new AbortController().signal },
      ),
    );
    expect(calls).toBe(1);
    expect(outcome.error).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      retryable: false,
    });
  });

  it('keeps OpenAI 429 RPM/TPM rate limit retryable', async () => {
    let calls = 0;
    const mod = testModule();
    const requester = createRequester().with({
      protocol: { base: openAIProtocol, stream: false },
      endpoint: {
        baseUrl: 'https://example.test/v1',
        credentials: { resolve: () => ({ apiKey: 'test-key' }) },
        fetch: async () => {
          calls += 1;
          return jsonResponse(
            {
              error: {
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded',
                message: 'Rate limit reached for RPM',
              },
            },
            { status: 429 },
          );
        },
      },
    });

    const outcome = failedOutcome(
      await requester.generate(
        {
          model: mod.model,
          profile: mod.profile,
          content: mod.content,
          policy: { retry: { maxAttemptsPerStep: 1 } },
        },
        { signal: new AbortController().signal },
      ),
    );
    expect(calls).toBe(1);
    expect(outcome.error).toMatchObject({
      kind: 'rate_limit',
      statusCode: 429,
      retryable: true,
    });
  });

  it('classifies OpenAI Responses 429 quota body as non-retryable quota_exhausted', async () => {
    let calls = 0;
    const mod = testModule();
    const requester = createRequester().with({
      protocol: { base: openAIResponsesProtocol, stream: false },
      endpoint: {
        baseUrl: 'https://example.test/v1',
        credentials: { resolve: () => ({ apiKey: 'test-key' }) },
        fetch: async () => {
          calls += 1;
          return jsonResponse(
            {
              error: {
                message: 'Insufficient balance in account',
              },
            },
            { status: 429 },
          );
        },
      },
    });

    const outcome = failedOutcome(
      await requester.generate(
        { model: mod.model, profile: mod.profile, content: mod.content },
        { signal: new AbortController().signal },
      ),
    );
    expect(calls).toBe(1);
    expect(outcome.error).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      retryable: false,
    });
  });

  it('classifies Anthropic 429 credit balance error as non-retryable quota_exhausted', async () => {
    let calls = 0;
    const mod = testModule({ model: { ...TEST_MODEL, maxOutputTokens: 1024 } });
    const requester = createRequester().with({
      protocol: { base: anthropicProtocol, stream: false },
      endpoint: {
        baseUrl: 'https://example.test',
        credentials: { resolve: () => ({ apiKey: 'test-key' }) },
        fetch: async () => {
          calls += 1;
          return jsonResponse(
            {
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: 'Your credit balance is too low to access the API.',
              },
            },
            { status: 429 },
          );
        },
      },
    });

    const outcome = failedOutcome(
      await requester.generate(
        { model: mod.model, profile: mod.profile, content: mod.content },
        { signal: new AbortController().signal },
      ),
    );
    expect(calls).toBe(1);
    expect(outcome.error).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      retryable: false,
    });
  });

  it('classifies Google GenAI 429 billing/quota exhaustion vs RPM rate limit', async () => {
    const mod = testModule();
    const quotaOutcome = failedOutcome(
      await createRequester()
        .with({
          protocol: { base: googleGenAIProtocol, stream: false },
          endpoint: {
            baseUrl: 'https://example.test/v1beta',
            credentials: { resolve: () => ({ apiKey: 'test-key' }) },
            fetch: async () =>
              jsonResponse(
                {
                  error: {
                    code: 429,
                    status: 'RESOURCE_EXHAUSTED',
                    message: 'You exceeded your current quota, please check your plan and billing details.',
                  },
                },
                { status: 429 },
              ),
          },
        })
        .generate(
          { model: mod.model, profile: mod.profile, content: mod.content },
          { signal: new AbortController().signal },
        ),
    );
    expect(quotaOutcome.error).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      retryable: false,
    });

    const rpmOutcome = failedOutcome(
      await createRequester()
        .with({
          protocol: { base: googleGenAIProtocol, stream: false },
          endpoint: {
            baseUrl: 'https://example.test/v1beta',
            credentials: { resolve: () => ({ apiKey: 'test-key' }) },
            fetch: async () =>
              jsonResponse(
                {
                  error: {
                    code: 429,
                    status: 'RESOURCE_EXHAUSTED',
                    message:
                      'Quota exceeded for quota metric GenerateRequestsPerMinutePerProjectPerBaseModel',
                  },
                },
                { status: 429 },
              ),
          },
        })
        .generate(
          {
            model: mod.model,
            profile: mod.profile,
            content: mod.content,
            policy: { retry: { maxAttemptsPerStep: 1 } },
          },
          { signal: new AbortController().signal },
        ),
    );
    expect(rpmOutcome.error).toMatchObject({
      kind: 'rate_limit',
      statusCode: 429,
      retryable: true,
    });
  });

  it.each([
    ['kimi-openai', kimiOpenAIProtocol, 'https://example.test/v1'],
    ['kimi-anthropic', kimiAnthropicProtocol, 'https://example.test'],
    ['kimi-responses', kimiResponsesProtocol, 'https://example.test/v1'],
  ])('classifies %s 429 billing/quota body as quota_exhausted', async (_name, protocol, baseUrl) => {
    let calls = 0;
    const mod = testModule({ model: { ...TEST_MODEL, maxOutputTokens: 1024 } });
    const outcome = failedOutcome(
      await createRequester()
        .with({
          protocol: { base: protocol, stream: false },
          endpoint: {
            baseUrl,
            credentials: { resolve: () => ({ apiKey: 'test-key' }) },
            fetch: async () => {
              calls += 1;
              return jsonResponse(
                {
                  error: {
                    type: 'rate_limit_error',
                    message: 'insufficient_quota: billing account balance is too low',
                  },
                },
                { status: 429 },
              );
            },
          },
        })
        .generate(
          { model: mod.model, profile: mod.profile, content: mod.content },
          { signal: new AbortController().signal },
        ),
    );
    expect(calls).toBe(1);
    expect(outcome.error).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      retryable: false,
    });
  });

  it('classifies OpenAI Responses stream error event with quota text as quota_exhausted', async () => {
    let calls = 0;
    const mod = testModule();
    const outcome = failedOutcome(
      await createRequester()
        .with({
          protocol: { base: openAIResponsesProtocol, stream: true },
          endpoint: {
            baseUrl: 'https://example.test/v1',
            credentials: { resolve: () => ({ apiKey: 'test-key' }) },
            fetch: async () => {
              calls += 1;
              return new Response(
                `data: ${JSON.stringify({
                  type: 'error',
                  code: 'rate_limit_exceeded',
                  message: 'You exceeded your current quota, please check your plan and billing details.',
                })}\n\ndata: [DONE]\n\n`,
                { status: 200, headers: { 'content-type': 'text/event-stream' } },
              );
            },
          },
        })
        .generate(
          { model: mod.model, profile: mod.profile, content: mod.content },
          { signal: new AbortController().signal },
        ),
    );
    expect(calls).toBe(1);
    expect(outcome.error).toMatchObject({
      kind: 'quota_exhausted',
      retryable: false,
    });
  });
});
