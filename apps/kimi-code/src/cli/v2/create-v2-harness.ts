/**
 * agent-core-v2 in-process harness for `kimi -p` (print mode).
 *
 * Selected by `createPromptHarness` when `KIMI_CODE_EXPERIMENTAL_FLAG` is set.
 * Builds the v2 engine via `bootstrap()` and exposes it through the narrow
 * {@link PromptHarness} surface that the print-mode driver consumes. Imported
 * lazily so the v2 module graph stays off the default (v1) path.
 */

import {
  IAgentPermissionModeService,
  IAgentProfileService,
  IConfigService,
  ISessionIndex,
  ISessionLifecycleService,
  bootstrap,
  ensureMainAgent,
  logSeed,
  resolveLoggingConfig,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  KimiAuthFacade,
  resolveConfigPath,
  resolveKimiHome,
  type ConfigDiagnostics,
  type CreateSessionOptions,
  type KimiConfig,
  type KimiHarnessOptions,
  type ListSessionsOptions,
  type ResumeSessionInput,
  type SessionSummary,
  type TelemetryProperties,
} from '@moonshot-ai/kimi-code-sdk';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PromptHarness, PromptSession } from '../prompt-session';

import { V2Session } from './v2-session';

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

export async function createV2Harness(options: KimiHarnessOptions): Promise<PromptHarness> {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const { app: core } = bootstrap({ homeDir, configPath }, logSeed(logging));
  const auth = new KimiAuthFacade({
    homeDir,
    configPath,
    identity: options.identity,
    onRefresh: options.onOAuthRefresh,
  });
  return new V2PromptHarness({
    core,
    homeDir,
    configPath,
    auth,
    track: (event, properties) => options.telemetry?.track(event, properties),
  });
}

interface V2PromptHarnessContext {
  readonly core: Scope;
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;
  readonly track: (event: string, properties?: TelemetryProperties) => void;
}

class V2PromptHarness implements PromptHarness {
  readonly homeDir: string;
  readonly auth: KimiAuthFacade;

  private readonly core: Scope;
  private readonly configPath: string;
  private readonly trackImpl: (event: string, properties?: TelemetryProperties) => void;

  constructor(context: V2PromptHarnessContext) {
    this.core = context.core;
    this.homeDir = context.homeDir;
    this.configPath = context.configPath;
    this.auth = context.auth;
    this.trackImpl = context.track;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.trackImpl(event, properties);
  }

  async ensureConfigFile(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.configPath, 'wx', 0o600);
      await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async getConfig(): Promise<Pick<KimiConfig, 'defaultModel' | 'telemetry'>> {
    const config = this.core.accessor.get(IConfigService);
    await config.ready;
    const defaultModel = config.get<string>('defaultModel') ?? undefined;
    let telemetry: KimiConfig['telemetry'];
    try {
      telemetry = config.get<KimiConfig['telemetry']>('telemetry');
    } catch {
      telemetry = undefined;
    }
    return { defaultModel, telemetry };
  }

  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    const config = this.core.accessor.get(IConfigService);
    const diagnostics = config.diagnostics();
    return {
      warnings: diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
    };
  }

  async listSessions(options: ListSessionsOptions): Promise<readonly SessionSummary[]> {
    const index = this.core.accessor.get(ISessionIndex);
    const page = await index.list({});
    let items = page.items;
    if (options.sessionId !== undefined) {
      items = items.filter((summary) => summary.id === options.sessionId);
    }
    if (options.workDir !== undefined) {
      items = items.filter((summary) => summary.cwd === options.workDir);
    }
    return items.map(toSdkSessionSummary);
  }

  async createSession(options: CreateSessionOptions): Promise<PromptSession> {
    const session = await this.core.accessor.get(ISessionLifecycleService).create({
      workDir: options.workDir,
      additionalDirs: options.additionalDirs,
    });
    const agent = await ensureMainAgent(session);
    if (options.model !== undefined) {
      await agent.accessor.get(IAgentProfileService).setModel(options.model);
    }
    agent.accessor.get(IAgentPermissionModeService).setMode(options.permission ?? 'auto');
    return new V2Session({ core: this.core, session, agent });
  }

  async resumeSession(input: ResumeSessionInput): Promise<PromptSession> {
    const session = await this.core.accessor.get(ISessionLifecycleService).resume(input.id);
    if (session === undefined) {
      throw new Error(`Session "${input.id}" not found.`);
    }
    const agent = await ensureMainAgent(session);
    return new V2Session({ core: this.core, session, agent });
  }

  async close(): Promise<void> {
    this.core.dispose();
  }
}

function toSdkSessionSummary(summary: {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly cwd?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}): SessionSummary {
  return {
    id: summary.id,
    title: summary.title,
    lastPrompt: summary.lastPrompt,
    workDir: summary.cwd ?? '',
    // v2 does not persist a separate sessionDir on the index summary; the print
    // driver never reads it from list results, so expose the workDir as a
    // stand-in to satisfy the SDK shape.
    sessionDir: summary.cwd ?? '',
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
    metadata: summary.custom as SessionSummary['metadata'],
  };
}
