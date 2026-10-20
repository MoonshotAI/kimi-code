import { dirname, join, resolve } from 'pathe';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

import type { OsFsPort } from '#/features/os/host/index';

import { PluginError } from '../errors';

export async function downloadZip(url: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, 5 * 60 * 1000);
  try {
    const resp = await fetch(url, { signal: signal ?? controller.signal });
    if (!resp.ok) {
      throw new PluginError(
        'plugin.load_failed',
        `Failed to download zip: HTTP ${resp.status} ${resp.statusText}`,
        { details: { url, status: resp.status } },
      );
    }
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function extractZip(
  fs: OsFsPort,
  buffer: Uint8Array,
  destDir: string,
): Promise<string> {
  await fs.mkdir(destDir, { recursive: true });
  const destDirResolved = resolve(destDir);
  let settled = false;

  await new Promise<void>((resolvePromise, reject) => {
    yauzlFromBuffer(Buffer.from(buffer), { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(
          new PluginError(
            'plugin.load_failed',
            `Failed to open zip: ${openErr?.message ?? 'unknown error'}`,
            { cause: openErr ?? undefined },
          ),
        );
        return;
      }

      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        zipfile.close();
      };

      const onEntry = (entry: Entry): void => {
        const fileName = entry.fileName;
        const destPath = resolve(destDir, fileName);

        if (destPath !== destDirResolved && !destPath.startsWith(destDirResolved + '/')) {
          fail(
            new PluginError(
              'plugin.load_failed',
              `Path traversal detected in zip entry: ${fileName}`,
              { details: { entry: fileName } },
            ),
          );
          return;
        }

        if (fileName.endsWith('/')) {
          fs.mkdir(destPath, { recursive: true }).then(() => {
            zipfile.readEntry();
          }, fail);
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null || stream === undefined) {
            fail(
              new PluginError(
                'plugin.load_failed',
                `Failed to read ${fileName} from archive: ${streamErr?.message ?? 'unknown error'}`,
                { cause: streamErr ?? undefined, details: { entry: fileName } },
              ),
            );
            return;
          }

          readStream(stream)
            .then(async (data) => {
              await fs.mkdir(dirname(destPath), { recursive: true });
              await fs.writeBytes(destPath, data);
            })
            .then(() => {
              zipfile.readEntry();
            }, fail);
        });
      };

      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolvePromise();
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

  return detectPluginRoot(fs, destDir);
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function detectPluginRoot(fs: OsFsPort, dir: string): Promise<string> {
  if (await hasManifest(fs, dir)) return dir;

  const entries = await fs.readdir(dir);
  const childDirs = entries.filter((entry) => entry.isDirectory);
  const childDir = childDirs.length === 1 ? childDirs[0] : undefined;
  if (childDir !== undefined) {
    const child = join(dir, childDir.name);
    if (await hasManifest(fs, child)) return child;
  }

  return dir;
}

async function hasManifest(fs: OsFsPort, dir: string): Promise<boolean> {
  const rootManifest = join(dir, 'kimi.plugin.json');
  const dirManifest = join(dir, '.kimi-plugin', 'plugin.json');
  return (await isFile(fs, rootManifest)) || (await isFile(fs, dirManifest));
}

async function isFile(fs: OsFsPort, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile;
  } catch {
    return false;
  }
}
