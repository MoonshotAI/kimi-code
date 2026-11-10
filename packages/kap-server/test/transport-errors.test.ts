import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../src/protocol/error-codes';
import { describe, expect, it } from 'vitest';

import { mapError } from '../src/transport/errors';
import { installErrorHandler } from '../src/error-handler';

describe('ErrorCode', () => {
  it('has unique numeric values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('/api/v1/debug transport mapError', () => {
  it.each([
    [ErrorCodes.OS_FS_NOT_FOUND, ErrorCode.FS_PATH_NOT_FOUND],
    [ErrorCodes.OS_FS_NOT_DIRECTORY, ErrorCode.FS_PATH_NOT_FOUND],
    [ErrorCodes.OS_FS_IS_DIRECTORY, ErrorCode.FS_IS_DIRECTORY],
    [ErrorCodes.OS_FS_ALREADY_EXISTS, ErrorCode.FS_ALREADY_EXISTS],
    [ErrorCodes.OS_FS_PERMISSION_DENIED, ErrorCode.FS_PERMISSION_DENIED],
    [ErrorCodes.STORAGE_IO_FAILED, ErrorCode.PERSISTENCE_FAILURE],
    [ErrorCodes.STORAGE_LOCKED, ErrorCode.PERSISTENCE_FAILURE],
    [ErrorCodes.CONFIG_INVALID, ErrorCode.VALIDATION_FAILED],
    [ErrorCodes.GOAL_UNSUPPORTED_AGENT, ErrorCode.GOAL_UNSUPPORTED_AGENT],
    [ErrorCodes.PROMPT_ID_CONFLICT, ErrorCode.PROMPT_ID_CONFLICT],
  ])('maps domain code %s to its wire equivalent', (code, wire) => {
    const env = mapError(new Error2(code, 'boom'), 'req-1');
    expect(env.code).toBe(wire);
  });

  it('maps session-specific public errors and preserves public details', () => {
    const details = { holder: { clientIdentity: 'other' } };
    const env = mapError(
      new Error2(ErrorCodes.SESSION_OCCUPIED, 'boom', { details }),
      'req-1',
    );
    expect(env.details).toEqual(details);
    const versionDetails = { minReaderVersion: '9.9', readerVersion: '1.5' };
    const incompatible = mapError(
      new Error2(ErrorCodes.WIRE_VERSION_TOO_LOW, 'upgrade', { details: versionDetails }),
      'req-1',
    );
    expect(incompatible.code).toBe(ErrorCode.WIRE_VERSION_TOO_LOW);
    expect(incompatible.msg).toBe('upgrade');
    expect(incompatible.details).toEqual(versionDetails);
  });

  it('falls back to INTERNAL_ERROR for coded errors without a wire equivalent', () => {
    const env = mapError(new Error2(ErrorCodes.OS_FS_UNKNOWN, 'boom'), 'req-1');
    expect(env.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('installErrorHandler (catch-all)', () => {
  function run(err: unknown): { code: number; msg: string; details?: unknown } {
    let installed: unknown;
    installErrorHandler({
      setErrorHandler: (h) => {
        installed = h;
        return undefined;
      },
    });
    const handler = installed as (
      e: unknown,
      req: { id: string; log: { error: () => void } },
      reply: { status: (code: number) => { send: (p: unknown) => void } },
    ) => void;
    let payload: { code: number; msg: string; details?: unknown } | undefined;
    handler(
      err,
      { id: 'req-1', log: { error: () => {} } },
      { status: () => ({ send: (p: unknown) => void (payload = p as typeof payload) }) },
    );
    return payload!;
  }

  it('maps escaped public errors to their protocol codes', () => {
    const env = run(new Error2(ErrorCodes.CONFIG_INVALID, 'broken pool'));
    expect(env.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(env.msg).toContain('broken pool');
    const details = { minReaderVersion: '9.9', readerVersion: '1.5' };
    const incompatible = run(
      new Error2(ErrorCodes.WIRE_VERSION_TOO_LOW, 'upgrade required', { details }),
    );
    expect(incompatible.code).toBe(ErrorCode.WIRE_VERSION_TOO_LOW);
    expect(incompatible.msg).toContain('upgrade required');
    expect(incompatible.details).toEqual(details);
  });

  it('keeps unknown exceptions at INTERNAL_ERROR', () => {
    expect(run(new Error('boom')).code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});
