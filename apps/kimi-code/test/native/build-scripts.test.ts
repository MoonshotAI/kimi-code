import { describe, expect, it } from 'vitest';

import { SEA_EXEC_ARGV, seaCodeCacheEnabled } from '../../scripts/native/sea-options.mjs';

describe('sea-options', () => {
  it('bakes a bounded young generation into the binary', () => {
    expect(SEA_EXEC_ARGV).toEqual(['--max-semi-space-size=16']);
    expect(Object.isFrozen(SEA_EXEC_ARGV)).toBe(true);
  });

  it('only enables the V8 code cache when the target matches the build host', () => {
    expect(seaCodeCacheEnabled('darwin-arm64', 'darwin-arm64')).toBe(true);
    expect(seaCodeCacheEnabled('linux-x64', 'darwin-arm64')).toBe(false);
  });
});
