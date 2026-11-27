import { describe, expect, it } from 'vitest';

import {
  MEDIA_SIGNATURE_REUSE_THRESHOLD_MS,
  MEDIA_SIGNATURE_TTL_MS,
} from '../src/services/mediaSignature/constants';
import {
  createMediaSignatureService,
  type MediaSignatureTarget,
} from '../src/services/mediaSignature/mediaSignatureService';

function target(overrides: Partial<MediaSignatureTarget> = {}): MediaSignatureTarget {
  return {
    sessionId: 'session-1',
    path: 'media/clip.mp4',
    allowExternalSymlinks: true,
    ...overrides,
  };
}

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

const ROTATION_INTERVAL_MS = MEDIA_SIGNATURE_TTL_MS - MEDIA_SIGNATURE_REUSE_THRESHOLD_MS;

describe('media signature service', () => {
  it('reuses the current signature while more than the reuse threshold remains', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue(target());
    clock.advance(ROTATION_INTERVAL_MS - 1);
    const second = service.issue(target());
    expect(second.signature).toBe(first.signature);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it('rotates when the remaining lifetime reaches the reuse threshold', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue(target());
    clock.advance(ROTATION_INTERVAL_MS);
    const second = service.issue(target());
    expect(second.signature).not.toBe(first.signature);
    expect(second.expiresAt).toBe(first.expiresAt + ROTATION_INTERVAL_MS);
  });

  it('binds the signature to the session', () => {
    const { service } = serviceWithClock();
    const issued = service.issue(target());
    expect(service.validate(target(), issued.signature)).toBe(true);
    expect(service.validate(target({ sessionId: 'session-2' }), issued.signature)).toBe(false);
  });

  it('binds the signature to the file path', () => {
    const { service } = serviceWithClock();
    const issued = service.issue(target());
    expect(service.validate(target({ path: 'media/other.mp4' }), issued.signature)).toBe(false);
  });

  it('binds the signature to the external symlink flag', () => {
    const { service } = serviceWithClock();
    const issued = service.issue(target());
    expect(service.validate(target({ allowExternalSymlinks: false }), issued.signature)).toBe(false);
  });

  it('keeps earlier generations valid until their advertised expiry', () => {
    const { service, clock } = serviceWithClock();
    const first = service.issue(target());
    clock.advance(ROTATION_INTERVAL_MS + 1);
    service.issue(target());
    clock.advance(ROTATION_INTERVAL_MS + 1);
    service.issue(target());
    expect(clock.now()).toBeLessThan(first.expiresAt);
    expect(service.validate(target(), first.signature)).toBe(true);
  });

  it('rejects a signature after its lifetime expires', () => {
    const { service, clock } = serviceWithClock();
    const issued = service.issue(target());
    clock.advance(MEDIA_SIGNATURE_TTL_MS);
    expect(service.validate(target(), issued.signature)).toBe(false);
  });

  it('does not reuse an expired key', () => {
    const { service, clock } = serviceWithClock();
    const issued = service.issue(target());
    clock.advance(MEDIA_SIGNATURE_TTL_MS);
    const next = service.issue(target());
    expect(next.signature).not.toBe(issued.signature);
    expect(service.validate(target(), issued.signature)).toBe(false);
    expect(service.validate(target(), next.signature)).toBe(true);
  });
});