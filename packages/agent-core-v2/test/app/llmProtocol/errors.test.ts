/**
 * `llmProtocol` error contract — provider error classification, normalization,
 * and retry metadata shared by generation and swarm recovery.
 */

import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isImageFormatError,
  isProviderRateLimitError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
  isToolExchangeAdjacencyError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
} from '#/app/llmProtocol/errors';
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

  it('preserves a provider-requested retry delay', () => {
    const err = new APIStatusError(429, 'rate limited', 'req-abc', 12_500);
    expect(err.retryAfterMs).toBe(12_500);
  });

  it('defaults the provider-requested retry delay to null', () => {
    expect(new APIStatusError(429, 'rate limited').retryAfterMs).toBeNull();
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

describe('APIProviderOverloadedError', () => {
  it('extends APIStatusError and preserves HTTP details', () => {
    const err = new APIProviderOverloadedError(529, 'Overloaded', 'req-overload');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIProviderOverloadedError');
    expect(err.statusCode).toBe(529);
    expect(err.requestId).toBe('req-overload');
  });
});

describe('APIRequestTooLargeError', () => {
  it('extends APIStatusError and preserves HTTP details', () => {
    const err = new APIRequestTooLargeError(413, 'Request exceeds the maximum size.', 'req-large');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIRequestTooLargeError');
    expect(err.statusCode).toBe(413);
    expect(err.requestId).toBe('req-large');
  });

  it('is not retryable', () => {
    expect(
      isRetryableGenerateError(new APIRequestTooLargeError(413, 'Request exceeds the maximum size.')),
    ).toBe(false);
  });
});

describe('isRetryableGenerateError', () => {
  it('matches transient provider errors and empty generate responses', () => {
    expect(isRetryableGenerateError(new APIConnectionError('conn'))).toBe(true);
    expect(isRetryableGenerateError(new APITimeoutError('timeout'))).toBe(true);
    expect(isRetryableGenerateError(new APIEmptyResponseError('empty'))).toBe(true);
  });

  it.each([408, 409, 429, 500, 502, 503, 504, 529])(
    'treats HTTP %i as retryable',
    (statusCode) => {
      expect(isRetryableGenerateError(new APIStatusError(statusCode, 'retryable'))).toBe(true);
    },
  );

  it('treats provider overload as retryable', () => {
    expect(isRetryableGenerateError(new APIProviderOverloadedError(529, 'Overloaded'))).toBe(true);
    expect(
      isRetryableGenerateError(new APIProviderOverloadedError(503, 'server is currently overloaded')),
    ).toBe(true);
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

  it('retries an unclassified provider error as a transient fallback', () => {
    expect(isRetryableGenerateError(new ChatProviderError('upstream failure'))).toBe(true);
  });

  it.each([
    ['Invalid data URL for image: data:image/png;base64'],
    [
      'Unsupported media type for base64 image: image/avif, url: data:image/avif;base64,AAAA',
    ],
  ])('does not retry deterministic provider validation error: %s', (message) => {
    expect(isRetryableGenerateError(new ChatProviderError(message))).toBe(false);
  });
});

describe('isImageFormatError', () => {
  it('matches documented provider image format/data rejections', () => {
    // OpenAI
    expect(
      isImageFormatError(
        new APIStatusError(400, 'The image data you provided does not represent a valid image'),
      ),
    ).toBe(true);
    // Anthropic media_type enum violation
    expect(
      isImageFormatError(
        new APIStatusError(
          400,
          "messages.0.content.1.image.source.base64.media_type: Input should be 'image/jpeg'",
        ),
      ),
    ).toBe(true);
    // Anthropic decode failure
    expect(isImageFormatError(new APIStatusError(400, 'Could not process image'))).toBe(true);
    // Moonshot/Kimi (from the Kimi Code error reference)
    expect(
      isImageFormatError(
        new APIStatusError(400, 'Invalid request: unsupported image url: /tmp/photo.avif'),
      ),
    ).toBe(true);
    expect(isImageFormatError(new APIStatusError(400, 'unsupported image format'))).toBe(true);
    // Gemini
    expect(isImageFormatError(new APIStatusError(400, 'Unable to process input image'))).toBe(true);
    expect(
      isImageFormatError(
        new APIStatusError(400, 'The mime_type must accurately match the actual image format'),
      ),
    ).toBe(true);
  });

  it('matches client-side image whitelist throws', () => {
    expect(
      isImageFormatError(new ChatProviderError('Unsupported media type for base64 image: image/avif')),
    ).toBe(true);
    expect(
      isImageFormatError(
        new ChatProviderError('Invalid data URL for image: data:image/avif;BASE64,AAA'),
      ),
    ).toBe(true);
  });

  it('does not match a non-image 400, an unrelated status, or overflow/413 subclasses', () => {
    expect(isImageFormatError(new APIStatusError(400, 'max_tokens must be positive'))).toBe(false);
    expect(isImageFormatError(new APIStatusError(422, 'image is bad'))).toBe(false);
    expect(isImageFormatError(new APIStatusError(401, 'invalid api key'))).toBe(false);
    expect(
      isImageFormatError(new APIContextOverflowError(400, 'context length exceeded for image model')),
    ).toBe(false);
    expect(
      isImageFormatError(new APIRequestTooLargeError(413, 'image request too large')),
    ).toBe(false);
    expect(isImageFormatError(new ChatProviderError('connection reset'))).toBe(false);
    expect(isImageFormatError(new Error('image is bad'))).toBe(false);
  });

  it('does not match image count/size/support errors that stripping media cannot fix', () => {
    // Stripping media to zero would let these requests "succeed" with the
    // model blind to the user's images — hiding the real error. They must
    // surface instead of triggering a media-stripped resend.
    expect(isImageFormatError(new APIStatusError(400, 'too many images in request'))).toBe(false);
    expect(
      isImageFormatError(new APIStatusError(400, 'image dimension 5000 exceeds maximum 2048')),
    ).toBe(false);
    expect(
      isImageFormatError(new APIStatusError(400, 'image input is disabled for this model')),
    ).toBe(false);
    expect(isImageFormatError(new APIStatusError(400, 'image_url is not allowed'))).toBe(false);
    // Documented provider messages that are image-shaped but not
    // format/data errors: Anthropic's per-image size cap, Moonshot's
    // capability code, Gemini's unsupported-inlineData rejection.
    expect(
      isImageFormatError(
        new APIStatusError(
          400,
          'messages.44.content.1.image.source.base64: image exceeds 5 MB maximum: 11641928 bytes > 5242880 bytes',
        ),
      ),
    ).toBe(false);
    expect(isImageFormatError(new APIStatusError(400, 'Image Input Not Supported'))).toBe(false);
    expect(
      isImageFormatError(new APIStatusError(400, "`inlineData` isn't supported by this model.")),
    ).toBe(false);
    // Video/audio media_type errors are NOT image errors: they must surface
    // (no conversion-guidance path exists for video) instead of triggering a
    // blind media-stripped resend.
    expect(
      isImageFormatError(
        new APIStatusError(
          400,
          "messages.0.content.1.video.source.base64.media_type: Input should be 'video/mp4'",
        ),
      ),
    ).toBe(false);
    // Bare "media type" phrasings for audio/video inputs likewise surface.
    expect(
      isImageFormatError(new APIStatusError(400, 'unsupported media type for audio input')),
    ).toBe(false);
    expect(isImageFormatError(new APIStatusError(400, 'invalid media type'))).toBe(false);
  });

  it('is excluded from the transient-retry fallback so dedicated recovery fires first', () => {
    // A base ChatProviderError is normally retried as an unclassified
    // transient; image-format errors must not be, or the run would burn the
    // retry budget on an identical request before reaching the media strip.
    expect(isRetryableGenerateError(new ChatProviderError('transient blip'))).toBe(true);
    expect(
      isRetryableGenerateError(
        new ChatProviderError('Unsupported media type for base64 image: image/avif'),
      ),
    ).toBe(false);
    expect(
      isRetryableGenerateError(new APIStatusError(400, 'unsupported image format')),
    ).toBe(false);
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

  it('propagates the provider-requested retry delay through normalization', () => {
    const error = normalizeAPIStatusError(429, 'Too many requests', 'req-rate', 7_000);
    expect(error.retryAfterMs).toBe(7_000);
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

  it('normalizes 529 to APIProviderOverloadedError regardless of message', () => {
    const error = normalizeAPIStatusError(529, 'Overloaded', 'req-overload');
    expect(error).toBeInstanceOf(APIProviderOverloadedError);
    expect(error.statusCode).toBe(529);
    expect(error.requestId).toBe('req-overload');
    expect(normalizeAPIStatusError(529, '<html>529</html>')).toBeInstanceOf(
      APIProviderOverloadedError,
    );
  });

  it.each([
    [503, 'The server is currently overloaded with other requests'],
    [500, 'overloaded_error: Overloaded'],
    [503, 'The model is overloaded. Please try again later.'],
  ])('normalizes %i "%s" to APIProviderOverloadedError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message);
    expect(error).toBeInstanceOf(APIProviderOverloadedError);
    expect(error.statusCode).toBe(statusCode);
  });

  it.each([
    [503, 'Service Unavailable'],
    [502, 'Bad Gateway'],
    [500, 'Internal Server Error'],
    [503, '<html><head><title>503 Service Unavailable</title></head></html>'],
  ])('keeps bare %i "%s" as APIStatusError (not overload)', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).not.toBeInstanceOf(APIProviderOverloadedError);
  });

  it.each([
    // Moonshot / Kimi 413 observed in the field when accumulated media pushed
    // the request body over the provider's byte ceiling.
    [413, 'Request exceeds the maximum size'],
    // Reverse-proxy (nginx-style) 413 with an HTML body.
    [413, '413 <html><head><title>413 Request Entity Too Large</title></head></html>'],
    // Anthropic request_too_large: body over the 32 MB API ceiling.
    [413, 'request_too_large: Request exceeds the maximum allowed number of bytes'],
    // RFC 9110 reason phrase / Node-style wording.
    [413, 'Payload Too Large'],
    [413, 'Content Too Large'],
    // Plain wordings without "entity": generic gateways say "Request too
    // large"; Go's http.MaxBytesReader says "http: request body too large".
    [413, 'Request too large'],
    [413, 'Request body too large'],
    [413, 'http: request body too large'],
  ])('normalizes %i "%s" to APIRequestTooLargeError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message, 'req-large');
    expect(error).toBeInstanceOf(APIRequestTooLargeError);
    expect(error.statusCode).toBe(statusCode);
    expect(error.requestId).toBe('req-large');
  });

  it('keeps a 413 with token-overflow wording as APIContextOverflowError', () => {
    // Vertex phrases prompt-too-long as a 413; that is a token problem
    // (recoverable by compaction), not a request-body-size problem.
    const error = normalizeAPIStatusError(413, 'prompt is too long: 210000 tokens > 200000 maximum');
    expect(error).toBeInstanceOf(APIContextOverflowError);
    expect(error).not.toBeInstanceOf(APIRequestTooLargeError);
  });

  it.each([
    // A bare 413 with unrecognized wording stays unclassified: Vertex abuses
    // 413 for prompt-too-long, so the status alone is not proof of a
    // body-size rejection.
    [413, 'Request failed'],
    // Size wording without the 413 status is not classified either.
    [400, 'Payload too large'],
    [422, 'Request entity too large'],
  ])('keeps %i "%s" as plain APIStatusError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).not.toBeInstanceOf(APIRequestTooLargeError);
    expect(error).not.toBeInstanceOf(APIContextOverflowError);
  });
});

describe('parseRetryAfterMs', () => {
  it('converts integer retry-after seconds to milliseconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '12' }))).toBe(12_000);
  });

  it('ignores an HTTP-date retry-after value', () => {
    expect(
      parseRetryAfterMs(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })),
    ).toBeNull();
  });

  it('ignores missing or malformed header containers', () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
    expect(parseRetryAfterMs({})).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
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
