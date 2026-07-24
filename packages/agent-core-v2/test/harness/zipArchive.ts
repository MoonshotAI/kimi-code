/**
 * Test helper — build a zip archive of a directory without external tools.
 *
 * `zip -qr out.zip .` spawns the Info-ZIP CLI, which is not available on
 * Windows. yazl (already a dependency) produces the same layout in pure
 * JavaScript: `zipDirectoryToBuffer(sourceRoot)` zips every file under the
 * source root recursively, named by its forward-slash relative path, and
 * resolves to the archive bytes.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { ZipFile } from 'yazl';

export async function zipDirectoryToBuffer(sourceRoot: string): Promise<Buffer> {
  const zip = new ZipFile();
  for (const file of await collectFiles(sourceRoot)) {
    zip.addFile(file, path.relative(sourceRoot, file).split(path.sep).join('/'));
  }
  zip.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zip.outputStream.on('error', reject);
  });
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}
