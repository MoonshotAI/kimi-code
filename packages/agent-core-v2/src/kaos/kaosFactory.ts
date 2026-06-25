/**
 * `kaos` domain (L1) — `IKaosFactory` implementation.
 *
 * Creates `Kaos` instances for the requested kind; resolves paths through
 * `environment` and logs through `log`. Bound at Core scope.
 */

import { type Kaos, LocalKaos } from '@moonshot-ai/kaos';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEnvironmentService } from '#/environment/environment';
import { ILogService } from '#/log/log';

import { type KaosFactoryOptions, IKaosFactory } from './kaos';

export class KaosFactory implements IKaosFactory {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEnvironmentService _env: IEnvironmentService,
    @ILogService _log: ILogService,
  ) {}

  async create(options: KaosFactoryOptions): Promise<Kaos> {
    if (options.kind === 'ssh') {
      throw new Error('TODO: KaosFactory.create ssh');
    }
    const base = await LocalKaos.create();
    return options.cwd !== undefined ? base.withCwd(options.cwd) : base;
  }
}

registerScopedService(
  LifecycleScope.Core,
  IKaosFactory,
  KaosFactory,
  InstantiationType.Delayed,
  'kaos',
);
