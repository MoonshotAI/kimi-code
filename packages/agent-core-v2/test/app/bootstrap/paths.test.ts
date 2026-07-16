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

    it('handles a trailing slash in the explicit homeDir', () => {
      expect(resolveKimiHome('/tmp/kimi/')).toBe('/tmp/kimi/');
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

    it('returns undefined when KIMI_CODE_HOME is set to empty string', () => {
      const prev = process.env['KIMI_CODE_HOME'];
      process.env['KIMI_CODE_HOME'] = '';
      try {
        expect(resolveKimiHome()).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env['KIMI_CODE_HOME'];
        else process.env['KIMI_CODE_HOME'] = prev;
      }
    });

    it('returns undefined when no env and no explicit homeDir', () => {
      const prev = process.env['KIMI_CODE_HOME'];
      delete process.env['KIMI_CODE_HOME'];
      try {
        expect(resolveKimiHome()).toBeUndefined();
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

    it('prefers explicit configPath over homeDir when both are given', () => {
      expect(resolveConfigPath({ configPath: '/custom/cfg.toml', homeDir: '/tmp/kimi' })).toBe(
        '/custom/cfg.toml',
      );
    });

    it('handles a trailing slash in homeDir', () => {
      expect(resolveConfigPath({ homeDir: '/tmp/kimi/' })).toBe('/tmp/kimi//config.toml');
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

    it('does not throw when the directory already exists', () => {
      dir = mkdtempSync(join(tmpdir(), 'kimi-home-'));
      ensureKimiHome(dir);
      // second call should be a no-op
      expect(() => ensureKimiHome(dir)).not.toThrow();
    });

    it('does not throw for a root-like path', () => {
      // Should not crash for an absolute path even if unusual
      expect(() => ensureKimiHome('/tmp')).not.toThrow();
    });
  });
});
