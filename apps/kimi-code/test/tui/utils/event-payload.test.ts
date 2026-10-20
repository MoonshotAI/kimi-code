import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import {
  appendStreamingArgsPreview,
  formatErrorMessage,
  formatErrorPayload,
  parseStreamingArgs,
} from '#/tui/utils/event-payload';

describe('streaming tool argument payload helpers', () => {
  it('parses complete JSON arguments for finalized small previews', () => {
    expect(parseStreamingArgs('{"command":"echo hi","path":"/tmp/a"}')).toEqual({
      command: 'echo hi',
      path: '/tmp/a',
    });
  });

  it('caps accumulated streaming preview text', () => {
    const current = 'a'.repeat(STREAMING_ARGS_PREVIEW_MAX_CHARS - 2);

    expect(appendStreamingArgsPreview(current, 'bcdef')).toBe(`${current}bc`);
  });

  it('parses only bounded preview fields from oversized streaming arguments', () => {
    const oversized = `{"command":"echo ok","description":"${'x'.repeat(
      STREAMING_ARGS_PREVIEW_MAX_CHARS + 100,
    )}"}`;

    expect(parseStreamingArgs(oversized)).toEqual({ command: 'echo ok' });
  });
});

describe('error payload formatting', () => {
  const filteredThinkOnlyMessage =
    'The API returned a response containing only thinking content without any text or tool calls. ' +
    'This usually indicates the stream was interrupted or the output token budget was exhausted ' +
    'during reasoning. Provider stop details: finishReason=filtered, rawFinishReason=content_filter. ' +
    'The provider filtered the response before visible output was emitted. Provider: example-provider, model: example-model';
  const conciseFilteredMessage =
    '[provider.api_error] Provider filtered the response before visible output ' +
    '(finishReason=filtered, rawFinishReason=content_filter).';

  it('shows concise provider filter text from structured error payload details', () => {
    const formatted = formatErrorPayload({
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: filteredThinkOnlyMessage,
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    });

    expect(formatted).toBe(conciseFilteredMessage);
    expect(formatted).not.toContain('only thinking content');
    expect(formatted).not.toContain('token budget');
    expect(formatted).not.toContain('stream was interrupted');
  });

  it('shows concise provider filter text from KimiError details', () => {
    const error = new KimiError(ErrorCodes.PROVIDER_API_ERROR, filteredThinkOnlyMessage, {
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    });

    expect(formatErrorMessage(error)).toBe(conciseFilteredMessage);
  });
});
