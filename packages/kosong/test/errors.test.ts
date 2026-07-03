import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isProviderRateLimitError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
  isToolExchangeAdjacencyError,
  normalizeAPIStatusError,
} from '#/errors';
import { describe, expect, it } from 'vitest';

describe('ChatProviderError', () => {
  it('is an instance of Error', () => {
    const err = new ChatProviderError('base error');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.message).toBe('base error');
    expect(err.name).toBe('ChatProviderError');
  });
});

describe('APIConnectionError', () => {
  it('extends ChatProviderError', () => {
    const err = new APIConnectionError('connection refused');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIConnectionError');
    expect(err.message).toBe('connection refused');
  });
});

describe('APITimeoutError', () => {
  it('extends ChatProviderError', () => {
    const err = new APITimeoutError('request timed out after 30s');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APITimeoutError');
    expect(err.message).toBe('request timed out after 30s');
  });
});

describe('APIStatusError', () => {
  it('extends ChatProviderError and stores status code', () => {
    const err = new APIStatusError(429, 'rate limited', 'req-abc');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIStatusError');
    expect(err.message).toBe('rate limited');
    expect(err.statusCode).toBe(429);
    expect(err.requestId).toBe('req-abc');
  });

  it('accepts null requestId', () => {
    const err = new APIStatusError(500, 'server error', null);
    expect(err.statusCode).toBe(500);
    expect(err.requestId).toBeNull();
  });

  it('defaults requestId to null when omitted', () => {
    const err = new APIStatusError(502, 'bad gateway');
    expect(err.statusCode).toBe(502);
    expect(err.requestId).toBeNull();
  });
});

describe('APIEmptyResponseError', () => {
  it('extends ChatProviderError', () => {
    const err = new APIEmptyResponseError('empty response');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIEmptyResponseError');
    expect(err.message).toBe('empty response');
    expect(err.finishReason).toBeNull();
    expect(err.rawFinishReason).toBeNull();
  });

  it('preserves provider finish reason details', () => {
    const err = new APIEmptyResponseError('empty response', {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });

    expect(err.finishReason).toBe('filtered');
    expect(err.rawFinishReason).toBe('content_filter');
  });
});

describe('APIContextOverflowError', () => {
  it('extends APIStatusError and preserves HTTP details', () => {
    const err = new APIContextOverflowError(400, 'Context length exceeded', 'req-context');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIContextOverflowError');
    expect(err.statusCode).toBe(400);
    expect(err.requestId).toBe('req-context');
  });
});

describe('APIProviderRateLimitError', () => {
  it('extends APIStatusError and preserves HTTP details', () => {
    const err = new APIProviderRateLimitError('Rate limited', 'req-rate');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIProviderRateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.requestId).toBe('req-rate');
  });
});

describe('isRetryableGenerateError', () => {
  it('matches transient provider errors and empty generate responses', () => {
    expect(isRetryableGenerateError(new APIConnectionError('conn'))).toBe(true);
    expect(isRetryableGenerateError(new APITimeoutError('timeout'))).toBe(true);
    expect(isRetryableGenerateError(new APIEmptyResponseError('empty'))).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])('treats HTTP %i as retryable', (statusCode) => {
    expect(isRetryableGenerateError(new APIStatusError(statusCode, 'retryable'))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats HTTP %i as non-retryable', (statusCode) => {
    expect(isRetryableGenerateError(new APIStatusError(statusCode, 'non-retryable'))).toBe(false);
  });

  it('does not retry context overflow or unknown errors', () => {
    expect(
      isRetryableGenerateError(new APIContextOverflowError(400, 'Context length exceeded')),
    ).toBe(false);
    expect(isRetryableGenerateError(new Error('boom'))).toBe(false);
    expect(isRetryableGenerateError('boom')).toBe(false);
  });
});

describe('error hierarchy instanceof checks', () => {
  it('all error types are instanceof ChatProviderError', () => {
    const errors = [
      new APIConnectionError('conn'),
      new APITimeoutError('timeout'),
      new APIStatusError(400, 'status', null),
      new APIContextOverflowError(400, 'context length exceeded'),
      new APIEmptyResponseError('empty'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(ChatProviderError);
    }
  });

  it('specific types are distinguishable', () => {
    const connErr = new APIConnectionError('conn');
    const statusErr = new APIStatusError(400, 'status', null);

    expect(connErr).not.toBeInstanceOf(APIStatusError);
    expect(statusErr).not.toBeInstanceOf(APIConnectionError);
  });

  it('can catch with ChatProviderError and inspect subtype', () => {
    const err: ChatProviderError = new APIStatusError(404, 'not found', 'req-123');

    if (err instanceof APIStatusError) {
      expect(err.statusCode).toBe(404);
      expect(err.requestId).toBe('req-123');
    } else {
      expect.unreachable('Expected APIStatusError');
    }
  });
});

describe('normalizeAPIStatusError', () => {
  it('normalizes HTTP 429 to APIProviderRateLimitError', () => {
    const error = normalizeAPIStatusError(429, 'Too many requests', 'req-rate');
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect(error.statusCode).toBe(429);
    expect(error.requestId).toBe('req-rate');
  });

  it.each([
    [400, 'Context length exceeded'],
    [400, 'Exceeded max tokens'],
    [413, 'Context length exceeded'],
    [422, 'Maximum context window exceeded'],
    [400, 'context_length_exceeded'],
    [422, 'Too many tokens in prompt'],
    [400, 'prompt is too long: 210000 tokens exceeds the maximum'],
    [400, 'input token count 131072 exceeds the maximum number of tokens allowed'],
    [400, 'Invalid request: Your request exceeded model token limit: 262144 (requested: 274613)'],
  ])('normalizes %i "%s" to APIContextOverflowError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message, 'req-context');
    expect(error).toBeInstanceOf(APIContextOverflowError);
    expect(error.statusCode).toBe(statusCode);
    expect(error.requestId).toBe('req-context');
  });

  it.each([
    [401, 'Context length exceeded'],
    [500, 'Context length exceeded'],
    [400, 'Bad request'],
    [422, 'Invalid tool schema'],
    [400, 'max_tokens must be less than or equal to 4096'],
    [422, 'max_output_tokens must not exceed 8192'],
    [400, 'max tokens must not exceed the configured output limit'],
  ])('keeps %i "%s" as APIStatusError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).not.toBeInstanceOf(APIContextOverflowError);
  });
});

