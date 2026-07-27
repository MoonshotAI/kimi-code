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
 * - `listWorkspaceSkills` → not covered by the klient facade, so it goes
 *   through the `engineAccessor` escape hatch (`ISkillDiscovery` + the v2
 *   skill-root helpers) instead.
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
  BUILTIN_SKILLS,
  ensureKimiHome,
  IBootstrapService,
  ISkillDiscovery,
  logSeed,
  projectRoots,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  userRoots,
  type Scope,
  type ServicesAccessor,
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
  SkillSummary,
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

  /**
   * Escape hatch to the in-process engine's app-scope service accessor, for
   * SDK methods whose capability exists in agent-core-v2 but is not (yet)
   * exposed through the klient facade. This is a deliberate migration
   * pressure valve, not a new public API direction:
   * - it only exists because this client owns the bootstrapped `Scope` —
   *   there is nothing equivalent on a remote (ipc) transport, so anything
   *   built on it is in-process-only by construction;
   * - it resolves App-scope services only. Session/agent services need their
   *   own scope handles (via the lifecycle services), not this accessor;
   * - every use should name the klient facade method it stands in for, and
   *   move onto the facade once one exists. Remove when the migration ends.
   */
  get engineAccessor(): ServicesAccessor {
    return this.app.accessor;
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

  /**
   * klient has no skills facade; composed directly from the engine's
   * app-scope `ISkillDiscovery` plus the v2 root helpers (user + project
   * roots) and the code-defined `BUILTIN_SKILLS` via {@link engineAccessor}.
   * Gap vs the v1 implementation: plugin skills are not included, and
   * `skillDirs` (explicit dirs) is not honored yet.
   */
  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const bootstrapService = this.engineAccessor.get(IBootstrapService);
    const discovery = this.engineAccessor.get(ISkillDiscovery);
    const roots = [
      ...(await userRoots(bootstrapService.homeDir, bootstrapService.osHomeDir)),
      ...(await projectRoots(workDir)),
    ];
    const { skills } = await discovery.discover(roots);
    // Builtins are the lowest-priority contribution: a discovered skill with
    // the same name shadows the builtin (v1 registry semantics).
    const byName = new Map<string, SkillSummary>();
    for (const skill of [...BUILTIN_SKILLS, ...skills]) {
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source: skill.source,
        type: skill.metadata.type,
        disableModelInvocation: skill.metadata.disableModelInvocation,
        isSubSkill: skill.metadata.isSubSkill,
      });
    }
    return [...byName.values()];
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
