import { describe, expect, it } from 'vitest';

import { CURRENT_VERSION, MIN_PROTOCOL_VERSION, negotiateVersion } from '../src/version';

describe('negotiateVersion', () => {
  it('returns CURRENT_VERSION when the client version is below MIN_PROTOCOL_VERSION', () => {
    const result = negotiateVersion(0);
    expect(result).toBe(CURRENT_VERSION);
    expect(result.protocolVersion).toBe(1);
  });

  it('returns the matching spec when the client requests the current version', () => {
    const result = negotiateVersion(1);
    expect(result).toBe(CURRENT_VERSION);
    expect(result.protocolVersion).toBe(1);
    expect(result.specTag).toBe('v0.10.x');
    expect(result.sdkVersion).toBe('0.23.0');
  });

  it('returns the highest supported version when the client advertises a newer one', () => {
    const result = negotiateVersion(99);
    expect(result).toBe(CURRENT_VERSION);
    expect(result.protocolVersion).toBe(1);
  });

  it('exposes MIN_PROTOCOL_VERSION = 1', () => {
    expect(MIN_PROTOCOL_VERSION).toBe(1);
  });
});
