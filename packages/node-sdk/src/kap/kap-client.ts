import {
  noopTelemetryClient,
  resolveConfigPath,
  resolveKimiHome,
  type CoreAPI,
  type RPCMethods,
  type TelemetryClient,
} from '@moonshot-ai/agent-core';
import { assertKimiHostIdentity, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { SDKRpcClientBase } from '#/rpc';
import type { KimiHarnessOptions } from '#/types';

import { buildCoreApiProxy } from './core-proxy';
import { metaHandlers } from './handlers/meta';
import { sessionHandlers } from './handlers/sessions';
import { KapHttpClient } from './http-client';
import type { CoreApiHandlerMap } from './types';
import { KapWsClient } from './ws-client';

export class SDKKapClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;

  private readonly http: KapHttpClient;
  private readonly ws: KapWsClient;
  private readonly proxy: RPCMethods<CoreAPI>;

  constructor(options: KimiHarnessOptions & { kap: NonNullable<KimiHarnessOptions['kap']> }) {
    super();
    this.identity = options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.http = new KapHttpClient(options.kap);
    this.ws = new KapWsClient(options.kap);
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });
    this.proxy = buildCoreApiProxy(this.handlers(), {
      http: this.http,
      ws: this.ws,
      serverUrl: options.kap.serverUrl,
    });
  }

  protected override getRpc(): Promise<RPCMethods<CoreAPI>> {
    return Promise.resolve(this.proxy);
  }

  async close(): Promise<void> {
    // Phase 3 will close the WebSocket; Phase 0 is a no-op.
  }

  /** Handler registry — extended by each subsequent phase. */
  protected handlers(): CoreApiHandlerMap {
    return {
      ...metaHandlers,
      ...sessionHandlers,
    };
  }
}
