/**
 * `kaos` domain (L1) — `IKaosFactory` (Core) implementation.
 *
 * Builds concrete `Kaos` instances. Local kaos is created via
 * `LocalKaos.create()` (which probes the host environment) and optionally
 * pinned to a cwd. SSH kaos is left as a TODO stub.
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
