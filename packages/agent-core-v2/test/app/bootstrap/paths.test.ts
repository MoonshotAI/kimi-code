import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureKimiHome, resolveConfigPath, resolveKimiHome } from '#/app/bootstrap/bootstrap';

describe('bootstrap path helpers', () => {
  describe('resolveKimiHome', () => {
    it('uses explicit homeDir when provided', () => {
      expect(resolveKimiHome('/tmp/kimi')).toBe('/tmp/kimi');
    });

    it('falls back to KIMI_CODE_HOME env', () => {
      const prev = process.env['KIMI_CODE_HOME'];
      process.env['KIMI_CODE_HOME'] = '/env/kimi';
      try {
        expect(resolveKimiHome()).toBe('/env/kimi');
      } finally {
        if (prev === undefined) delete process.env['KIMI_CODE_HOME'];
        else process.env['KIMI_CODE_HOME'] = prev;
      }
    });
  });

  describe('resolveConfigPath', () => {
    it('uses explicit configPath when provided', () => {
      expect(resolveConfigPath({ configPath: '/x/config.toml' })).toBe('/x/config.toml');
    });

    it('joins homeDir with config.toml', () => {
      expect(resolveConfigPath({ homeDir: '/tmp/kimi' })).toBe('/tmp/kimi/config.toml');
    });
  });

  describe('ensureKimiHome', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('creates the directory with 0700 permissions', () => {
      dir = join(mkdtempSync(join(tmpdir(), 'kimi-home-')), 'nested');
      ensureKimiHome(dir);
      expect(existsSync(dir)).toBe(true);
    });
  });
});
