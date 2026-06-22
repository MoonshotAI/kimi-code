import {
  chmodSync,
  existsSync,
  mkdtempSync,
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
import { createTokenStore } from '#/services/auth/tokenStore';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-auth-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('privateFiles', () => {
  it('writes a file with mode 0600', async () => {
    const p = join(tmpDir, 'secret');
    await writePrivateFile(p, 'hello');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('creates an absent parent dir with mode 0700', async () => {
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

  it('readPrivateFile throws on a 0644 file', async () => {
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
    const store = await createTokenStore(join(tmpDir, 'home'), 111);
    expect(store.getToken()).toBe(store.getToken());
    await store.dispose();
  });

  it('produces different tokens for different stores', async () => {
    const a = await createTokenStore(join(tmpDir, 'home-a'), 111);
    const b = await createTokenStore(join(tmpDir, 'home-b'), 222);
    expect(a.getToken()).not.toBe(b.getToken());
    await a.dispose();
    await b.dispose();
  });

  it('writes the token file with mode 0600 at server-<pid>.token', async () => {
    const home = join(tmpDir, 'home');
    const store = await createTokenStore(home, 4242);
    expect(store.tokenPath).toBe(join(home, 'server-4242.token'));
    expect(statSync(store.tokenPath).mode & 0o777).toBe(0o600);
    await store.dispose();
  });

  it('isValid accepts the token and rejects wrong / empty / same-length candidates', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'), 333);
    const token = store.getToken();
    expect(store.isValid(token)).toBe(true);
    expect(store.isValid('wrong')).toBe(false);
    expect(store.isValid('')).toBe(false);

    const other = await createTokenStore(join(tmpDir, 'home-other'), 334);
    expect(other.getToken().length).toBe(token.length);
    expect(store.isValid(other.getToken())).toBe(false);
    await store.dispose();
    await other.dispose();
  });

  it('dispose() removes the token file', async () => {
    const store = await createTokenStore(join(tmpDir, 'home'), 555);
    expect(existsSync(store.tokenPath)).toBe(true);
    await store.dispose();
    expect(existsSync(store.tokenPath)).toBe(false);
  });
});
