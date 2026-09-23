import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import type { EnvironmentProviderFactory } from '#/environment/environmentProvider';
import { LocalEnvironment } from '#/environment/localEnvironment';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';

import { IEnvironmentService } from './environment';

export class EnvironmentService extends EnvironmentRegistry implements IEnvironmentService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private readonly providers = new Map<string, Promise<{ dispose(): Promise<void> }>>();
  private stopped = false;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IHostEnvironment environment: IHostEnvironment,
    @IHostFileSystem fs: IHostFileSystem,
    @IHostProcessService process: IHostProcessService,
    @IHostTerminalService terminal: IHostTerminalService,
  ) {
    super();
    this.ready = environment.ready.then(() => {
      if (!this.stopped) this.register(new LocalEnvironment(environment, fs, process, terminal));
    });
  }

  async addProvider(factory: EnvironmentProviderFactory): Promise<{ dispose(): Promise<void> }> {
    if (this.stopped) throw new Error('environment service is disposed');
    if (this.providers.has(factory.id)) throw new Error(`environment provider ${factory.id} already exists`);
    const pending = this.attach(factory);
    this.providers.set(factory.id, pending);
    try {
      const attachment = await pending;
      return { dispose: async () => {
        if (this.providers.get(factory.id) !== pending) return;
        this.providers.delete(factory.id);
        await attachment.dispose();
      } };
    } catch (error) {
      if (this.providers.get(factory.id) === pending) this.providers.delete(factory.id);
      throw error;
    }
  }

  private async attach(factory: EnvironmentProviderFactory): Promise<{ dispose(): Promise<void> }> {
    await this.ready;
    const handles: Array<{ remove(): Promise<void> }> = [];
    try {
      const attachment = await factory.attach({
        get: <T>(id: ServiceIdentifier<T>): T => this.instantiation.invokeFunction((accessor) => accessor.get(id)),
        registerEnvironment: (environment) => {
          const handle = this.register(environment);
          handles.push(handle);
          return handle;
        },
      });
      return { dispose: async () => {
        try {
          await attachment.dispose();
        } finally {
          for (const handle of handles.toReversed()) await handle.remove();
        }
      } };
    } catch (error) {
      for (const handle of handles.toReversed()) await handle.remove();
      throw error;
    }
  }

  override async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const attachments = [...this.providers.values()];
    this.providers.clear();
    try {
      for (const pending of attachments.toReversed()) await (await pending.catch(() => undefined))?.dispose();
    } finally {
      await super.dispose();
    }
  }
}

registerScopedService(LifecycleScope.App, IEnvironmentService, EnvironmentService, ScopeActivation.OnScopeCreated, 'environment');
