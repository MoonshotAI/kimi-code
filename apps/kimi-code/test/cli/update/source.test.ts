import { describe, expect, it } from 'vitest';

import {
  classifyByPathHeuristic,
  classifyInstallSource,
  detectInstallSource,
} from '#/cli/update/source';

describe('classifyByPathHeuristic', () => {
  it('returns null for an npm-style global path (handled by classifyInstallSource)', () => {
    expect(classifyByPathHeuristic('/usr/local/lib/node_modules/@moonshot-ai/kimi-code')).toBeNull();
  });

  it('detects pnpm global on macOS', () => {
    expect(
      classifyByPathHeuristic('/Users/me/Library/pnpm/global/5/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('pnpm-global');
  });

  it('detects pnpm global on Linux', () => {
    expect(
      classifyByPathHeuristic('/home/me/.local/share/pnpm/global/5/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('pnpm-global');
  });

  it('detects pnpm global on Windows (normalized backslashes)', () => {
    expect(
      classifyByPathHeuristic('C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@moonshot-ai/kimi-code'),
    ).toBe('pnpm-global');
  });

  it('detects yarn classic global', () => {
    expect(
      classifyByPathHeuristic('/Users/me/.config/yarn/global/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('yarn-global');
  });

  it('detects yarn berry global (~/.yarn/global)', () => {
    expect(
      classifyByPathHeuristic('/Users/me/.yarn/global/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('yarn-global');
  });

  it('detects bun global', () => {
    expect(
      classifyByPathHeuristic('/Users/me/.bun/install/global/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('bun-global');
  });

  it('detects homebrew on macOS (Cellar path)', () => {
    expect(
      classifyByPathHeuristic('/opt/homebrew/Cellar/kimi-code/0.5.0/libexec/lib/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('homebrew');
  });

  it('detects homebrew on Linux (Linuxbrew)', () => {
    expect(
      classifyByPathHeuristic('/home/linuxbrew/.linuxbrew/Cellar/kimi-code/0.5.0/libexec/lib/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('homebrew');
  });

  it('does not treat npm-global under Homebrew prefix as homebrew', () => {
    expect(
      classifyByPathHeuristic('/opt/homebrew/lib/node_modules/@moonshot-ai/kimi-code'),
    ).toBeNull();
  });

  it('returns null for an unknown layout', () => {
    expect(classifyByPathHeuristic('/Users/me/dev/@moonshot-ai/kimi-code')).toBeNull();
  });
});

describe('classifyInstallSource (npm prefix matching)', () => {
  it('matches a macOS/Linux npm global package path', () => {
    expect(
      classifyInstallSource('/usr/local/lib/node_modules/@moonshot-ai/kimi-code', '/usr/local', 'darwin'),
    ).toBe('npm-global');
  });

  it('returns unsupported when the package path does not match the prefix', () => {
    expect(
      classifyInstallSource('/Users/me/dev/@moonshot-ai/kimi-code', '/usr/local', 'darwin'),
    ).toBe('unsupported');
  });
});

describe('detectInstallSource', () => {
  it('returns pnpm-global when packageRoot matches pnpm heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () =>
          '/Users/me/Library/pnpm/global/5/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('pnpm-global');
  });

  it('returns yarn-global when packageRoot matches yarn heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/.config/yarn/global/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('yarn-global');
  });

  it('returns bun-global when packageRoot matches bun heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/.bun/install/global/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('bun-global');
  });

  it('returns npm-global when packageRoot matches npm prefix', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/usr/local/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('npm-global');
  });

  it('returns homebrew when packageRoot matches Cellar heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () =>
          '/opt/homebrew/Cellar/kimi-code/0.5.0/libexec/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('homebrew');
  });

  it('returns native when SEA isSea() is true (highest priority)', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/usr/local/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => true,
        platform: 'darwin',
      }),
    ).resolves.toBe('native');
  });

  it('returns unsupported when nothing matches', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/dev/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('unsupported');
  });

  it('returns unsupported when npm prefix lookup throws', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/dev/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => {
          throw new Error('prefix failed');
        },
        detectNative: () => false,
        platform: 'darwin',
      }),
    ).resolves.toBe('unsupported');
  });
});
