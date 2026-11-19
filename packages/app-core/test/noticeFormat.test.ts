import { describe, expect, it } from 'vitest';

import { formatProviderErrorMessage } from '../src/client/noticeFormat';

const raw = `{
  "error": {
    "code": 400,
    "message": "Request contains an invalid argument.",
    "status": "INVALID_ARGUMENT"
  }
}`;
const compact = JSON.stringify(JSON.parse(raw));

describe('formatProviderErrorMessage', () => {
  it('minifies pretty and already compact JSON', () => {
    expect(formatProviderErrorMessage(raw)).toBe(compact);
    expect(formatProviderErrorMessage(compact)).toBe(compact);
  });

  it('keeps plain and malformed errors unchanged', () => {
    expect(formatProviderErrorMessage('stub error 500')).toBe('stub error 500');
    expect(formatProviderErrorMessage('{not json')).toBe('{not json');
  });

  it('normalizes other valid JSON values', () => {
    for (const value of [
      '[1, 2]',
      'null',
      'true',
      '400',
      '{ }',
      '{"error":null}',
      '{"error":{"message":400}}',
      '{"error":{"message":""}}',
    ]) {
      expect(formatProviderErrorMessage(value)).toBe(JSON.stringify(JSON.parse(value)));
    }
  });
});
