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
  /** Kimi home (`~/.kimi-code`) — plugin records and user skills live here. */
  readonly kimiHomeDir: string;
  /** OS user home (`~`) — the webbridge daemon installs under it. */
  readonly userHomeDir: string;
  readonly plugins: IPluginService;
  readonly hostProcess: IHostProcessService;
  /** Overridable for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** kimi-cu only: defaults to `/Applications`. */
  readonly applicationsDir?: string;
  /** kimi-webbridge only: defaults to `http://127.0.0.1:10086`. */
  readonly webbridgeBaseUrl?: string;
  /**
   * Root holding the client-bundled wiring plugins (one `<id>/` subdirectory
   * per plugin). Explicit injection for tests/hosts; when omitted, entries
   * resolve via `KIMI_CODE_BUNDLED_PLUGINS_DIR` and the module-relative
   * probes in `bundledPlugins.ts`.
   */
  readonly bundledPluginsRoot?: string;
}
