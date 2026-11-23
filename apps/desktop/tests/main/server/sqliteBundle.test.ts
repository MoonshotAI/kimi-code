import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { build } from 'tsdown';
import { expect, it } from 'vitest';

it('ships a loadable SQLite binding for the embedded session index without the search worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-sqlite-bundle-'));
  try {
    const desktop = fileURLToPath(new URL('../../..', import.meta.url));
    await build({ cwd: desktop, config: join(desktop, 'tsdown.config.ts'), outDir: join(root, 'out'), logLevel: 'silent' });
    execFileSync(
      process.execPath,
      [join(desktop, '../../build/copy-sqlite-prebuilds.mjs'), join(root, 'out', 'better-sqlite3')],
      { cwd: desktop },
    );
    expect(existsSync(join(root, 'out', 'search-worker.cjs'))).toBe(false);
    const target = `${process.platform}-${process.arch}`;
    const bundledBinding = join(root, 'out', 'better-sqlite3', `${target}.node`);
    expect(existsSync(bundledBinding)).toBe(true);
    const packageEntry = createRequire(import.meta.url).resolve('better-sqlite3');
    const stableBinding = join(dirname(packageEntry), '../prebuilds', `${target}.node`);
    expect((await readFile(bundledBinding)).equals(await readFile(stableBinding))).toBe(true);
    const db = new Database(':memory:', { nativeBinding: stableBinding });
    try {
      expect(db.prepare('select sqlite_version() as version').get()).toMatchObject({
        version: expect.any(String),
      });
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
