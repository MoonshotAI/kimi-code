import {
  createRPC,
  createServicesCoreAdapter,
  ensureConfigFile,
  getRootLogger,
  KimiCore,
  noopTelemetryClient,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type CoreAPI,
  type OAuthTokenProviderResolver,
  type RPCMethods,
  type SDKAPI,
  type ServicesCoreAdapter,
  type TelemetryClient,
} from '@moonshot-ai/agent-core';
import type { Kaos } from '@moonshot-ai/kaos';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import { ClientAPI, SDKRpcClientBase } from '#/rpc';
import type {
  CreateSessionOptions,
  KimiHarnessOptions,
  KimiHostIdentity,
  OAuthRefreshOutcome,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
} from '#/types';

const SERVICES_CORE_ENV = 'KIMI_CODE_EXPERIMENTAL_SERVICES_CORE';

export interface SDKRpcClientOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
}

export class SDKRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly core: KimiCore;

  private readonly ready: Promise<RPCMethods<CoreAPI>>;
  private readonly servicesCore: Promise<ServicesCoreAdapter | undefined>;

  constructor(options: SDKRpcClientOptions = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    this.core = new KimiCore(coreRpc, {
      homeDir: options.homeDir,
      configPath: this.configPath,
      kimiRequestHeaders: this.createKimiRequestHeaders(),
      resolveOAuthTokenProvider:
        options.resolveOAuthTokenProvider ?? this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      telemetry: this.telemetry,
      appVersion: this.identity?.version,
    });
    const sdkApi = new ClientAPI(this);
    const legacyReady = sdkRpc(sdkApi);
    this.servicesCore = Promise.resolve().then(() => {
      if (!useServicesCore()) return undefined;
      return createServicesCoreAdapter({
        coreProcessOptions: {
          kimiRequestHeaders: this.createKimiRequestHeaders(),
          resolveOAuthTokenProvider:
            options.resolveOAuthTokenProvider ?? this.auth.resolveOAuthTokenProvider,
          skillDirs: options.skillDirs,
          telemetry: this.telemetry,
          appVersion: this.identity?.version,
          identity: this.identity,
        },
        sdk: sdkApi,
        homeDir: this.homeDir,
        configPath: this.configPath,
      });
    });
    this.ready = this.servicesCore.then(async (servicesCore) => {
      if (servicesCore === undefined) return legacyReady;
      await servicesCore.ready();
      return servicesCore.rpc;
    });
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    const servicesCore = await this.servicesCore.catch(() => undefined);
    servicesCore?.dispose();
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
  }

  protected async getRpc(): Promise<RPCMethods<CoreAPI>> {
    return this.ready;
  }

  override async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    const { planMode, ...coreInput } = input;
    void planMode;
    return this.core.createSessionWithOverrides(coreInput, { kaos, persistenceKaos });
  }

  override async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    return this.core.resumeSessionWithOverrides(
      { ...input, sessionId: input.id },
      { kaos, persistenceKaos },
    );
  }

  private createKimiRequestHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir: this.homeDir,
      ...this.identity,
    });
  }
}

function useServicesCore(): boolean {
  const value = process.env[SERVICES_CORE_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClient(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
