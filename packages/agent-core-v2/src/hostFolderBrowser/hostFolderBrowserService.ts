/**
 * `hostFolderBrowser` domain (L1) — `IHostFolderBrowser` implementation.
 *
 * Browses the real local filesystem through the program-side `hostFs`
 * primitives. Bound at Core scope.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IHostFileSystem } from '#/hostFs';

import { type FsBrowseResponse, IHostFolderBrowser } from './hostFolderBrowser';

export class HostFolderBrowser implements IHostFolderBrowser {
  declare readonly _serviceBrand: undefined;

  constructor(@IHostFileSystem private readonly hostFs: IHostFileSystem) {}

  async browse(absPath?: string): Promise<FsBrowseResponse> {
    const path = resolve(absPath ?? homedir());
    const entries = await this.hostFs.readdir(path);
    return { path, entries };
  }

  home(): Promise<string> {
    return Promise.resolve(homedir());
  }
}

registerScopedService(
  LifecycleScope.Core,
  IHostFolderBrowser,
  HostFolderBrowser,
  InstantiationType.Delayed,
  'hostFolderBrowser',
);
