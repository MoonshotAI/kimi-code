import { describe, expect, it } from 'vitest';
import { playwrightEnv } from '../../../e2e/mode-env.ts';

describe('playwrightEnv', () => {
  it('defaults to headed mode and clears inherited mode flags', () => {
    const env = playwrightEnv(false, { PATH: '/bin', KIMI_E2E_HEADED: '0', KIMI_E2E_HEADLESS: '1' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('sets KIMI_E2E_HEADLESS in headless mode', () => {
    expect(playwrightEnv(true, { PATH: '/bin', KIMI_E2E_HEADED: '1' })).toEqual({ PATH: '/bin', KIMI_E2E_HEADLESS: '1' });
  });
});