describe('isToolExchangeAdjacencyError', () => {
  // The exact Anthropic message observed in the field when a tool_use was not
  // immediately followed by its tool_result.
  const ANTHROPIC_MISSING_RESULT =
    'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: ' +
    'toolu_01MWFhDRqdbB4nzCJNuWYiun. Each `tool_use` block must have a corresponding ' +
    '`tool_result` block in the next message.';

  it('matches the missing-tool_result 400', () => {
    expect(isToolExchangeAdjacencyError(new APIStatusError(400, ANTHROPIC_MISSING_RESULT))).toBe(
      true,
    );
  });

  it('matches the reverse unexpected-tool_result 400', () => {
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(
          400,
          'messages.5: `tool_result` block(s) provided when previous message does not ' +
            'contain any `tool_use` blocks',
        ),
      ),
    ).toBe(true);
    expect(
      isToolExchangeAdjacencyError(new APIStatusError(400, 'unexpected `tool_result` block')),
    ).toBe(true);
  });

  it('also matches a 422 with the same shape', () => {
    expect(isToolExchangeAdjacencyError(new APIStatusError(422, ANTHROPIC_MISSING_RESULT))).toBe(
      true,
    );
  });

  // The exact OpenAI-compatible (Moonshot / Kimi) message observed in the field
  // when a `tool` message's `tool_call_id` has no matching `tool_calls` entry in
  // the preceding assistant message. The doubled space is verbatim from the
  // provider.
  const MOONSHOT_TOOL_CALL_ID_NOT_FOUND = '400 tool_call_id  is not found';

  it('matches the OpenAI/Moonshot tool_call_id-not-found 400', () => {
    expect(
      isToolExchangeAdjacencyError(new APIStatusError(400, MOONSHOT_TOOL_CALL_ID_NOT_FOUND)),
    ).toBe(true);
    expect(
      isToolExchangeAdjacencyError(new APIStatusError(400, "tool_call_id 'call_abc123' is not found")),
    ).toBe(true);
  });

  it('also matches a 422 tool_call_id-not-found', () => {
    expect(
      isToolExchangeAdjacencyError(new APIStatusError(422, MOONSHOT_TOOL_CALL_ID_NOT_FOUND)),
    ).toBe(true);
  });

  // OpenAI / DeepSeek / vLLM and other OpenAI-compatible providers phrase the
  // orphan-`tool`-result case as a `role 'tool'` message that has no preceding
  // assistant `tool_calls`. Observed verbatim in the field (see zed #41531,
  // llama_index #13715). Quote style varies by provider (straight or backtick).
  it('matches the OpenAI/DeepSeek role-tool-without-tool_calls 400', () => {
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(
          400,
          "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
        ),
      ),
    ).toBe(true);
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(
          400,
          'Role `tool` must be a response to a preceding message with `tool_calls`',
        ),
      ),
    ).toBe(true);
  });

  // The mirror-image OpenAI-compatible rejection: an assistant `tool_calls`
  // message with no following `tool` results. OpenAI/Portkey (#6621, error
  // 10067) spell it out; Qwen/DashScope (#454) uses double quotes; some
  // providers emit the terse "(insufficient tool messages following ...)".
  it('matches the assistant-tool_calls-without-response 400', () => {
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(
          400,
          "An assistant message with 'tool_calls' must be followed by tool messages responding to each " +
            "'tool_call_id'. The following tool_call_ids did not have response messages: call_hSmZB4G8",
        ),
      ),
    ).toBe(true);
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(
          400,
          'An assistant message with "tool_calls" must be followed by tool messages responding to each ' +
            '"tool_call_id". The following tool_call_ids did not have response messages: message[322].role',
        ),
      ),
    ).toBe(true);
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(400, '(insufficient tool messages following tool_calls message)'),
      ),
    ).toBe(true);
  });

  it('does not match a context-overflow 400 or unrelated errors', () => {
    expect(
      isToolExchangeAdjacencyError(new APIContextOverflowError(400, 'context length exceeded')),
    ).toBe(false);
    expect(isToolExchangeAdjacencyError(new APIStatusError(400, 'Bad request'))).toBe(false);
    // A bare "not found" without a tool_call_id anchor must not match, so an
    // unrelated 404-style body cannot trip the tool-exchange recovery.
    expect(isToolExchangeAdjacencyError(new APIStatusError(400, 'resource not found'))).toBe(false);
    // A model-availability 400 (observed alongside this family in the field) is a
    // config error, not a tool-exchange defect — strict resend must not fire.
    expect(
      isToolExchangeAdjacencyError(
        new APIStatusError(400, '400 Not supported model mimo-v2.5-pro-ultraspeed'),
      ),
    ).toBe(false);
    expect(isToolExchangeAdjacencyError(new APIStatusError(500, ANTHROPIC_MISSING_RESULT))).toBe(
      false,
    );
    expect(isToolExchangeAdjacencyError(new Error(ANTHROPIC_MISSING_RESULT))).toBe(false);
    expect(isToolExchangeAdjacencyError('boom')).toBe(false);
  });
});

