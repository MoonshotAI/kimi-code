import { describe, expect, it } from 'vitest';

import { rejectionText } from '../../src/renderer/debug/trace';

describe('rejectionText', () => {
  it('uses the error message for Error reasons', () => {
    expect(rejectionText(new Error('boom'))).toBe('boom');
  });

  it('stringifies plain reasons', () => {
    expect(rejectionText('nope')).toBe('nope');
    expect(rejectionText(42)).toBe('42');
  });

  it('falls back to a placeholder for unstringifiable reasons', () => {
    expect(rejectionText(Object.create(null))).toBe('[unstringifiable reason]');
  });
});
