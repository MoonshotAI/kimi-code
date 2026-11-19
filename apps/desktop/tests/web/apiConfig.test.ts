import { describe, expect, it } from 'vitest';

import { readKimiApiConfig } from '../../src/renderer/api/config';

describe('readKimiApiConfig identity', () => {
  it('falls back to the web identity when the desktop define is absent', () => {
    const config = readKimiApiConfig();
    expect(config.clientName).toBe('kimi-code-web');
    expect(config.clientUiMode).toBe('web');
  });
});
