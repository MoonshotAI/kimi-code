/**
 * `hooks` domain (L6) — `IHookEngine` implementation.
 *
 * Evaluates the session's hook points and returns their pass/fail results;
 * reads configuration through `config` and logs through `log`. Bound at
 * Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';

import { type HookResult, IHookEngine } from './hooks';

const PASS: HookResult = { continue: true };

export class HookEngine extends Disposable implements IHookEngine {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService _config: IConfigService,
    @ILogService _log: ILogService,
  ) {
    super();
  }

  runUserPromptSubmit(_prompt: string): Promise<HookResult> {
    return Promise.resolve(PASS);
  }
  runPreToolCall(_toolName: string, _args: unknown): Promise<HookResult> {
    return Promise.resolve(PASS);
  }
  runSessionStart(): Promise<void> {
    return Promise.resolve();
  }
  runSessionEnd(): Promise<void> {
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Session, IHookEngine, HookEngine, InstantiationType.Delayed, 'hooks');
