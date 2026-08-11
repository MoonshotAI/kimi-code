/**
 * Shared context injected into capability entries. Every field is
 * constructor-wired by `CapabilityService`; tests substitute fakes
 * (temp dirs, fake fetch, fake plugin service) rather than touching the
 * host.
 */

import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcessService } from '#/os/interface/hostProcess';

export interface CapabilityEntryContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly kimiHomeDir: string;
  readonly userHomeDir: string;
  readonly plugins: IPluginService;
  readonly hostProcess: IHostProcessService;
  readonly fetchImpl?: typeof fetch;
  readonly applicationsDir?: string;
  readonly webbridgeBaseUrl?: string;
  readonly detectProbeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}
