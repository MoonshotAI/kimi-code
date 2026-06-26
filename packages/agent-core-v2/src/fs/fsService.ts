/**
 * `fs` domain (cross-cutting) — `IFsService` / `IFsSearchService` /
 * `IFsGitService` / `IFsWatcher` implementation.
 *
 * Owns file I/O, search, git inspection, and path watching; accesses the
 * filesystem through `kaos` and logs through `log`. Bound at Session scope.
 */

import type { Readable } from 'node:stream';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { Kaos } from '@moonshot-ai/kaos';
import { ISessionKaosService } from '#/kaos/kaos';
import { ILogService } from '#/log/log';

import {
  IFsGitService,
  IFsSearchService,
  IFsService,
  IFsWatcher,
} from './fs';

function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

export class FsService implements IFsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
    @ILogService _log: ILogService,
  ) {}

  private get kaos(): Kaos {
    return this.sessionKaos.toolKaos;
  }

  read(path: string): Promise<string> {
    return this.kaos.readText(path);
  }
  write(path: string, content: string): Promise<void> {
    return this.kaos.writeText(path, content).then(() => undefined);
  }
  stat(path: string): Promise<unknown> {
    return this.kaos.stat(path);
  }
  async mkdir(path: string): Promise<void> {
    await this.kaos.mkdir(path, { parents: true, existOk: true });
  }
}

export class FsSearchService implements IFsSearchService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
    @ILogService _log: ILogService,
  ) {}

  private get kaos(): Kaos {
    return this.sessionKaos.toolKaos;
  }

  async grep(pattern: string, path: string): Promise<readonly unknown[]> {
    const proc = await this.kaos.exec('grep', '-r', '-n', pattern, path);
    const out = await readAll(proc.stdout);
    await proc.wait();
    return out.split('\n').filter((l) => l.length > 0);
  }

  async glob(pattern: string): Promise<readonly string[]> {
    const proc = await this.kaos.exec('find', '.', '-name', pattern);
    const out = await readAll(proc.stdout);
    await proc.wait();
    return out.split('\n').filter((l) => l.length > 0);
  }
}

export class FsGitService implements IFsGitService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
    @ILogService _log: ILogService,
  ) {}

  private get kaos(): Kaos {
    return this.sessionKaos.toolKaos;
  }

  private async git(...args: string[]): Promise<string> {
    const proc = await this.kaos.exec('git', ...args);
    const out = await readAll(proc.stdout);
    await proc.wait();
    return out;
  }

  status(_cwd: string): Promise<string> {
    return this.git('status', '--short');
  }
  diff(_cwd: string): Promise<string> {
    return this.git('diff');
  }
  async log(_cwd: string): Promise<readonly string[]> {
    const out = await this.git('log', '--oneline', '-n', '20');
    return out.split('\n').filter((l) => l.length > 0);
  }
}

export class FsWatcher extends Disposable implements IFsWatcher {
  declare readonly _serviceBrand: undefined;
  private readonly watched = new Set<string>();

  constructor(
    @ISessionKaosService _sessionKaos: ISessionKaosService,
    @ILogService _log: ILogService,
  ) {
    super();
  }

  watch(path: string): void {
    this.watched.add(path);
  }
  unwatch(path: string): void {
    this.watched.delete(path);
  }
}

registerScopedService(LifecycleScope.Session, IFsService, FsService, InstantiationType.Delayed, 'fs');
registerScopedService(LifecycleScope.Session, IFsSearchService, FsSearchService, InstantiationType.Delayed, 'fs');
registerScopedService(LifecycleScope.Session, IFsGitService, FsGitService, InstantiationType.Delayed, 'fs');
registerScopedService(LifecycleScope.Session, IFsWatcher, FsWatcher, InstantiationType.Delayed, 'fs');
