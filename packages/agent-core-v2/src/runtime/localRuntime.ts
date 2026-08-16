import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { Emitter } from '#/_base/event';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';

import type { Runtime, RuntimePath, RuntimeStatus } from './runtime';
import type { RuntimeProviderAttachment, RuntimeProviderContext, RuntimeProviderFactory } from './runtimeProvider';
import type { RuntimeProviderHost } from './runtimeUnitHost';

let nextGeneration = 1;

export class LocalRuntime implements Runtime {
  readonly identity;
  readonly capabilities = new Set(['fs', 'process', 'watch', 'terminal'] as const);
  readonly environment;
  readonly path: RuntimePath;
  readonly workspace: Runtime['workspace'];
  readonly fs;
  readonly process;
  readonly watch;
  readonly terminal;
  private currentStatus: RuntimeStatus = 'ready';
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    workspaceId: string,
    environment: IHostEnvironment,
    fs: IHostFileSystem,
    process: IHostProcessService,
    watch: IHostFsWatchService,
    terminal: IHostTerminalService,
  ) {
    this.identity = { workspaceId, runtimeId: 'local', generation: `local-${nextGeneration++}` };
    this.environment = {
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
    this.watch = watch;
    this.terminal = terminal;
  }

  get status(): RuntimeStatus {
    return this.currentStatus;
  }

  dispose(): void {
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}

export class LocalRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'local';
  readonly imports = {
    root: [
      IHostEnvironment,
      IHostFileSystem,
      IHostProcessService,
      IHostFsWatchService,
      IHostTerminalService,
    ],
    imports: [],
    local: [],
  };

  async attach(context: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment> {
    const handle = host.registerRuntime(new LocalRuntime(
      context.id,
      host.get(IHostEnvironment),
      host.get(IHostFileSystem),
      host.get(IHostProcessService),
      host.get(IHostFsWatchService),
      host.get(IHostTerminalService),
    ));
    return { dispose: () => handle.remove() };
  }
}
