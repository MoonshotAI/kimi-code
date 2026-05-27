import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

export async function downloadZip(url: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, 5 * 60 * 1000);
  try {
    const resp = await fetch(url, { signal: signal ?? controller.signal });
    if (!resp.ok) {
      throw new Error(`Failed to download zip: HTTP ${resp.status} ${resp.statusText}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function extractZip(buffer: Buffer, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const destDirResolved = path.resolve(destDir);
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    yauzlFromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(new Error(`Failed to open zip: ${openErr?.message ?? 'unknown error'}`));
        return;
      }

      const onEntry = (entry: Entry): void => {
        const fileName = entry.fileName;
        const destPath = path.resolve(destDir, fileName);

        if (destPath !== destDirResolved && !destPath.startsWith(destDirResolved + path.sep)) {
          if (!settled) {
            settled = true;
            reject(new Error(`Path traversal detected in zip entry: ${fileName}`));
          }
          zipfile.close();
          return;
        }

        if (fileName.endsWith('/')) {
          mkdir(destPath, { recursive: true })
            .then(() => {
              zipfile.readEntry();
            })
            .catch((error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
              zipfile.close();
            });
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null || stream === undefined) {
            if (!settled) {
              settled = true;
              reject(
                new Error(
                  `Failed to read ${fileName} from archive: ${streamErr?.message ?? 'unknown error'}`,
                ),
              );
            }
            zipfile.close();
            return;
          }

          mkdir(path.dirname(destPath), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(destPath)))
            .then(() => restoreFilePermissions(destPath, entry))
            .then(() => {
              zipfile.readEntry();
            })
            .catch((error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
              zipfile.close();
            });
        });
      };

      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zipfile.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      zipfile.readEntry();
    });
  });

  return detectPluginRoot(destDir);
}

async function restoreFilePermissions(destPath: string, entry: Entry): Promise<void> {
  const mode = entry.externalFileAttributes >>> 16;
  if (mode === 0) return;
  const permissions = mode & 0o777;
  if (permissions === 0) return;
  await chmod(destPath, permissions);
}

async function detectPluginRoot(dir: string): Promise<string> {
  if (await hasManifest(dir)) return dir;

  const entries = await readdir(dir, { withFileTypes: true });
  const childDirs = entries.filter((entry) => entry.isDirectory());
  const childDir = childDirs.length === 1 ? childDirs[0] : undefined;
  if (childDir !== undefined) {
    const child = path.join(dir, childDir.name);
    if (await hasManifest(child)) return child;
  }

  return dir;
}

async function hasManifest(dir: string): Promise<boolean> {
  const rootManifest = path.join(dir, 'kimi.plugin.json');
  const dirManifest = path.join(dir, '.kimi-plugin', 'plugin.json');
  return (await isFile(rootManifest)) || (await isFile(dirManifest));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
