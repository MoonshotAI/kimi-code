/**
 * Scenario: `/api/v1/debug` transport error translation and v1 event error-code validation.
 * Responsibilities: verify stable domain-to-wire mappings, fallback, and skill-code parity.
 * Wiring: real error mapper and event schema with in-process coded errors.
 * Run: `pnpm --filter @moonshot-ai/kap-server exec vitest run test/transport-errors.test.ts`.
 */
import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import { kimiErrorCodeSchema } from '../src/protocol/events-zod';
import { mapError } from '../src/transport/errors';

describe('v1 event error-code contract', () => {
  it('accepts the skill.disabled protocol code', () => {
    expect(kimiErrorCodeSchema.parse('skill.disabled')).toBe('skill.disabled');
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
    [ErrorCodes.GOAL_UNSUPPORTED_AGENT, ErrorCode.GOAL_UNSUPPORTED_AGENT],
  ])('maps domain code %s to its wire equivalent', (code, wire) => {
    const env = mapError(new Error2(code, 'boom'), 'req-1');
    expect(env.code).toBe(wire);
  });

  it('falls back to INTERNAL_ERROR for coded errors without a wire equivalent', () => {
    const env = mapError(new Error2(ErrorCodes.OS_FS_UNKNOWN, 'boom'), 'req-1');
    expect(env.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});
