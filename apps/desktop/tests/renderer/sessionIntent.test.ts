import { describe, expect, it } from 'vitest';

import { consumeSessionIntent, setSessionIntent } from '../../src/renderer/lib/session-intent';

// The pending intent is module-level state, so each case starts by draining
// whatever a previous case left behind.
describe('session-intent', () => {
  it('returns the fallback when no intent was declared', () => {
    consumeSessionIntent('sidebar');
    expect(consumeSessionIntent('sidebar')).toBe('sidebar');
  });

  it('returns the declared source instead of the fallback', () => {
    consumeSessionIntent('sidebar');
    setSessionIntent('shortcut');
    expect(consumeSessionIntent('sidebar')).toBe('shortcut');
  });

  it('is single-use: a second consume falls back again', () => {
    consumeSessionIntent('sidebar');
    setSessionIntent('tray');
    expect(consumeSessionIntent('sidebar')).toBe('tray');
    expect(consumeSessionIntent('sidebar')).toBe('sidebar');
  });

  it('a later declaration overwrites an unconsumed one', () => {
    consumeSessionIntent('sidebar');
    setSessionIntent('menu');
    setSessionIntent('jump_list');
    expect(consumeSessionIntent('sidebar')).toBe('jump_list');
  });
});
