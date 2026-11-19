import { describe, expect, it } from 'vitest';

import { DaemonApiError, DaemonNetworkError } from '../src/api/errors';
import { classifyConnectIssue } from '../src/lib/connectIssue';

function networkError(cause: unknown): DaemonNetworkError {
  return new DaemonNetworkError({
    message: 'request failed',
    cause,
    method: 'GET',
    path: '/api/v1/auth',
    url: 'http://localhost:1/api/v1/auth',
    requestId: 'req_1',
    phase: 'fetch',
    timeoutMs: 30_000,
  });
}

describe('classifyConnectIssue', () => {
  it('classifies a daemon envelope error as api and keeps the server message', () => {
    const err = new DaemonApiError({ code: 50000, msg: 'daemon database is on fire', requestId: 'req_1' });
    expect(classifyConnectIssue(err)).toEqual({ kind: 'api', message: 'daemon database is on fire' });
  });

  it('classifies a transport failure as network', () => {
    expect(classifyConnectIssue(networkError(new TypeError('fetch failed'))).kind).toBe('network');
  });

  it('classifies a self-imposed timeout as timeout', () => {
    const cause = new DOMException('The operation timed out.', 'TimeoutError');
    expect(classifyConnectIssue(networkError(cause)).kind).toBe('timeout');
  });

  it('classifies anything else as unknown and keeps the raw message', () => {
    expect(classifyConnectIssue(new Error('connection refused'))).toEqual({
      kind: 'unknown',
      message: 'connection refused',
    });
  });
});
