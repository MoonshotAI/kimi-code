import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentKimiRegion, refreshKimiRegion } from '#/utils/region';

const originalEnv = { ...process.env };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kimi-region-test-'));
  process.env['KIMI_CODE_HOME'] = home;
  delete process.env['KIMI_CODE_OAUTH_HOST'];
  delete process.env['KIMI_OAUTH_HOST'];
  delete process.env['KIMI_CODE_REGION_MARKER'];
  refreshKimiRegion();
});

afterEach(() => {
  process.env = { ...originalEnv };
  refreshKimiRegion();
  rmSync(home, { recursive: true, force: true });
});

describe('currentKimiRegion', () => {
  it('follows the install-channel marker before the first login', () => {
    writeFileSync(join(home, 'region'), 'overseas\n');
    expect(refreshKimiRegion()).toBe('overseas');
    expect(currentKimiRegion()).toBe('overseas');
  });

  it('ignores the marker when KIMI_CODE_REGION_MARKER=off (embedded server)', () => {
    writeFileSync(join(home, 'region'), 'overseas\n');
    process.env['KIMI_CODE_REGION_MARKER'] = 'off';
    expect(refreshKimiRegion()).toBe('cn');
  });

  it('still honors a persisted overseas login when the marker is opted out', () => {
    writeFileSync(join(home, 'region'), 'overseas\n');
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "oauth/kimi-code-env-0123456789abcdef"',
        'oauthHost = "https://auth.kimi.ai"',
        '',
      ].join('\n'),
    );
    process.env['KIMI_CODE_REGION_MARKER'] = 'off';
    expect(refreshKimiRegion()).toBe('overseas');
  });
});
