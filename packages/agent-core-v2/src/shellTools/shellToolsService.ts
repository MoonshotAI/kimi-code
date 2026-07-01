/**
 * `shellTools` domain (L4) — `IShellToolsService` implementation.
 *
 * Registers the built-in Bash tool into the agent `IToolRegistry` on
 * construction, wiring it to the session `IProcessRunner` (process spawn),
 * `IKaos` (cwd + OS/shell probe) and `IBackgroundService` (background-task
 * lifecycle). Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBackgroundService } from '#/background';
import { IKaos } from '#/kaos';
import { IProcessRunner } from '#/process';
import { IProfileService } from '#/profile';
import { IToolRegistry } from '#/toolRegistry';

import { IShellToolsService } from './shellTools';
import { BashTool } from './tools/bash';

export class ShellToolsService implements IShellToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IToolRegistry toolRegistry: IToolRegistry,
    @IProcessRunner runner: IProcessRunner,
    @IKaos kaos: IKaos,
    @IBackgroundService background: IBackgroundService,
    @IProfileService profile: IProfileService,
  ) {
    toolRegistry.register(new BashTool(runner, kaos, background, {
      allowBackground: () =>
        profile.isToolActive('TaskOutput') && profile.isToolActive('TaskStop'),
    }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IShellToolsService,
  ShellToolsService,
  InstantiationType.Delayed,
  'shellTools',
);
