import { describe, it, expect, vi } from 'vitest';

import { patchGithubProviderForChannel, resolveGhToken, type GithubProviderLike } from '../../src/main/canary-updater';

function fakeProvider(): GithubProviderLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getDefaultChannelName: () => 'latest-mac',
    getCustomChannelName: (channel: string) => `${channel}-mac`,
    getBlockMapFiles: () => Promise.resolve([]),
    configureHeaders: (accept: string) => ({ accept, authorization: 'token x' }),
    httpRequest: vi.fn(async (url: URL) => {
      calls.push(url.pathname);
      const version = /v(.+)$/.exec(url.pathname)?.[1];
      if (version === '0.0.20-canary.9') {
        return JSON.stringify({ assets: [] });
      }
      return JSON.stringify({
        assets: [
          { name: `KimiCodeCanary-${version}-mac-arm64.zip`, url: `https://api.github.com/assets/zip-${version}` },
          { name: `KimiCodeCanary-${version}-mac-arm64.zip.blockmap`, url: `https://api.github.com/assets/bm-${version}` },
          { name: `KimiCodeCanary-${version}-mac-arm64.dmg`, url: `https://api.github.com/assets/dmg-${version}` },
        ],
      });
    }) as GithubProviderLike['httpRequest'],
  };
}

describe('patchGithubProviderForChannel', () => {
  it('points the default channel name at the build channel', () => {
    const provider = fakeProvider();
    patchGithubProviderForChannel(provider, 'canary');
    expect(provider.getDefaultChannelName()).toBe('canary-mac');
  });

  it('resolves old and new blockmap asset URLs from the release asset lists', async () => {
    const provider = fakeProvider();
    patchGithubProviderForChannel(provider, 'canary');
    const [oldUrl, newUrl] = await provider.getBlockMapFiles(new URL('https://example.com/zip'), '0.0.20-canary.10', '0.0.20-canary.11');
    expect(oldUrl!.href).toBe('https://api.github.com/assets/bm-0.0.20-canary.10');
    expect(newUrl!.href).toBe('https://api.github.com/assets/bm-0.0.20-canary.11');
    expect(provider.calls).toEqual([
      '/repos/MoonshotAI/kimi-code-app/releases/tags/v0.0.20-canary.11',
      '/repos/MoonshotAI/kimi-code-app/releases/tags/v0.0.20-canary.10',
    ]);
  });

  it('throws when the blockmap asset is missing', async () => {
    const provider = fakeProvider();
    patchGithubProviderForChannel(provider, 'canary');
    await expect(provider.getBlockMapFiles(new URL('https://example.com/zip'), '0.0.20-canary.9', '0.0.20-canary.11')).rejects.toThrow(
      'blockmap asset for 0.0.20-canary.9 not found',
    );
  });
});

describe('resolveGhToken', () => {
  it('returns the trimmed token from gh', async () => {
    const token = await resolveGhToken({
      exists: () => true,
      platform: 'darwin',
      exec: vi.fn(async () => ({ stdout: 'tok_abc123\n', stderr: '' })),
    });
    expect(token).toBe('tok_abc123');
  });

  it('returns null when gh is missing or unauthenticated (never throws)', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    await expect(
      resolveGhToken({ exists: () => false, platform: 'darwin', exec: vi.fn(async () => { throw enoent; }) }),
    ).resolves.toBeNull();
    await expect(
      resolveGhToken({ exists: () => true, platform: 'darwin', exec: vi.fn(async () => { throw new Error('not logged in'); }) }),
    ).resolves.toBeNull();
  });
});
