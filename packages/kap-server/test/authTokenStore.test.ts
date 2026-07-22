/**
 * Scenario: persistent server credentials and password verification.
 * Responsibilities: private token storage, rotation, password caching, and auth composition.
 * Wiring: real filesystem/crypto/bcrypt; comparator and clock seams are controlled where needed.
 * Run: pnpm --filter @moonshot-ai/kap-server exec vitest run test/authTokenStore.test.ts
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PrivateFileTooPermissiveError,
  readPrivateFile,
  writePrivateFile,
} from '../src/services/auth/privateFiles';
import {
  loadOrCreateServerToken,
  rotateServerToken,
} from '../src/services/auth/persistentToken';
import { createTokenStore } from '../src/services/auth/tokenStore';
import { createAuthTokenService } from '../src/services/auth/authTokenService';
import { createCredentialValidator } from '../src/services/auth/credentials';
import { createPasswordVerifier, resolvePasswordHash } from '../src/services/auth/password';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-v2-auth-token-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('privateFiles', () => {
  it.skipIf(process.platform === 'win32')('writes a file with mode 0600', async () => {
    const p = join(tmpDir, 'secret');
    await writePrivateFile(p, 'hello');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates an absent parent dir with mode 0700', async () => {
    const p = join(tmpDir, 'nested', 'dir', 'secret');
    await writePrivateFile(p, 'hello');
    expect(statSync(join(tmpDir, 'nested', 'dir')).mode & 0o777).toBe(0o700);
  });

  it('round-trips string content through readPrivateFile', async () => {
    const p = join(tmpDir, 'secret');
    await writePrivateFile(p, 's3cr3t-value');
    const buf = await readPrivateFile(p);
    expect(buf.toString('utf8')).toBe('s3cr3t-value');
  });

  it('round-trips Buffer content through readPrivateFile', async () => {
    const p = join(tmpDir, 'bin');
    const data = Buffer.from([0, 1, 2, 254, 255]);
    await writePrivateFile(p, data);
    const buf = await readPrivateFile(p);
    expect(buf.equals(data)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('readPrivateFile throws on a 0644 file', async () => {
    const p = join(tmpDir, 'leaky');
    writeFileSync(p, 'x', { mode: 0o644 });
    chmodSync(p, 0o644);
    await expect(readPrivateFile(p)).rejects.toThrowError(PrivateFileTooPermissiveError);
  });
});

describe('tokenStore', () => {
  it('returns the same token from repeated getToken() calls', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    expect(store.getToken()).toBe(store.getToken());
    await store.dispose();
  });

  it('produces different tokens for different home dirs', async () => {
    const a = await createTokenStore(join(tmpDir, 'home-a'));
    const b = await createTokenStore(join(tmpDir, 'home-b'));
    expect(a.getToken()).not.toBe(b.getToken());
    await a.dispose();
    await b.dispose();
  });

  it('reuses the same persistent token across stores in one home dir', async () => {
    const home = join(tmpDir, 'home');
    const a = await createTokenStore(home);
    const token = a.getToken();
    await a.dispose();
    const b = await createTokenStore(home);
    expect(b.getToken()).toBe(token);
    await b.dispose();
  });

  it.skipIf(process.platform === 'win32')('writes the token file with mode 0600 at server.token', async () => {
    const home = join(tmpDir, 'home');
    const store = await createTokenStore(home);
    expect(store.tokenPath).toBe(join(home, 'server.token'));
    expect(statSync(store.tokenPath).mode & 0o777).toBe(0o600);
    await store.dispose();
  });

  it('isValid accepts the token and rejects wrong / empty / same-length candidates', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const token = store.getToken();
    expect(store.isValid(token)).toBe(true);
    expect(store.isValid('wrong')).toBe(false);
    expect(store.isValid('')).toBe(false);

    const other = await createTokenStore(join(tmpDir, 'home-other'));
    expect(other.getToken().length).toBe(token.length);
    expect(store.isValid(other.getToken())).toBe(false);
    await store.dispose();
    await other.dispose();
  });

  it('dispose() keeps the persistent token file on disk', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    expect(existsSync(store.tokenPath)).toBe(true);
    await store.dispose();
    expect(existsSync(store.tokenPath)).toBe(true);
  });

  it('re-reads the token after the file is rewritten (live rotation)', async () => {
    const home = join(tmpDir, 'home');
    const store = await createTokenStore(home);
    const original = store.getToken();
    const rotated = 'r'.repeat(original.length);
    await writePrivateFile(store.tokenPath, rotated);

    expect(store.getToken()).toBe(rotated);
    expect(store.isValid(rotated)).toBe(true);
    expect(store.isValid(original)).toBe(false);
    await store.dispose();
  });
});

describe('persistentToken', () => {
  it('loadOrCreateServerToken generates once and reuses thereafter', async () => {
    const home = join(tmpDir, 'home');
    const a = await loadOrCreateServerToken(home);
    const b = await loadOrCreateServerToken(home);
    expect(a).toBe(b);
  });

  it.skipIf(process.platform === 'win32')('writes server.token with mode 0600', async () => {
    const home = join(tmpDir, 'home');
    await loadOrCreateServerToken(home);
    expect(statSync(join(home, 'server.token')).mode & 0o777).toBe(0o600);
  });

  it('rotateServerToken writes a new, different token to server.token', async () => {
    const home = join(tmpDir, 'home');
    const original = await loadOrCreateServerToken(home);
    const rotated = await rotateServerToken(home);
    expect(rotated).not.toBe(original);
    expect(readFileSync(join(home, 'server.token'), 'utf8').trim()).toBe(rotated);
  });
});

describe('password', () => {
  it('resolvePasswordHash returns undefined when env is unset or empty', async () => {
    expect(await resolvePasswordHash({})).toBeUndefined();
    expect(await resolvePasswordHash({ KIMI_CODE_PASSWORD: '' })).toBeUndefined();
  });

  it('hashes a set password with bcrypt and verifies it through the cached verifier', async () => {
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct-horse-battery-staple',
    });
    const verify = createPasswordVerifier(passwordHash);
    expect(passwordHash?.startsWith('$2')).toBe(true);
    expect(await verify('correct-horse-battery-staple')).toBe(true);
    expect(await verify('wrong-password')).toBe(false);
  });

  it('returns false without consulting the comparator when the hash is undefined', async () => {
    const compare = vi.fn(async () => true);
    const verify = createPasswordVerifier(undefined, { compare });

    expect(await verify('anything')).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });

  it('runs a fresh comparison when the prior password verdict was false', async () => {
    const compare = vi.fn(async () => false);
    const verify = createPasswordVerifier('password-hash', { compare });

    expect(await verify('wrong-password')).toBe(false);
    expect(await verify('wrong-password')).toBe(false);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('returns a cached success when the verified candidate is checked again', async () => {
    const compare = vi.fn(async () => true);
    const verify = createPasswordVerifier('password-hash', { compare });

    expect(await verify('correct-password')).toBe(true);
    expect(await verify('correct-password')).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('keeps a cached successful candidate isolated from a failed candidate', async () => {
    const compare = vi.fn(async (candidate: string) => candidate === 'correct-password');
    const verify = createPasswordVerifier('password-hash', { compare });

    expect(await verify('correct-password')).toBe(true);
    expect(await verify('wrong-password')).toBe(false);
    expect(await verify('correct-password')).toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('runs one comparison when the same invalid candidate overlaps', async () => {
    let settleComparison!: (valid: boolean) => void;
    const comparison = new Promise<boolean>((resolve) => {
      settleComparison = resolve;
    });
    const compare = vi.fn(() => comparison);
    const verify = createPasswordVerifier('password-hash', { compare });

    const first = verify('wrong-password');
    const second = verify('wrong-password');
    expect(compare).toHaveBeenCalledTimes(1);

    settleComparison(false);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
  });

  it('starts independent comparisons when distinct candidates overlap', async () => {
    let settleFirst!: (valid: boolean) => void;
    let settleSecond!: (valid: boolean) => void;
    const compare = vi.fn((candidate: string) => new Promise<boolean>((resolve) => {
      if (candidate === 'first-password') {
        settleFirst = resolve;
      } else {
        settleSecond = resolve;
      }
    }));
    const verify = createPasswordVerifier('password-hash', { compare });

    const first = verify('first-password');
    const second = verify('second-password');
    expect(compare).toHaveBeenCalledTimes(2);

    settleFirst(true);
    settleSecond(false);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('returns a fresh verdict when the prior in-flight comparison throws', async () => {
    let attempts = 0;
    const compare = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('bcrypt failed');
      }
      return true;
    });
    const verify = createPasswordVerifier('password-hash', { compare });

    await expect(verify('correct-password')).rejects.toThrow('bcrypt failed');
    await expect(verify('correct-password')).resolves.toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('revalidates at the fixed expiry when intervening cache hits occur', async () => {
    let now = 0;
    const compare = vi.fn(async () => true);
    const verify = createPasswordVerifier('password-hash', {
      compare,
      now: () => now,
    });

    expect(await verify('correct-password')).toBe(true);
    now = 5 * 60_000 - 1;
    expect(await verify('correct-password')).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);

    now = 5 * 60_000;
    expect(await verify('correct-password')).toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
  });
});

describe('createAuthTokenService', () => {
  it('getToken() returns the tokenStore token', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({ tokenStore: store, passwordHash: undefined });
    expect(svc.getToken()).toBe(store.getToken());
    await store.dispose();
  });

  it('isValid accepts the token', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({ tokenStore: store, passwordHash: undefined });
    expect(await svc.isValid(store.getToken())).toBe(true);
    await store.dispose();
  });

  it('isValid accepts the password when a hash is configured', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct horse battery staple',
    });
    const svc = createAuthTokenService({ tokenStore: store, passwordHash });
    expect(await svc.isValid('correct horse battery staple')).toBe(true);
    await store.dispose();
  });

  it('isValid rejects a wrong candidate', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct horse battery staple',
    });
    const svc = createAuthTokenService({ tokenStore: store, passwordHash });
    expect(await svc.isValid('wrong')).toBe(false);
    await store.dispose();
  });

  it('isValid accepts only the token when passwordHash is undefined', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'));
    const svc = createAuthTokenService({ tokenStore: store, passwordHash: undefined });
    expect(await svc.isValid(store.getToken())).toBe(true);
    expect(await svc.isValid('any-password')).toBe(false);
    await store.dispose();
  });
});

describe('createCredentialValidator', () => {
  it('accepts the rpcToken without consulting the auth token service', async () => {
    const isValid = vi.fn(async () => {
      throw new Error('auth token service should not be called');
    });
    const validate = createCredentialValidator(
      {
        _serviceBrand: undefined,
        getToken: () => 'persistent-token',
        isValid,
      },
      'rpc-token',
    );

    await expect(validate('rpc-token')).resolves.toBe(true);
    expect(isValid).not.toHaveBeenCalled();
  });
});
