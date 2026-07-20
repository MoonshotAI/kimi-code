/**
 * `externalHooks` test helper — build a real `IExternalHooksRunnerService`
 * from a list of hook definitions.
 *
 * The runner is App-scoped in production; in tests we construct it directly
 * (its constructor params are the App services it reads plus the host process
 * service) with stub `IConfigService` / `IPluginService` / `IBootstrapService`
 * and a real `HostProcessService`. This keeps the matching / dedupe /
 * stdin-payload behavior under test identical to production while letting a
 * test feed an arbitrary hook list.
 */

import { Event } from '#/_base/event';
import { ExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunnerService';
import { HOOKS_SECTION } from '#/agent/externalHooks/configSection';
import type { HookDef } from '#/agent/externalHooks/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

export function makeHookRunner(
  hooks: readonly HookDef[],
  options: {
    cwd?: string;
    onTriggered?: (event: string, target: string, count: number) => void;
    onResolved?: (
      event: string,
      target: string,
      action: string,
      reason: string | undefined,
      durationMs: number,
    ) => void;
  } = {},
): ExternalHooksRunnerService {
  return new ExternalHooksRunnerService(
    {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (section: string) => (section === HOOKS_SECTION ? hooks : undefined),
    } as unknown as IConfigService,
    {
      _serviceBrand: undefined,
      enabledHooks: async () => [],
      onDidReload: Event.None as IPluginService['onDidReload'],
    } as unknown as IPluginService,
    { _serviceBrand: undefined, cwd: options.cwd ?? '' } as unknown as IBootstrapService,
    new HostProcessService(),
    { onTriggered: options.onTriggered, onResolved: options.onResolved },
  );
}
