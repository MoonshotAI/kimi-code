/**
 * Scenario: session-ownership error details payloads (SESSION_HELD_BY_PEER).
 * Responsibilities: verify the discriminated-union wire shape, phase enum, and
 * retryhint validation.
 * Wiring: pure protocol schemas; no external boundaries.
 * Run: `pnpm --filter @moonshot-ai/protocol exec vitest run src/__tests__/session-ownership.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  sessionOwnershipDetailsSchema,
  sessionOwnershipPhaseSchema,
  type SessionOwnershipDetails,
} from '../session-ownership';

describe('sessionOwnershipPhaseSchema', () => {
  it('accepts every documented phase', () => {
    for (const phase of ['creating', 'routable', 'holder-unresponsive', 'held-by-local-instance']) {
      expect(sessionOwnershipPhaseSchema.parse(phase)).toBe(phase);
    }
  });

  it('rejects unknown phases', () => {
    expect(sessionOwnershipPhaseSchema.safeParse('redirect').success).toBe(false);
    expect(sessionOwnershipPhaseSchema.safeParse('').success).toBe(false);
  });
});

describe('sessionOwnershipDetailsSchema', () => {
  it('parses a routable held-by-peer payload carrying an address', () => {
    const payload: SessionOwnershipDetails = {
      kind: 'held-by-peer',
      phase: 'routable',
      address: 'http://127.0.0.1:58628',
    };
    expect(sessionOwnershipDetailsSchema.parse(payload)).toEqual(payload);
  });

  it('parses a retryable payload carrying retry_after_ms', () => {
    const payload = { kind: 'held-by-peer', phase: 'holder-unresponsive', retry_after_ms: 1500 };
    expect(sessionOwnershipDetailsSchema.parse(payload)).toEqual(payload);
  });

  it('parses a bare held-by-peer payload with no optional hints', () => {
    const payload = { kind: 'held-by-peer', phase: 'held-by-local-instance' };
    expect(sessionOwnershipDetailsSchema.parse(payload)).toEqual(payload);
  });

  it('parses the unregistered-writer variant', () => {
    expect(sessionOwnershipDetailsSchema.parse({ kind: 'unregistered-writer' })).toEqual({
      kind: 'unregistered-writer',
    });
  });

  it('rejects an unknown kind', () => {
    expect(sessionOwnershipDetailsSchema.safeParse({ kind: 'stolen', phase: 'routable' }).success).toBe(false);
  });

  it('rejects a held-by-peer payload without phase', () => {
    expect(sessionOwnershipDetailsSchema.safeParse({ kind: 'held-by-peer' }).success).toBe(false);
  });

  it('rejects a negative or fractional retry_after_ms', () => {
    expect(
      sessionOwnershipDetailsSchema.safeParse({ kind: 'held-by-peer', phase: 'creating', retry_after_ms: -1 })
        .success,
    ).toBe(false);
    expect(
      sessionOwnershipDetailsSchema.safeParse({ kind: 'held-by-peer', phase: 'creating', retry_after_ms: 1.5 })
        .success,
    ).toBe(false);
  });
});
