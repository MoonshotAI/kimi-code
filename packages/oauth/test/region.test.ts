import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from '#/constants';
import { KIMI_CODE_OAUTH_KEY } from '#/managed-kimi-code';
import { DEFAULT_KIMI_CODE_BASE_URL } from '#/managed-usage';
import {
  KIMI_REGION_MARKER_FILENAME,
  KIMI_REGION_PROFILES,
  kimiRegionLoginHosts,
  kimiRegionProfile,
  kimiRegionSchema,
  resolveKimiRegion,
} from '#/region';

import { createTempWorkDir, type TempDirHandle } from './helpers';

describe('KIMI_REGION_PROFILES', () => {
  it('keeps the mainland-cn profile aligned with the shared defaults', () => {
    expect(KIMI_REGION_PROFILES['mainland-cn'].oauthHost).toBe(DEFAULT_KIMI_CODE_OAUTH_HOST);
    expect(KIMI_REGION_PROFILES['mainland-cn'].baseUrl).toBe(DEFAULT_KIMI_CODE_BASE_URL);
  });

  it('kimiRegionProfile returns the requested profile', () => {
    expect(kimiRegionProfile('global').oauthHost).toBe('https://auth.kimi.ai');
    expect(kimiRegionProfile('mainland-cn')).toBe(KIMI_REGION_PROFILES['mainland-cn']);
  });
});

describe('resolveKimiRegion', () => {
  let workDir: TempDirHandle | undefined;

  afterEach(async () => {
    await workDir?.cleanup();
    workDir = undefined;
  });

  async function markerDir(contents?: string): Promise<string> {
    workDir = await createTempWorkDir();
    if (contents !== undefined) {
      await writeFile(join(workDir.path, KIMI_REGION_MARKER_FILENAME), contents, 'utf-8');
    }
    return workDir.path;
  }

  it('defaults to mainland-cn when nothing points anywhere', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir() })).toBe('mainland-cn');
  });

  it('resolves a known env oauth host, KIMI_CODE_OAUTH_HOST first', () => {
    expect(resolveKimiRegion({ env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai' } })).toBe(
      'global',
    );
    expect(resolveKimiRegion({ env: { KIMI_OAUTH_HOST: 'https://auth.kimi.ai' } })).toBe(
      'global',
    );
    expect(
      resolveKimiRegion({
        env: {
          KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com',
          KIMI_OAUTH_HOST: 'https://auth.kimi.ai',
        },
      }),
    ).toBe('mainland-cn');
  });

  it('treats an unknown env host as a custom environment and falls back to cn', async () => {
    // ...even when the persisted login or marker says otherwise: the custom
    // env overrides every endpoint anyway.
    expect(
      resolveKimiRegion({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.internal.example.com' },
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: await markerDir('global\n'),
      }),
    ).toBe('mainland-cn');
  });

  it('resolves the persisted login host, tolerating trailing slashes', () => {
    expect(resolveKimiRegion({ env: {}, configuredOAuthHost: 'https://auth.kimi.ai/' })).toBe(
      'global',
    );
    expect(resolveKimiRegion({ env: {}, configuredOAuthHost: 'https://auth.kimi.com' })).toBe('mainland-cn');
  });

  it('ignores an unrecognized persisted host and continues down the chain', async () => {
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.legacy.example.com',
        homeDir: await markerDir('global'),
      }),
    ).toBe('global');
  });

  it('reads the install-channel marker when nothing else decides', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('global\n') })).toBe('global');
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('  mainland-cn  ') })).toBe('mainland-cn');
  });

  it('ignores a malformed or missing marker', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('apac') })).toBe('mainland-cn');
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('') })).toBe('mainland-cn');
  });

  it('skips the marker entirely when readMarker is false', async () => {
    expect(
      resolveKimiRegion({ env: {}, homeDir: await markerDir('global'), readMarker: false }),
    ).toBe('mainland-cn');
  });

  it('honors KIMI_CODE_HOME when homeDir is not passed explicitly', async () => {
    const dir = await markerDir('global');
    expect(resolveKimiRegion({ env: { KIMI_CODE_HOME: dir } })).toBe('global');
  });

  it('env beats persisted login beats marker', async () => {
    const dir = await markerDir('global');
    expect(
      resolveKimiRegion({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com' },
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
      }),
    ).toBe('mainland-cn');
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
      }),
    ).toBe('global');
  });

  it('treats the persisted default-slot key as explicit mainland-cn, beating the marker', async () => {
    const dir = await markerDir('global');
    expect(
      resolveKimiRegion({ env: {}, configuredOAuthKey: KIMI_CODE_OAUTH_KEY, homeDir: dir }),
    ).toBe('mainland-cn');
  });

  it('still follows the marker when no key or host is persisted', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('global') })).toBe('global');
  });

  it('lets an unknown scoped key fall through to the marker', async () => {
    const dir = await markerDir('global');
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthKey: 'oauth/kimi-code-env-0123456789abcdef',
        homeDir: dir,
      }),
    ).toBe('global');
  });

  it('resolves a recognized persisted host before consulting the key', () => {
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        configuredOAuthKey: KIMI_CODE_OAUTH_KEY,
      }),
    ).toBe('global');
  });
});

describe('kimiRegionLoginHosts', () => {
  it('returns both profile hosts, mainland-cn included (explicit beats stale config)', () => {
    expect(kimiRegionLoginHosts('mainland-cn', {})).toEqual({
      oauthHost: 'https://auth.kimi.com',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    expect(kimiRegionLoginHosts('global', {})).toEqual({
      oauthHost: 'https://auth.kimi.ai',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
  });

  it('yields to env overrides', () => {
    expect(kimiRegionLoginHosts('global', { KIMI_CODE_OAUTH_HOST: 'https://auth.x.com' })).toBe(
      undefined,
    );
    expect(kimiRegionLoginHosts('global', { KIMI_OAUTH_HOST: 'https://auth.x.com' })).toBe(
      undefined,
    );
    expect(
      kimiRegionLoginHosts('global', { KIMI_CODE_BASE_URL: 'https://api.x.com/coding/v1' }),
    ).toBe(undefined);
  });
});

describe('kimiRegionSchema', () => {
  it('parses valid regions and rejects others', () => {
    expect(kimiRegionSchema.parse('mainland-cn')).toBe('mainland-cn');
    expect(kimiRegionSchema.parse('global')).toBe('global');
    expect(kimiRegionSchema.safeParse('apac').success).toBe(false);
  });
});
