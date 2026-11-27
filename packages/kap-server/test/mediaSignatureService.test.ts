import { describe, expect, it } from 'vitest';

import {
  MEDIA_SIGNATURE_REUSE_THRESHOLD_MS,
  MEDIA_SIGNATURE_TTL_MS,
} from '../src/services/mediaSignature/constants';
import { createMediaSignatureService } from '../src/services/mediaSignature/mediaSignatureService';

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function serviceWithClock(): {
  service: ReturnType<typeof createMediaSignatureService>;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  return { service: createMediaSignatureService({ now: clock.now }), clock };
}

describe('media signature service', () => {
  it('reuses the current signature while more than the reuse threshold remains', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS - 1);
    const second = service.issue();
    expect(second.signature).toBe(first.signature);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it('rotates when the remaining lifetime reaches the reuse threshold', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS);
    const second = service.issue();
    expect(second.signature).not.toBe(first.signature);
    expect(second.expiresAt).toBe(first.expiresAt + MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS);
  });

  it('accepts both the new and the previous signature while they coexist', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS + 1);
    const second = service.issue();
    expect(service.validate(first.signature)).toBe(true);
    expect(service.validate(second.signature)).toBe(true);
  });

  it('rejects a signature after its lifetime expires', () => {
    const { service, clock } = serviceWithClock();
    const issued = service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS);
    expect(service.validate(issued.signature)).toBe(false);
  });

  it('forgets the oldest signature once two newer generations exist', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS + 1);
    service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS + 1);
    const third = service.issue();
    expect(service.validate(first.signature)).toBe(false);
    expect(service.validate(third.signature)).toBe(true);
  });

  it('does not reuse an expired current signature', () => {
    const { service, clock } = serviceWithClock();
    const issued = service.issue();
    clock.advance(MEDIA_SIGNATURE_TTL_MS);
    const next = service.issue();
    expect(next.signature).not.toBe(issued.signature);
    expect(service.validate(issued.signature)).toBe(false);
    expect(service.validate(next.signature)).toBe(true);
  });
});