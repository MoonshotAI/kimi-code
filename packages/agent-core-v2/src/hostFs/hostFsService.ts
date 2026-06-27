/**
 * `hostFs` domain (L1) — `IHostFileSystem` implementation.
 *
 * Reads and writes the app's own files on the real local disk through
 * `node:fs/promises`. Bound at Core scope.
 */

import { readFile, readdir, stat, mkdir, rm, writeFile } from 'node:fs/promises';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type HostDirEntry, type HostFileStat, IHostFileSystem } from './hostFs';

export class HostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  async readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async writeText(path: string, data: string): Promise<void> {
    await writeFile(path, data, 'utf8');
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async stat(path: string): Promise<HostFileStat> {
    const s = await stat(path);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory(),
    }));
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await mkdir(path, { recursive: options?.recursive ?? false });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}

registerScopedService(
  LifecycleScope.Core,
  IHostFileSystem,
  HostFileSystem,
  InstantiationType.Delayed,
  'hostFs',
);