describe('isRecoverableRequestStructureError', () => {
  it('matches the whole tool_use/tool_result adjacency family', () => {
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(400, '`tool_use` ids were found without `tool_result` blocks'),
      ),
    ).toBe(true);
  });

  it('matches the OpenAI/Moonshot tool_call_id-not-found 400', () => {
    expect(
      isRecoverableRequestStructureError(new APIStatusError(400, '400 tool_call_id  is not found')),
    ).toBe(true);
  });

  it('matches the OpenAI-compatible role-tool / assistant-tool_calls pairing 400s', () => {
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(
          400,
          "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
        ),
      ),
    ).toBe(true);
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(
          400,
          "An assistant message with 'tool_calls' must be followed by tool messages responding to each " +
            "'tool_call_id'. The following tool_call_ids did not have response messages: call_hSmZB4G8",
        ),
      ),
    ).toBe(true);
  });

  it('matches the Anthropic duplicate tool_use id rejection', () => {
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(400, 'messages: `tool_use` ids must be unique'),
      ),
    ).toBe(true);
  });

  it('matches empty / whitespace-only text content rejections', () => {
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(400, 'messages: text content blocks must be non-empty'),
      ),
    ).toBe(true);
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(400, 'text content blocks must contain non-whitespace text'),
      ),
    ).toBe(true);
  });

  it('matches first-message-must-be-user and role-alternation rejections', () => {
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(400, 'messages: first message must use the "user" role'),
      ),
    ).toBe(true);
    expect(
      isRecoverableRequestStructureError(
        new APIStatusError(
          400,
          'messages: roles must alternate between "user" and "assistant", but found multiple "user" roles in a row',
        ),
      ),
    ).toBe(true);
  });

  it('does not match context overflow, auth, or non-status errors', () => {
    expect(
      isRecoverableRequestStructureError(new APIContextOverflowError(400, 'context length exceeded')),
    ).toBe(false);
    expect(isRecoverableRequestStructureError(new APIStatusError(401, 'unauthorized'))).toBe(false);
    expect(isRecoverableRequestStructureError(new APIStatusError(400, 'Bad request'))).toBe(false);
    expect(isRecoverableRequestStructureError(new Error('roles must alternate'))).toBe(false);
  });
});

describe('isProviderRateLimitError', () => {
  it('matches explicit HTTP 429 status errors', () => {
    expect(isProviderRateLimitError(new APIProviderRateLimitError('rate limited'))).toBe(true);
    expect(isProviderRateLimitError(new APIStatusError(429, 'rate limited'))).toBe(true);
    expect(isProviderRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isProviderRateLimitError({ statusCode: 503, message: 'rate limit' })).toBe(false);
  });

  it('matches wrapped provider rate-limit messages without status metadata', () => {
    expect(
      isProviderRateLimitError(
        new Error(
          'APIStatusError: 429 request id: req-429, request reached user+model max RPM: 50',
        ),
      ),
    ).toBe(true);
    expect(
      isProviderRateLimitError(
        "[provider.api_error] We're receiving too many requests at the moment. Please wait.",
      ),
    ).toBe(true);
    expect(isProviderRateLimitError(new Error('[provider.rate_limit] slow down'))).toBe(true);
  });

  it('does not match non-rate-limit provider errors', () => {
    expect(isProviderRateLimitError(new APIStatusError(401, 'unauthorized'))).toBe(false);
    expect(isProviderRateLimitError('APIStatusError: 401 unauthorized')).toBe(false);
    expect(isProviderRateLimitError(new Error('context length exceeded'))).toBe(false);
  });
});
