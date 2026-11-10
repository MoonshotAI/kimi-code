import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from '#/constants';
import { KIMI_CODE_OAUTH_KEY } from '#/managed-kimi-code';
import { DEFAULT_KIMI_CODE_BASE_URL } from '#/managed-usage';
import { KIMI_REGION_CACHE_FILENAME, type KimiRegionCacheRecord } from '#/region-cache';
import { detectKimiRegionFromLocalSignals } from '#/region-local';
import {
  createKimiRegionResolver,
  decideKimiRegion,
  type KimiRegionAuthRead,
  type KimiRegionAuthSnapshot,
} from '#/region-resolver';
import {
  KIMI_REGION_MARKER_FILENAME,
  KIMI_REGION_PROFILES,
  kimiRegionLoginHosts,
  kimiRegionProfile,
  kimiRegionSchema,
  resolveKimiRegion,
  resolveKimiRemoteControlAuth,
} from '#/region';

import { createTempWorkDir, type TempDirHandle } from './helpers';

describe('KIMI_REGION_PROFILES', () => {
  it('keeps the mainland-cn profile aligned with the shared defaults', () => {
    expect(KIMI_REGION_PROFILES['mainland-cn'].oauthHost).toBe(DEFAULT_KIMI_CODE_OAUTH_HOST);
    expect(KIMI_REGION_PROFILES['mainland-cn'].baseUrl).toBe(DEFAULT_KIMI_CODE_BASE_URL);
    expect(KIMI_REGION_PROFILES['mainland-cn'].relayOrigin).toBe('https://code-rc.kimi.com');
  });

  it('kimiRegionProfile returns the requested profile', () => {
    expect(kimiRegionProfile('global').oauthHost).toBe('https://auth.kimi.ai');
    expect(kimiRegionProfile('global').relayOrigin).toBe('https://code-rc.kimi.ai');
    expect(kimiRegionProfile('global').telemetryEndpoint).toBe(
      'https://telemetry-logs.kimi.ai/v1/event',
    );
    expect(kimiRegionProfile('mainland-cn').telemetryEndpoint).toBe(
      'https://telemetry-logs.kimi.com/v1/event',
    );
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

  it('detects region from consistent local signals and falls back on ambiguity', () => {
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' }),
    ).toEqual({ region: 'mainland-cn', confident: true });
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'America/New_York', locale: 'en-US' }),
    ).toEqual({ region: 'global', confident: true });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Taipei', locale: 'zh-Hant-TW' })).toEqual({
      region: 'global',
      confident: true,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'UTC', locale: 'zh-CN' })).toEqual({
      region: 'mainland-cn',
      confident: true,
    });
    expect(detectKimiRegionFromLocalSignals({})).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Shanghai', locale: 'en-US' }),
    ).toEqual({ region: 'mainland-cn', confident: false });
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

  it('reconciles auth state, persistent cache, and transient fallback', async () => {
    const loggedOut: KimiRegionAuthSnapshot = { status: 'logged-out' };
    const loggedInGlobal: KimiRegionAuthSnapshot = {
      status: 'logged-in',
      ref: { key: 'global', oauthHost: 'https://auth.kimi.ai' },
    };
    const noSignals = () => ({});
    const nySignals = () => ({ timeZone: 'America/New_York', locale: 'en-US' });
    const globalCacheRecord: KimiRegionCacheRecord = {
      version: 1,
      authState: 'logged-out',
      region: 'global',
      source: 'local-signals',
    };

    expect(decideKimiRegion({ auth: loggedOut, env: {}, signals: noSignals })).toEqual({
      resolution: { region: 'mainland-cn', source: 'fallback' },
      cacheAction: { kind: 'none' },
    });
    expect(decideKimiRegion({ auth: loggedInGlobal, env: {}, signals: noSignals })).toEqual({
      resolution: { region: 'global', source: 'login' },
      cacheAction: { kind: 'clear' },
    });
    expect(
      decideKimiRegion({ auth: loggedOut, env: {}, marker: 'global', signals: noSignals }),
    ).toEqual({
      resolution: { region: 'global', source: 'marker' },
      cacheAction: { kind: 'none' },
    });
    expect(
      decideKimiRegion({
        auth: loggedOut,
        env: {},
        cacheRecord: globalCacheRecord,
        signals: noSignals,
      }),
    ).toEqual({
      resolution: { region: 'global', source: 'local-signals' },
      cacheAction: { kind: 'none' },
    });
    expect(decideKimiRegion({ auth: loggedOut, env: {}, signals: nySignals })).toEqual({
      resolution: { region: 'global', source: 'local-signals' },
      cacheAction: { kind: 'write', region: 'global' },
    });
    expect(
      decideKimiRegion({
        auth: loggedInGlobal,
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com' },
        signals: noSignals,
      }),
    ).toEqual({
      resolution: { region: 'mainland-cn', source: 'env' },
      cacheAction: { kind: 'clear' },
    });

    const dir = await markerDir();
    let auth: KimiRegionAuthRead = { status: 'unreadable' };
    let signals: { readonly timeZone?: string; readonly locale?: string } = {
      timeZone: 'America/New_York',
      locale: 'en-US',
    };
    let collections = 0;
    const collectSignals = () => {
      collections += 1;
      return signals;
    };
    const resolver = createKimiRegionResolver({
      env: {},
      homeDir: dir,
      readAuth: () => auth,
      collectSignals,
    });
    const markerFile = join(dir, KIMI_REGION_MARKER_FILENAME);
    const cacheFile = join(dir, KIMI_REGION_CACHE_FILENAME);

    expect(resolver.current()).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(collections).toBe(0);
    await expect(readFile(cacheFile, 'utf-8')).rejects.toThrow();

    await writeFile(markerFile, 'global\n', 'utf-8');
    expect(resolver.current()).toEqual({ region: 'global', source: 'marker' });
    expect(collections).toBe(0);

    await writeFile(markerFile, 'apac', 'utf-8');
    expect(resolver.current()).toEqual({ region: 'mainland-cn', source: 'default' });

    auth = { status: 'logged-out' };
    expect(resolver.current()).toEqual({ region: 'global', source: 'local-signals' });
    expect(collections).toBe(1);
    expect(JSON.parse(await readFile(cacheFile, 'utf-8'))).toMatchObject({
      authState: 'logged-out',
      region: 'global',
      source: 'local-signals',
    });

    signals = { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' };
    expect(resolver.current()).toEqual({ region: 'global', source: 'local-signals' });
    expect(collections).toBe(1);

    await writeFile(markerFile, 'global\n', 'utf-8');
    expect(resolver.current()).toEqual({ region: 'global', source: 'marker' });
    expect(collections).toBe(1);

    await writeFile(markerFile, 'apac', 'utf-8');
    expect(resolver.current()).toEqual({ region: 'global', source: 'local-signals' });
    expect(collections).toBe(1);

    auth = loggedInGlobal;
    expect(resolver.current()).toEqual({ region: 'global', source: 'login' });
    await expect(readFile(cacheFile, 'utf-8')).rejects.toThrow();

    auth = { status: 'logged-in', ref: { key: KIMI_CODE_OAUTH_KEY } };
    expect(resolver.current()).toEqual({ region: 'mainland-cn', source: 'login' });

    auth = { status: 'logged-out' };
    signals = {};
    expect(resolver.current()).toEqual({ region: 'mainland-cn', source: 'fallback' });
    expect(collections).toBe(2);
    await expect(readFile(cacheFile, 'utf-8')).rejects.toThrow();

    signals = { timeZone: 'America/New_York', locale: 'en-US' };
    expect(resolver.current()).toEqual({ region: 'mainland-cn', source: 'fallback' });
    expect(collections).toBe(2);

    expect(resolver.refresh()).toEqual({ region: 'global', source: 'local-signals' });
    expect(collections).toBe(3);

    await writeFile(cacheFile, '{', 'utf-8');
    expect(resolver.current()).toEqual({ region: 'global', source: 'local-signals' });
    expect(collections).toBe(4);
    expect(JSON.parse(await readFile(cacheFile, 'utf-8'))).toMatchObject({ region: 'global' });

    expect(resolver.current()).toEqual({ region: 'global', source: 'local-signals' });
    expect(collections).toBe(4);

    const noInference = createKimiRegionResolver({
      env: {},
      homeDir: dir,
      readAuth: () => auth,
      allowLocalInference: false,
      collectSignals,
    });
    expect(noInference.current()).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(collections).toBe(4);

    const noMarker = createKimiRegionResolver({
      env: {},
      homeDir: dir,
      readAuth: () => auth,
      readMarker: false,
      collectSignals,
    });
    expect(noMarker.current()).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(collections).toBe(4);

    const baseUrlEnv = createKimiRegionResolver({
      env: { KIMI_CODE_BASE_URL: 'https://api.example.com/coding/v1' },
      homeDir: dir,
      readAuth: () => auth,
      collectSignals,
    });
    expect(baseUrlEnv.current()).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(collections).toBe(4);

    const envPinned = createKimiRegionResolver({
      env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai' },
      homeDir: dir,
      readAuth: () => auth,
    });
    expect(envPinned.current()).toEqual({ region: 'global', source: 'env' });
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
    const key = 'oauth/kimi-code-env-0123456789abcdef';
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthKey: key,
        homeDir: dir,
      }),
    ).toBe('global');
    expect(resolveKimiRemoteControlAuth({ env: {}, configuredOAuthKey: key, homeDir: dir })).toEqual({
      region: 'global',
      oauthKey: key,
      relayOrigin: 'https://code-rc.kimi.com',
    });
  });

  it('resolves a recognized persisted host before consulting the key', () => {
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        configuredOAuthKey: KIMI_CODE_OAUTH_KEY,
      }),
    ).toBe('global');
    expect(
      resolveKimiRemoteControlAuth({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        configuredOAuthKey: 'oauth/kimi-code-env-0123456789abcdef',
      }).relayOrigin,
    ).toBe('https://code-rc.kimi.ai');
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
