import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkBundle, findDynamicImports } from '../../scripts/native/check-bundle.mjs';
import { SEA_EXEC_ARGV, seaCodeCacheEnabled } from '../../scripts/native/sea-options.mjs';

describe('sea-options', () => {
  it('bakes a bounded young generation into the binary', () => {
    expect(SEA_EXEC_ARGV).toEqual(['--max-semi-space-size=16']);
    expect(Object.isFrozen(SEA_EXEC_ARGV)).toBe(true);
  });

  it('only enables the V8 code cache when the target matches the build host', () => {
    expect(seaCodeCacheEnabled('darwin-arm64', 'darwin-arm64')).toBe(true);
    expect(seaCodeCacheEnabled('linux-x64', 'darwin-arm64')).toBe(false);
  });
});

describe('check-bundle', () => {
  const tempDirs: string[] = [];

  function bundleFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-check-bundle-'));
    tempDirs.push(dir);
    const path = join(dir, 'main.cjs');
    writeFileSync(path, content);
    return path;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ignores import() text inside strings and comments', async () => {
    const text = [
      'const hint = "set `globalThis.File` to `import(\'node:buffer\').File`";',
      '// import("./lazy.js")',
      '/** @param {import("http").IncomingMessage} req */',
      'function f(req) { return hint + req; }',
    ].join('\n');
    expect(await findDynamicImports(text)).toEqual([]);
    expect(await checkBundle(bundleFile(text))).toEqual([]);
  });

  it('rejects a surviving dynamic import() in the main bundle', async () => {
    const text = ['const a = 1;', 'async function load() {', '  return await import("node:fs");', '}'].join('\n');
    expect(await findDynamicImports(text)).toEqual([
      { index: text.indexOf('import('), specifier: 'node:fs' },
    ]);
    const errors = await checkBundle(bundleFile(text));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dynamic import() remains at line 3 (node:fs)');
  });

  it('keeps allowing builtin dynamic imports in worker bundles', async () => {
    const text = 'const fs = await import("node:fs");\nexport {};\n';
    expect(await checkBundle(bundleFile(text), { worker: true })).toEqual([]);
  });

  it('still reports unbundled externals', async () => {
    const errors = await checkBundle(bundleFile('let m = require("some-package");\n'));
    expect(errors).toEqual(['external require remains: some-package']);
  });
});
