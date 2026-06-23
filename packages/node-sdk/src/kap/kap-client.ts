import {
  noopTelemetryClient,
  resolveConfigPath,
  resolveKimiHome,
  type CoreAPI,
  type RPCMethods,
  type TelemetryClient,
} from '@moonshot-ai/agent-core';
import type { Kaos } from '@moonshot-ai/kaos';
import { assertKimiHostIdentity, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { SDKRpcClientBase } from '#/rpc';
import type { KimiHarnessOptions, SessionStatus } from '#/types';
import type { SessionStatusResponse } from '@moonshot-ai/protocol';

import { buildCoreApiProxy } from './core-proxy';
import { metaHandlers } from './handlers/meta';
import { promptHandlers } from './handlers/prompts';
import { resumeHandlers } from './handlers/resume';
import { sessionHandlers } from './handlers/sessions';
import { KapHttpClient } from './http-client';
import { handleReverseRequest } from './reverse-channel';
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
    this.ws = new KapWsClient(options.kap, {
      onEvent: (event) => this.receiveEvent(event),
      onReverseRequest: (frame) =>
        void handleReverseRequest({ client: this, http: this.http }, frame),
    });
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

  async subscribeSession(sessionId: string): Promise<void> {
    await this.ws.connect();
    await this.ws.subscribe(sessionId);
  }

  async unsubscribeSession(sessionId: string): Promise<void> {
    await this.ws.unsubscribe(sessionId);
  }

  override async createSession(input: Parameters<SDKRpcClientBase['createSession']>[0]) {
    const summary = await super.createSession(input);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async resumeSession(input: Parameters<SDKRpcClientBase['resumeSession']>[0]) {
    const summary = await super.resumeSession(input);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async forkSession(input: Parameters<SDKRpcClientBase['forkSession']>[0]) {
    const summary = await super.forkSession(input);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async createSessionWithKaos(
    input: Parameters<SDKRpcClientBase['createSessionWithKaos']>[0],
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<import('#/types').SessionSummary> {
    const summary = await super.createSessionWithKaos(input, kaos, persistenceKaos);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async resumeSessionWithKaos(
    input: Parameters<SDKRpcClientBase['resumeSessionWithKaos']>[0],
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<import('#/types').ResumedSessionSummary> {
    const summary = await super.resumeSessionWithKaos(input, kaos, persistenceKaos);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async setModel(input: { sessionId: string; model: string }) {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { model: input.model },
    });
    return { model: input.model };
  }

  override async setThinking(input: { sessionId: string; level: string }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { thinking: input.level },
    });
  }

  override async setPermission(input: { sessionId: string; mode: 'yolo' | 'manual' | 'auto' }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { permission_mode: input.mode },
    });
  }

  override async setPlanMode(input: { sessionId: string; enabled: boolean }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { plan_mode: input.enabled },
    });
  }

  override async setSwarmMode(input: { sessionId: string; enabled: boolean }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { swarm_mode: input.enabled },
    });
  }

  override async getStatus(input: { sessionId: string }): Promise<SessionStatus> {
    const status = await this.http.get<SessionStatusResponse>(`/sessions/${input.sessionId}/status`);
    return {
      model: status.model,
      thinkingLevel: status.thinking_level,
      permission: status.permission as SessionStatus['permission'],
      planMode: status.plan_mode,
      swarmMode: status.swarm_mode,
      contextTokens: status.context_tokens,
      maxContextTokens: status.max_context_tokens,
      contextUsage: status.context_usage,
    };
  }

  async close(): Promise<void> {
    this.ws.close();
  }

  /** Handler registry — extended by each subsequent phase. */
  protected handlers(): CoreApiHandlerMap {
    return {
      ...metaHandlers,
      ...sessionHandlers,
      ...resumeHandlers,
      ...promptHandlers,
    };
  }
}
