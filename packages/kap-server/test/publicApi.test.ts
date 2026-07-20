import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { classify, rotateServerToken, serverTokenPath } from '../src/index';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('server-v2 public API', () => {
  it('exports classify', () => {
    expect(classify('127.0.0.1')).toBe('loopback');
  });

  it('exports rotateServerToken and serverTokenPath', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-v2-public-api-'));
    const token = await rotateServerToken(tmpDir);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(serverTokenPath(tmpDir)).toBe(join(tmpDir, 'server.token'));
  });
});
