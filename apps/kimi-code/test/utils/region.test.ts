import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentKimiRegion, refreshKimiRegion, regionForBareLogin } from '#/utils/region';

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
    writeFileSync(join(home, 'region'), 'global\n');
    expect(refreshKimiRegion()).toBe('global');
    expect(currentKimiRegion()).toBe('global');
  });

  it('ignores the marker when KIMI_CODE_REGION_MARKER=off (embedded server)', () => {
    writeFileSync(join(home, 'region'), 'global\n');
    process.env['KIMI_CODE_REGION_MARKER'] = 'off';
    expect(refreshKimiRegion()).toBe('mainland-cn');
  });

  it('still honors a persisted global login when the marker is opted out', () => {
    writeFileSync(join(home, 'region'), 'global\n');
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
    expect(refreshKimiRegion()).toBe('global');
  });
});

describe('regionForBareLogin', () => {
  it('follows the resolved region for a fresh install (no persisted ref)', () => {
    expect(regionForBareLogin(undefined)).toBe('mainland-cn');
    writeFileSync(join(home, 'region'), 'global\n');
    refreshKimiRegion();
    expect(regionForBareLogin(undefined)).toBe('global');
  });

  it('re-pins mainland-cn for the default slot', () => {
    expect(regionForBareLogin({ key: 'oauth/kimi-code' })).toBe('mainland-cn');
  });

  it('keeps the configured environment for a scoped slot without a persisted host', () => {
    expect(regionForBareLogin({ key: 'oauth/kimi-code-env-0123456789abcdef' })).toBeUndefined();
  });

  it('keeps the persisted environment for a global login', () => {
    expect(
      regionForBareLogin({
        key: 'oauth/kimi-code-env-0123456789abcdef',
        oauthHost: 'https://auth.kimi.ai',
      }),
    ).toBeUndefined();
  });
});
