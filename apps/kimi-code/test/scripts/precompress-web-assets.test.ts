import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { precompressWebAssets } from '../../scripts/precompress-web-assets.mjs';

const tempRoots: string[] = [];
const LARGE_TEXT = 'export const banner = "kimi";\n'.repeat(200);

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeDist(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-precompress-'));
  tempRoots.push(root);
  const distDir = join(root, 'dist-web');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  return distDir;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('precompressWebAssets', () => {
  it('writes brotli and gzip siblings for js and css bundles', async () => {
    const distDir = await makeDist();
    const js = join(distDir, 'assets', 'index-Dy7xs5tu.js');
    const css = join(distDir, 'assets', 'index-Ab12Cd34.css');
    await writeFile(js, LARGE_TEXT);
    await writeFile(css, `.kimi{color:red}\n`.repeat(100));

    const summary = await precompressWebAssets({ distDir });

    expect(summary.processed).toBe(2);
    expect(summary.written).toBe(4);
    expect(brotliDecompressSync(await readFile(`${js}.br`)).toString('utf8')).toBe(LARGE_TEXT);
    expect(gunzipSync(await readFile(`${js}.gz`)).toString('utf8')).toBe(LARGE_TEXT);
    await expect(exists(`${css}.br`)).resolves.toBe(true);
    await expect(exists(`${css}.gz`)).resolves.toBe(true);
    expect(summary.bytesAfter).toBeLessThan(summary.bytesBefore);
  });

  it('skips fonts and rive animations', async () => {
    const distDir = await makeDist();
    const woff2 = join(distDir, 'assets', 'font-Dy7xs5tu.woff2');
    const riv = join(distDir, 'assets', 'anim-Dy7xs5tu.riv');
    await writeFile(woff2, LARGE_TEXT);
    await writeFile(riv, LARGE_TEXT);

    const summary = await precompressWebAssets({ distDir });

    expect(summary.processed).toBe(0);
    await expect(exists(`${woff2}.br`)).resolves.toBe(false);
    await expect(exists(`${riv}.gz`)).resolves.toBe(false);
  });

  it('skips files smaller than 1024 bytes', async () => {
    const distDir = await makeDist();
    const small = join(distDir, 'assets', 'tiny-Dy7xs5tu.js');
    await writeFile(small, 'export {};\n');

    const summary = await precompressWebAssets({ distDir });

    expect(summary.processed).toBe(0);
    await expect(exists(`${small}.br`)).resolves.toBe(false);
  });

  it('removes orphaned siblings whose base file is gone', async () => {
    const distDir = await makeDist();
    const orphanBr = join(distDir, 'assets', 'index-Old00000.js.br');
    const orphanGz = join(distDir, 'assets', 'index-Old00000.js.gz');
    await writeFile(orphanBr, 'stale');
    await writeFile(orphanGz, 'stale');

    const summary = await precompressWebAssets({ distDir });

    expect(summary.removed).toBe(2);
    await expect(exists(orphanBr)).resolves.toBe(false);
    await expect(exists(orphanGz)).resolves.toBe(false);
  });

  it('never prunes archives or bare compressed files that only look like siblings', async () => {
    const distDir = await makeDist();
    const tarball = join(distDir, 'assets', 'bundle-Dy7xs5tu.tar.gz');
    const bareBrotli = join(distDir, 'assets', 'payload.br');
    const rootGzip = join(distDir, 'blob.gz');
    const orphan = join(distDir, 'assets', 'index-Old00000.js.br');
    await writeFile(tarball, 'archive');
    await writeFile(bareBrotli, 'opaque');
    await writeFile(rootGzip, 'opaque');
    await writeFile(orphan, 'stale');

    const summary = await precompressWebAssets({ distDir });

    expect(summary.removed).toBe(1);
    await expect(exists(tarball)).resolves.toBe(true);
    await expect(exists(bareBrotli)).resolves.toBe(true);
    await expect(exists(rootGzip)).resolves.toBe(true);
    await expect(exists(orphan)).resolves.toBe(false);
  });

  it('always regenerates siblings of unhashed files', async () => {
    const distDir = await makeDist();
    const html = join(distDir, 'index.html');
    const boot = join(distDir, 'boot.js');
    await writeFile(html, '<p>kimi</p>\n'.repeat(200));
    await writeFile(boot, LARGE_TEXT);
    const first = await precompressWebAssets({ distDir });
    const past = new Date(Date.now() - 60_000);
    await utimes(html, past, past);
    await utimes(boot, past, past);

    const rerun = await precompressWebAssets({ distDir });

    expect(first.written).toBe(4);
    expect(rerun.written).toBe(4);
    expect(rerun.skipped).toBe(0);
  });

  it('leaves up-to-date siblings of hashed bundles alone unless forced', async () => {
    const distDir = await makeDist();
    const js = join(distDir, 'assets', 'index-Dy7xs5tu.js');
    await writeFile(js, LARGE_TEXT);
    await precompressWebAssets({ distDir });
    const before = await stat(`${js}.br`);
    const past = new Date(Date.now() - 60_000);
    await utimes(js, past, past);

    const rerun = await precompressWebAssets({ distDir });
    const forced = await precompressWebAssets({ distDir, force: true });

    expect(rerun.written).toBe(0);
    expect(rerun.skipped).toBe(2);
    expect(forced.written).toBe(2);
    expect((await stat(`${js}.br`)).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
  });

  it('fails the check when an entry bundle lacks a brotli sibling', async () => {
    const distDir = await makeDist();
    const js = join(distDir, 'assets', 'index-Dy7xs5tu.js');
    await writeFile(js, LARGE_TEXT);

    await expect(precompressWebAssets({ distDir, check: true })).rejects.toThrow(
      /index-Dy7xs5tu\.js/,
    );
    await expect(exists(`${js}.br`)).resolves.toBe(false);
  });

  it('passes the check once entry bundles have brotli siblings', async () => {
    const distDir = await makeDist();
    const js = join(distDir, 'assets', 'index-Dy7xs5tu.js');
    const css = join(distDir, 'assets', 'index-Ab12Cd34.css');
    await writeFile(js, LARGE_TEXT);
    await writeFile(css, `.kimi{color:red}\n`.repeat(100));
    await precompressWebAssets({ distDir });

    await expect(precompressWebAssets({ distDir, check: true })).resolves.toMatchObject({
      written: 0,
    });
  });

  it('emits only brotli siblings with only=br', async () => {
    const distDir = await makeDist();
    const js = join(distDir, 'assets', 'index-Dy7xs5tu.js');
    await writeFile(js, LARGE_TEXT);

    const summary = await precompressWebAssets({ distDir, only: 'br' });

    expect(summary.written).toBe(1);
    await expect(exists(`${js}.br`)).resolves.toBe(true);
    await expect(exists(`${js}.gz`)).resolves.toBe(false);
  });
});
