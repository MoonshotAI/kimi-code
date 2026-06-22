import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PrivateFileTooPermissiveError,
  readPrivateFile,
  writePrivateFile,
} from '#/services/auth/privateFiles';

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
