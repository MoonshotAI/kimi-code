import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
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
  // yauzl 已经会 reject 绝对路径、反斜杠、`..` 路径组件；这里再用 path.resolve 兜底，
  // 防 yauzl 行为变化或链接型 entry 漏过去，同时避免把 foo..bar.txt 这种合法名误杀。
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

async function detectPluginRoot(dir: string): Promise<string> {
  async function search(current: string): Promise<string | undefined> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (await hasManifest(child)) return child;
      const deeper = await search(child);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  }

  const found = await search(dir);
  return found ?? dir;
}

async function hasManifest(dir: string): Promise<boolean> {
  const pluginJson = path.join(dir, 'plugin.json');
  const kimiPluginJson = path.join(dir, '.kimi-plugin', 'plugin.json');
  return (await isFile(pluginJson)) || (await isFile(kimiPluginJson));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
