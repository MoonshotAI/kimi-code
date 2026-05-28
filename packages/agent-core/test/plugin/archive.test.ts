import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yazl from 'yazl';
import { crc32 } from 'node:zlib';

import { downloadZip, extractZip } from '../../src/plugin/archive';

async function createZipBuffer(
  entries: Array<{ name: string; data: string | Buffer; mode?: number }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zipfile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zipfile.outputStream.on('error', reject);
    for (const entry of entries) {
      zipfile.addBuffer(
        Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
        entry.name,
        entry.mode === undefined ? undefined : { mode: entry.mode },
      );
    }
    zipfile.end();
  });
}

function createMinimalZip(entryName: string, content: string): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');
  const crc = crc32(dataBuf);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(dataBuf.length, 18);
  localHeader.writeUInt32LE(dataBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 8);
  cdHeader.writeUInt16LE(0, 10);
  cdHeader.writeUInt16LE(0, 12);
  cdHeader.writeUInt16LE(0, 14);
  cdHeader.writeUInt32LE(crc, 16);
  cdHeader.writeUInt32LE(dataBuf.length, 20);
  cdHeader.writeUInt32LE(dataBuf.length, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt16LE(0, 30);
  cdHeader.writeUInt16LE(0, 32);
  cdHeader.writeUInt16LE(0, 34);
  cdHeader.writeUInt16LE(0, 36);
  cdHeader.writeUInt32LE(0, 38);
  cdHeader.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + dataBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, nameBuf, dataBuf, cdHeader, nameBuf, eocd]);
}

async function serveOnce(buffer: Buffer): Promise<string> {
  const { createServer } = await import('node:http');
  return new Promise((resolve) => {
    const server = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(buffer);
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()!;
      resolve(`http://127.0.0.1:${(addr as any).port}`);
    });
  });
}

describe('downloadZip', () => {
  it('downloads a zip from a URL', async () => {
    const zipBuffer = await createZipBuffer([{ name: 'test.txt', data: 'hello' }]);
    const url = await serveOnce(zipBuffer);

    const result = await downloadZip(url);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws on HTTP error', async () => {
    const { createServer } = await import('node:http');
    const url = await new Promise<string>((resolve) => {
      const server = createServer((_, res) => {
        res.writeHead(404);
        res.end('Not found');
        server.close();
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()!;
        resolve(`http://127.0.0.1:${(addr as any).port}`);
      });
    });

    await expect(downloadZip(url)).rejects.toThrow(/Failed to download zip: HTTP 404/i);
  });
});

describe('extractZip', () => {
  it('extracts flat files and returns root when no manifest found', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'readme.txt', data: 'hello' },
      { name: 'data/info.json', data: '{}' },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    expect(root).toBe(destDir);
    const readme = await readFile(path.join(destDir, 'readme.txt'), 'utf8');
    expect(readme).toBe('hello');
  });

  it('prefers a plugin manifest at the archive root', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'kimi.plugin.json', data: '{"name":"root"}' },
      { name: 'examples/demo/kimi.plugin.json', data: '{"name":"demo"}' },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    expect(root).toBe(destDir);
  });

  it('detects plugin root with kimi.plugin.json', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'my-plugin/kimi.plugin.json', data: '{"name":"test"}' },
      { name: 'my-plugin/readme.md', data: '# Test' },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    expect(root).toBe(path.join(destDir, 'my-plugin'));
    const manifest = await readFile(path.join(root, 'kimi.plugin.json'), 'utf8');
    expect(manifest).toBe('{"name":"test"}');
  });

  it('detects plugin root with .kimi-plugin/plugin.json', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'my-plugin/.kimi-plugin/plugin.json', data: '{"name":"test"}' },
      { name: 'my-plugin/skills/demo/SKILL.md', data: '---\nname: demo\n---\nbody' },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    expect(root).toBe(path.join(destDir, 'my-plugin'));
    const manifest = await readFile(path.join(root, '.kimi-plugin', 'plugin.json'), 'utf8');
    expect(manifest).toBe('{"name":"test"}');
  });

  it('detects a single wrapper directory before nested manifests', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'outer/kimi.plugin.json', data: '{"name":"outer"}' },
      { name: 'outer/inner/kimi.plugin.json', data: '{"name":"inner"}' },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    expect(root).toBe(path.join(destDir, 'outer'));
  });

  it('ignores deep nested plugin manifests when there is no root or wrapper manifest', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'examples/demo/kimi.plugin.json', data: '{"name":"demo"}' },
      { name: 'examples/demo/readme.md', data: '# Demo' },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    expect(root).toBe(destDir);
  });

  it('preserves executable file permission bits', async () => {
    if (process.platform === 'win32') return;

    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'my-plugin/kimi.plugin.json', data: '{"name":"test"}' },
      { name: 'my-plugin/bin/server', data: '#!/bin/sh\n', mode: 0o100755 },
    ]);

    const root = await extractZip(zipBuffer, destDir);
    const executable = await stat(path.join(root, 'bin', 'server'));
    expect(executable.mode & 0o777).toBe(0o755);
  });

  it('rejects entries with path traversal', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = createMinimalZip('../escape.txt', 'bad');

    await expect(extractZip(zipBuffer, destDir)).rejects.toThrow(/invalid relative path/i);
  });

  it('rejects entries with .. in path', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = createMinimalZip('a/../../escape.txt', 'bad');

    await expect(extractZip(zipBuffer, destDir)).rejects.toThrow(/invalid relative path/i);
  });

  it('accepts file names containing dots that are not path components', async () => {
    const destDir = await mkdtemp(path.join(tmpdir(), 'archive-test-'));
    const zipBuffer = await createZipBuffer([
      { name: 'foo..bar.txt', data: 'ok' },
      { name: 'dir/..hidden.md', data: 'ok' },
    ]);

    await extractZip(zipBuffer, destDir);
    expect(await readFile(path.join(destDir, 'foo..bar.txt'), 'utf8')).toBe('ok');
    expect(await readFile(path.join(destDir, 'dir', '..hidden.md'), 'utf8')).toBe('ok');
  });
});
