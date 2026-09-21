import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { Emitter } from '#/_base/event';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';

import type { Environment, EnvironmentCapability, EnvironmentPath, EnvironmentStatus } from './environment';
import type { EnvironmentProviderAttachment, EnvironmentProviderContext, EnvironmentProviderFactory, EnvironmentProviderHost } from './environmentProvider';

let nextGeneration = 1;

export class LocalEnvironment implements Environment {
  readonly identity;
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host;
  readonly path: EnvironmentPath;
  readonly workspace: Environment['workspace'];
  readonly fs;
  readonly process;
  readonly terminal;
  private currentStatus: EnvironmentStatus = 'ready';
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    workspaceId: string,
    environment: IHostEnvironment,
    fs: IHostFileSystem | undefined,
    process: IHostProcessService | undefined,
    terminal: IHostTerminalService | undefined,
  ) {
    this.identity = { workspaceId, environmentId: 'local', generation: `local-${nextGeneration++}` };
    const capabilities = new Set<EnvironmentCapability>();
    if (fs !== undefined) capabilities.add('fs');
    if (process !== undefined) capabilities.add('process');
    if (terminal !== undefined) capabilities.add('terminal');
    this.capabilities = capabilities;
    this.host = {
      osKind: environment.osKind,
      osArch: environment.osArch,
      osVersion: environment.osVersion,
      shellName: environment.shellName,
      shellPath: environment.shellPath,
      pathClass: environment.pathClass,
      homeDir: environment.homeDir,
    };
    const path = environment.pathClass === 'win32' ? win32Path : posixPath;
    this.path = {
      separator: path.sep as '/' | '\\',
      delimiter: path.delimiter as ':' | ';',
      isAbsolute: (p) => path.isAbsolute(p),
      join: (...paths) => path.join(...paths),
      relative: (from, to) => path.relative(from, to),
      resolve: (...paths) => path.resolve(...paths),
      basename: (p) => path.basename(p),
      dirname: (p) => path.dirname(p),
    };
    this.workspace = {
      mapRoots: (roots) => ({
        workDir: path.resolve(roots.workDir),
        additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
      }),
    };
    this.fs = fs;
    this.process = process;
    this.terminal = terminal;
  }

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  dispose(): void {
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}

export class LocalEnvironmentProviderFactory implements EnvironmentProviderFactory {
  readonly id = 'local';

  async attach(context: EnvironmentProviderContext, host: EnvironmentProviderHost): Promise<EnvironmentProviderAttachment> {
    const handle = host.registerEnvironment(new LocalEnvironment(
      context.id,
      host.get(IHostEnvironment),
      host.get(IHostFileSystem),
      host.get(IHostProcessService),
      host.get(IHostTerminalService),
    ));
    return { dispose: () => handle.remove() };
  }
}
