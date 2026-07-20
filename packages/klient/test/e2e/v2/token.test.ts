/**
 * Unit tests for local server-token discovery (`src/v2/token.ts`).
 *
 * These do not boot a server; they exercise `loadLocalServerToken` and
 * `createTokenProvider` against a temp home dir. The end-to-end "client
 * authenticates using the discovered token" case lives in `smoke.test.ts`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SERVER_TOKEN_FILE,
  createTokenProvider,
  loadLocalServerToken,
  resolveKimiHome,
  serverTokenPath,
} from './helpers/token.js';

describe('local token discovery', () => {
  let home: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-token-test-'));
  });

  afterEach(async () => {
    if (home) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  it('resolveKimiHome honors explicit homeDir', async () => {
    expect(await resolveKimiHome('/tmp/custom')).toBe('/tmp/custom');
  });

  it('serverTokenPath joins the token filename', async () => {
    expect(await serverTokenPath('/tmp/home')).toBe(`/tmp/home/${SERVER_TOKEN_FILE}`);
  });

  it('reads a token from <home>/server.token', async () => {
    await writeFile(join(home as string, SERVER_TOKEN_FILE), '  abc123\n', { mode: 0o600 });
    const res = await loadLocalServerToken(home);
    expect(res.source).toBe('file');
    expect(res.token).toBe('abc123');
    expect(res.tokenPath).toBe(join(home as string, SERVER_TOKEN_FILE));
  });

  it('returns source none when the token file is missing', async () => {
    const res = await loadLocalServerToken(home);
    expect(res.source).toBe('none');
    expect(res.token).toBeUndefined();
  });

  it('returns source none when the token file is empty', async () => {
    await writeFile(join(home as string, SERVER_TOKEN_FILE), '  \n', { mode: 0o600 });
    const res = await loadLocalServerToken(home);
    expect(res.source).toBe('none');
    expect(res.token).toBeUndefined();
  });

  it('explicit token takes precedence over the file', async () => {
    await writeFile(join(home as string, SERVER_TOKEN_FILE), 'from-file', { mode: 0o600 });
    const provider = createTokenProvider({ token: 'explicit', homeDir: home });
    const res = await provider.resolve();
    expect(res.source).toBe('explicit');
    expect(res.token).toBe('explicit');
  });

  it('disableLocalToken skips the file', async () => {
    await writeFile(join(home as string, SERVER_TOKEN_FILE), 'from-file', { mode: 0o600 });
    const provider = createTokenProvider({ homeDir: home, disableLocalToken: true });
    const res = await provider.resolve();
    expect(res.source).toBe('none');
    expect(res.token).toBeUndefined();
  });

  it('caches the resolution across getToken calls', async () => {
    await writeFile(join(home as string, SERVER_TOKEN_FILE), 'cached', { mode: 0o600 });
    const provider = createTokenProvider({ homeDir: home });
    expect(await provider.getToken()).toBe('cached');
    // Remove the file — the cached value must still be served.
    await rm(join(home as string, SERVER_TOKEN_FILE));
    expect(await provider.getToken()).toBe('cached');
  });
});
