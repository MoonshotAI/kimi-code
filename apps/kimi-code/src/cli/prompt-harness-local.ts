/**
 * prompt-harness-local.ts — localized harness factory for print mode
 * (G-1 consumption cutover).
 *
 * `run-prompt.ts` previously imported `createKimiHarness` directly from
 * `@moonshot-ai/kimi-code-sdk`. The local implementation drives native
 * engine sessions (the same bridge the TUI/ACP use): config reads/writes go
 * through the local runtime-config helpers, and session lifecycle goes
 * through `NativeServerClient` + `createNativeTuiSession`. This removes the
 * last `@moonshot-ai/kimi-code-sdk` import from the CLI host.
 */

import { open, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { KimiAuthFacade } from '#/cli/auth-local';
import type { KimiHostIdentity } from '#/cli/oauth-local';
import { createNativeTuiSession, listNativeSessions } from '#/cli/native-session';
import { NativeServerClient } from '#/cli/native-server-client';
import { loadRuntimeConfigSafe, resolveConfigPath, resolveKimiHome } from '#/cli/runtime-config';
import {
  loadNativeLlmDef,
  loadSessionHooks,
  loadSessionMcpServers,
  loadSessionSystemPrompt,
} from '#/cli/rust-engine';
import type { TelemetryClient, TelemetryProperties } from '#/cli/telemetry';

import type { PromptHarness, PromptSession } from './prompt-session';
import type { SessionSummary } from './prompt-session-local';

/** OAuth token-refresh outcome reported to harness consumers (mirror of the
 *  oauth package type; `run-prompt.ts` reads `success` / `reason`). */
export type OAuthRefreshOutcome =
  | { readonly success: true }
  | { readonly success: false; readonly reason: 'unauthorized' | 'network_or_other' };

/** The harness creation options print mode consumes (SDK subset). */
export interface KimiHarnessOptions {
  readonly identity?: KimiHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly uiMode?: string;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly sessionStartedProperties?: TelemetryProperties;
}

const DEFAULT_CONFIG_SCAFFOLD = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

/** Create the print-mode harness backed by native engine sessions. */
export function createKimiHarness(options: KimiHarnessOptions): PromptHarness {
  const homeDir = options.homeDir ?? resolveKimiHome();
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  // The engine's session store is in-memory unless `KIMI_AGENT_HOME` points
  // at a directory (see `kimi-server/src/state.rs:open_session_store`). Pin
  // it to a stable dir under the kimi home so print sessions persist across
  // runs (session/list + session/load). Only set when absent — an explicit
  // override (tests, embedding hosts) wins.
  const agentHome = process.env['KIMI_AGENT_HOME'];
  if (agentHome === undefined || agentHome.trim().length === 0) {
    process.env['KIMI_AGENT_HOME'] = join(homeDir, 'agent');
  }

  let client: NativeServerClient | undefined;
  const ensureClient = (): NativeServerClient => {
    if (client === undefined) client = new NativeServerClient();
    return client;
  };
  const auth = new KimiAuthFacade({ homeDir, configPath, identity: options.identity });

  const startNativeSession = async (
    init: {
      sessionId: string;
      workDir: string;
      model?: string;
      additionalDirs?: readonly string[];
    },
    resume?: { sessionId: string },
  ): Promise<PromptSession> => {
    const mcpServers = await loadSessionMcpServers(homeDir, init.workDir);
    const native = await createNativeTuiSession(
      ensureClient(),
      {
        sessionId: init.sessionId,
        workDir: init.workDir,
        systemPrompt: (await loadSessionSystemPrompt(homeDir, init.workDir)) ?? undefined,
        model: init.model,
        goalEnabled: true,
        homedir: homeDir,
        nativeLlm: loadNativeLlmDef(homeDir, configPath),
        mcpServers: [...mcpServers.values()],
        hooks: await loadSessionHooks(homeDir, configPath),
        // Print mode: `auto` mirrors the old headless default (no approval
        // UI to gate tools against).
        permissionMode: 'auto',
      },
      resume,
    );
    if (native === null) {
      if (resume !== undefined) {
        throw new Error(`Session not found: ${resume.sessionId}`);
      }
      throw new Error('Native engine session is unavailable.');
    }
    for (const dir of init.additionalDirs ?? []) {
      await native.addAdditionalDir(dir);
    }
    return native;
  };

  return {
    homeDir,
    auth,
    track: (event: string, properties?: TelemetryProperties): void => {
      options.telemetry?.track(event, properties);
    },
    ensureConfigFile: async (): Promise<void> => {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(configPath, 'wx', 0o600);
        await handle.writeFile(DEFAULT_CONFIG_SCAFFOLD, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw error;
      } finally {
        await handle?.close();
      }
    },
    getConfig: async (): Promise<Pick<{ defaultModel?: string; telemetry?: boolean }, 'defaultModel' | 'telemetry'>> => {
      const { config } = loadRuntimeConfigSafe(configPath);
      return {
        ...(config['defaultModel'] !== undefined ? { defaultModel: config['defaultModel'] as string } : {}),
        ...(config['telemetry'] !== undefined ? { telemetry: config['telemetry'] as boolean } : {}),
      };
    },
    getConfigDiagnostics: (): Promise<{ warnings: readonly string[] }> => {
      // The engine is authoritative for config validation (`kimi doctor`);
      // print mode only surfaces warnings, and the local read is lenient.
      return Promise.resolve({ warnings: [] });
    },
    listSessions: async (listOptions): Promise<readonly SessionSummary[]> => {
      const records = await listNativeSessions(ensureClient(), listOptions?.workDir);
      return records.map((record) => ({
        id: record.id,
        workDir: record.work_dir,
        sessionDir: record.work_dir,
        createdAt: Number(record.created_at) || 0,
        updatedAt: Number(record.updated_at) || 0,
        ...(record.title.length > 0 ? { title: record.title } : {}),
      }));
    },
    createSession: async (sessionOptions): Promise<PromptSession> =>
      startNativeSession({
        sessionId: sessionOptions.id ?? `session_${cryptoRandomId()}`,
        workDir: sessionOptions.workDir,
        model: sessionOptions.model,
        additionalDirs: sessionOptions.additionalDirs,
      }),
    resumeSession: async (input): Promise<PromptSession> => {
      // Locate the persisted workspace for the resumed id (the engine stores
      // it at creation); a missing record is the SDK's session.not_found.
      const records = await listNativeSessions(ensureClient());
      const record = records.find((candidate) => candidate.id === input.id);
      if (record === undefined) {
        throw new Error(`Session not found: ${input.id}`);
      }
      return startNativeSession(
        {
          sessionId: input.id,
          workDir: record.work_dir,
          additionalDirs: input.additionalDirs,
        },
        { sessionId: input.id },
      );
    },
    close: async (): Promise<void> => {
      client?.close();
      client = undefined;
    },
  };
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
