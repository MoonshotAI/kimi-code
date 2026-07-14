import { Error2 } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';
import { CoreError, CoreErrorCodes, isCoreError } from '../../src/core/errors';

describe('CoreError', () => {
  it('carries code/details and passes the guard', () => {
    const err = new CoreError(CoreErrorCodes.SESSION_NOT_FOUND, 'missing', { details: { id: 's1' } });
    expect(err.code).toBe(CoreErrorCodes.SESSION_NOT_FOUND);
    expect(err.details).toEqual({ id: 's1' });
    expect(isCoreError(err)).toBe(true);
  });
  it('rejects foreign errors', () => {
    expect(isCoreError(new Error('x'))).toBe(false);
    expect(isCoreError(undefined)).toBe(false);
  });
  it('recognizes Error2 thrown by agent-core-v2 services', () => {
    const err = new Error2(CoreErrorCodes.SESSION_NOT_FOUND, 'session missing');
    expect(isCoreError(err)).toBe(true);
  });
  it('rejects a plain Error that only carries a code', () => {
    const err = Object.assign(new Error('boom'), { code: 'session.not_found' });
    expect(err.name).toBe('Error');
    expect(isCoreError(err)).toBe(false);
  });
});
