import { describe, expect, it } from 'vitest';

import {
  isOpenCodeEndpoint,
  OPENCODE_SESSION_HEADER,
  withOpencodeSessionHeader,
} from '#/llm/endpoint';

describe('OpenCode session header', () => {
  it('matches opencode.ai and subdomains only', () => {
    expect(isOpenCodeEndpoint('https://opencode.ai/inference/go/openai/v1')).toBe(true);
    expect(isOpenCodeEndpoint('https://api.opencode.ai/v1')).toBe(true);
    expect(isOpenCodeEndpoint('https://notopencode.ai/v1')).toBe(false);
    expect(isOpenCodeEndpoint('https://api.openai.com/v1')).toBe(false);
    expect(isOpenCodeEndpoint(undefined)).toBe(false);
    expect(isOpenCodeEndpoint('not-a-url')).toBe(false);
  });

  it('attaches x-opencode-session when cacheKey is provided for opencode endpoints', () => {
    expect(
      withOpencodeSessionHeader(
        'https://opencode.ai/inference/go/openai/v1',
        { 'x-custom': '1' },
        'session-123',
      ),
    ).toEqual({
      'x-custom': '1',
      [OPENCODE_SESSION_HEADER]: 'session-123',
    });
  });

  it('preserves explicit x-opencode-session header case-insensitively', () => {
    const existing = { 'X-OpenCode-Session': 'custom-session' };
    expect(
      withOpencodeSessionHeader('https://opencode.ai/v1', existing, 'session-123'),
    ).toBe(existing);
  });

  it('does not attach header when sessionId is empty or endpoint is non-opencode', () => {
    const existing = { authorization: 'Bearer k' };
    expect(withOpencodeSessionHeader('https://api.openai.com/v1', existing, 'session-123')).toBe(
      existing,
    );
    expect(withOpencodeSessionHeader('https://opencode.ai/v1', existing, undefined)).toBe(
      existing,
    );
    expect(withOpencodeSessionHeader('https://opencode.ai/v1', existing, '')).toBe(existing);
  });
});
