import { describe, expect, it } from 'vitest';

import { encodeWorkDirKey } from '#/sessionStore/sessionStoreService';

describe('encodeWorkDirKey', () => {
  it('is deterministic and path-sensitive', () => {
    const a = encodeWorkDirKey('/home/user/repo');
    const b = encodeWorkDirKey('/home/user/repo');
    const c = encodeWorkDirKey('/home/user/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('wd_')).toBe(true);
  });
});
