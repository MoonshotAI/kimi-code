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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PrivateFileTooPermissiveError,
  readPrivateFile,
  writePrivateFile,
} from '#/services/auth/privateFiles';
import { loadOrCreateServerToken, rotateServerToken } from '#/services/auth/persistentToken';
import { createTokenStore } from '#/services/auth/tokenStore';
import { resolvePasswordHash, verifyPassword } from '#/services/auth/password';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-auth-test-'));
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
    await expect(readPrivateFile(p)).rejects.toThrowError(
      PrivateFileTooPermissiveError,
    );
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

    // Rewrite the same way `rotateServerToken` does (atomic rename → new
    // inode/mtime). Use a distinct, same-length value so the length check in
    // isValid does not short-circuit.
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

  it('hashes a set password with bcrypt and verifies correctly', async () => {
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct-horse-battery-staple',
    });
    expect(passwordHash?.startsWith('$2')).toBe(true);
    expect(await verifyPassword('correct-horse-battery-staple', passwordHash)).toBe(
      true,
    );
    expect(await verifyPassword('wrong-password', passwordHash)).toBe(false);
  });

  it('verifyPassword returns false when the hash is undefined', async () => {
    expect(await verifyPassword('anything', undefined)).toBe(false);
  });
});
