/**
 * v2 wiring MVP — an `SDKRpcClientBase` backed by the agent-core-v2 engine
 * (DI × Scope) instead of the v1 `KimiCore` RPC pair. The engine is
 * bootstrapped in-process and reached through the klient facade over the
 * memory transport, so every call crosses the same contract validation and
 * JSON round-trip as the networked transports.
 *
 * Migration model: the base class still carries the v1 method surface. Any
 * method not yet overridden here falls through to `getRpc()`, which fails
 * loudly with `not_implemented` — migrated methods are the ones overridden
 * below. Once every method is migrated, the v1 `getRpc()` dependency (and
 * the v1 core) goes away entirely.
 *
 * Migrated so far:
 * - `getExperimentalFeatures` → `klient.global.flags.list()`
 */
import {
  ensureConfigFile,
  ErrorCodes,
  KimiError,
  noopTelemetryClient,
  type ExperimentalFeatureState,
} from '@moonshot-ai/agent-core';
import {
  bootstrap,
  ensureKimiHome,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';
import { assertKimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import { SDKRpcClientBase } from '#/rpc';
import type {
  KimiHarnessOptions,
  KimiHostIdentity,
  OAuthRefreshOutcome,
  TelemetryClient,
} from '#/types';

export interface SDKRpcClientV2Options {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  readonly uiMode?: string;
}

export class SDKRpcClientV2 extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly klient: Klient;

  private readonly app: Scope;

  constructor(options: SDKRpcClientV2Options = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    ensureKimiHome(this.homeDir);
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    const { app } = bootstrap(
      {
        homeDir: this.homeDir,
        configPath: this.configPath,
        clientVersion: this.identity?.version,
      },
      [...logSeed(resolveLoggingConfig({ homeDir: this.homeDir, env: process.env }))],
    );
    this.app = app;
    this.klient = createKlient({ scope: app });
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    await this.klient.close();
    this.app.dispose();
  }

  protected getRpc(): Promise<never> {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK method is not wired to agent-core-v2 yet.',
    );
  }

  override async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.klient.global.flags.list();
  }
}

export function createKimiHarnessV2(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClientV2(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    // v1-core-owned ingestion limits; the v2 engine has no equivalent yet, so
    // ingestion falls back to env / built-in defaults like daemon-client hosts.
    imageLimits: undefined,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
