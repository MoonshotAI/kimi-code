/**
 * Local ACP harness — the `KimiHarness`-shaped surface
 * `@moonshot-ai/acp-adapter`'s `runAcpServer` consumes at runtime, built
 * over the native Rust engine bridge (`#/cli/native-session` +
 * `#/cli/native-server-client`) and the local config/auth modules (G-1 CLI
 * consumption cutover: the node-sdk harness is no longer imported by the
 * `acp` sub-command).
 *
 * Wire-up:
 *  - Sessions are native engine sessions (fresh + resume) via
 *    `createNativeTuiSession`, one `kimi-server-serve` subprocess per
 *    harness. The engine's session store defaults to in-memory, so the
 *    harness pins `KIMI_AGENT_HOME` to a stable dir under the kimi home
 *    before the first spawn — `session/list` + `session/load` (ACP session
 *    pickers / resume) survive across `kimi acp` runs.
 *  - The auth gate (`auth.status`) reads the oauth credential file; the
 *    configOptions assembly (`getConfig`) reads the local config.toml.
 *  - `track` is a no-op — the previous harness default when the host
 *    supplied no telemetry client.
 *  - `Session` / `SkillSummary` are local structural mirrors of the SDK
 *    types (see `sdk-types-local.ts`).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  createNativeTuiSession,
  listNativeSessions,
} from '#/cli/native-session';import {
  NativeServerClient,
  type McpServerInput,
} from '#/cli/native-server-client';
import {
  loadNativeLlmDef,
  loadSessionHooks,
  loadSessionMcpServers,
  loadSessionSystemPrompt,
} from '#/cli/rust-engine';
import { resolveConfigPath, resolveKimiHome, loadRuntimeConfigSafe } from '#/cli/runtime-config';
import type { SkillSummary } from '#/cli/sdk-types-local';

import { kimiAuthStatus, type ManagedKimiAuthStatus } from './login-local';

/** Local mirror of the SDK `SkillSummary` (see `sdk-types-local.ts`). */
export type { SkillSummary } from '#/cli/sdk-types-local';

/* ------------------------------------------------------------------ */
/* Local type surface (structural mirrors of the SDK types)            */
/* ------------------------------------------------------------------ */

/** ACP-facing session surface (the slash-command resolver calls `listSkills`). */
export interface Session {
  readonly id: string;
  readonly workDir: string;
  listSkills(): Promise<readonly SkillSummary[]>;
}

/** Session summary shape `session/list` needs (id/workDir/title/updatedAt). */
export interface SessionSummaryLike {
  readonly id: string;
  readonly workDir: string;
  readonly title?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionDir?: string | undefined;
}

/** `harness.createSession` options (loose — the adapter forwards extras). */
export interface AcpCreateSessionOptions {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly mcpServers?: Readonly<Record<string, Record<string, unknown>>> | undefined;
  readonly sessionStartedProperties?: Readonly<Record<string, unknown>> | undefined;
}

/** `harness.resumeSession` input (the adapter forwards extras). */
export interface AcpResumeSessionInput {
  readonly id: string;
  readonly workDir?: string | undefined;
  readonly mcpServers?: Readonly<Record<string, Record<string, unknown>>> | undefined;
  readonly sessionStartedProperties?: Readonly<Record<string, unknown>> | undefined;
}

/** The local ACP harness object passed to `runAcpServer`. */
export interface AcpHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: { status(): Promise<ManagedKimiAuthStatus> };
  getConfig(): Promise<Record<string, unknown>>;
  createSession(options: AcpCreateSessionOptions): Promise<Session>;
  resumeSession(input: AcpResumeSessionInput): Promise<Session>;
  listSessions(
    options?: { workDir?: string | undefined },
  ): Promise<readonly SessionSummaryLike[]>;
  track(event: string, properties?: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Harness assembly                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_ACP_SYSTEM_PROMPT =
  'You are Kimi Code, an agentic coding assistant. Answer directly and use tools when needed.';

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

/** Map ACP-supplied MCP servers (adapter's `acpMcpServersToConfigs` output)
 *  onto the native session wire input. Unsupported transports are skipped. */
function toMcpServerInputs(
  servers: Readonly<Record<string, Record<string, unknown>>> | undefined,
): McpServerInput[] {
  if (servers === undefined) return [];
  const out: McpServerInput[] = [];
  for (const [key, config] of Object.entries(servers)) {
    const name =
      typeof config['name'] === 'string' && config['name'].length > 0 ? config['name'] : key;
    const transport = config['transport'];
    if (transport === 'stdio') {
      out.push({
        name,
        transport: 'stdio',
        enabled: true,
        command: typeof config['command'] === 'string' ? config['command'] : '',
        args: Array.isArray(config['args']) ? config['args'].map(String) : [],
        env: isStringRecord(config['env']) ? config['env'] : undefined,
        cwd: typeof config['cwd'] === 'string' ? config['cwd'] : undefined,
      });
    } else if (transport === 'http' || transport === 'sse') {
      out.push({
        name,
        transport,
        enabled: true,
        url: typeof config['url'] === 'string' ? config['url'] : undefined,
        bearerToken:
          typeof config['bearerToken'] === 'string' ? config['bearerToken'] : undefined,
        bearerTokenEnvVar:
          typeof config['bearerTokenEnvVar'] === 'string'
            ? config['bearerTokenEnvVar']
            : undefined,
        hasHeaders: config['hasHeaders'] === true,
      });
    }
  }
  return out;
}

/** Error with an `code` field — matches the SDK `KimiError` protocol the
 *  adapter's `loadSession` error mapping inspects (`session.not_found`). */
function sessionNotFoundError(id: string): Error & { code: string } {
  return Object.assign(new Error(`Session not found: ${id}`), { code: 'session.not_found' });
}

/**
 * Build the ACP harness: native engine sessions over one spawned
 * `kimi-server-serve`, local config/auth for the gate + pickers.
 */
export function createAcpHarness(): AcpHarness {
  const homeDir = resolveKimiHome();
  const configPath = resolveConfigPath({ homeDir });
  // The engine's session store is in-memory unless `KIMI_AGENT_HOME` points
  // at a directory (see `kimi-server/src/state.rs:open_session_store`).
  // Pin it to a stable dir under the kimi home so ACP sessions persist
  // across `kimi acp` runs (session/list + session/load). Only set when
  // absent — an explicit override (tests, embedding hosts) wins.
  const agentHome = process.env['KIMI_AGENT_HOME'];
  if (agentHome === undefined || agentHome.trim().length === 0) {
    process.env['KIMI_AGENT_HOME'] = join(homeDir, 'agent');
  }

  let client: NativeServerClient | undefined;
  const ensureClient = (): NativeServerClient => {
    if (client === undefined) client = new NativeServerClient();
    return client;
  };

  const startNativeSession = async (
    init: {
      sessionId: string;
      workDir: string;
      systemPrompt?: string;
      model?: string;
      homedir: string;
      extraMcpServers?: McpServerInput[];
    },
    resume?: { sessionId: string },
  ): Promise<Session> => {
    // Merge user-global MCP servers (mcp.json + plugins) with the
    // ACP-supplied ones; on a name collision the ACP-supplied server wins.
    const mcpServers = new Map<string, McpServerInput>();
    for (const server of await loadSessionMcpServers(homeDir, init.workDir)) {
      mcpServers.set(server.name, server);
    }
    for (const server of init.extraMcpServers ?? []) {
      mcpServers.set(server.name, server);
    }
    const native = await createNativeTuiSession(
      ensureClient(),
      {
        sessionId: init.sessionId,
        workDir: init.workDir,
        systemPrompt: init.systemPrompt,
        model: init.model,
        goalEnabled: true,
        homedir: init.homedir,
        nativeLlm: loadNativeLlmDef(homeDir, configPath),
        mcpServers: [...mcpServers.values()],
        hooks: await loadSessionHooks(homeDir, configPath),
        // Manual: gated tools route through the adapter's approval bridge
        // (wired via `NativeSession.setApprovalHandler`).
        permissionMode: 'manual',
      },
      resume,
    );
    if (native === null) {
      if (resume !== undefined) throw sessionNotFoundError(resume.sessionId);
      throw new Error('Native engine session is unavailable.');
    }
    return native;
  };

  return {
    homeDir,
    configPath,
    auth: {
      status: (): Promise<ManagedKimiAuthStatus> =>
        Promise.resolve(kimiAuthStatus(homeDir)),
    },
    getConfig: (): Promise<Record<string, unknown>> =>
      Promise.resolve(loadRuntimeConfigSafe(configPath).config),
    createSession: async (sessionOptions): Promise<Session> => {
      const workDir = sessionOptions.workDir;
      const systemPrompt =
        (await loadSessionSystemPrompt(homeDir, workDir)) ?? DEFAULT_ACP_SYSTEM_PROMPT;
      return startNativeSession({
        sessionId: sessionOptions.id ?? `session_${randomUUID()}`,
        workDir,
        systemPrompt,
        model: sessionOptions.model,
        homedir: workDir,
        extraMcpServers: toMcpServerInputs(sessionOptions.mcpServers),
      });
    },
    resumeSession: (input): Promise<Session> => {
      const workDir = input.workDir ?? homeDir;
      return startNativeSession(
        {
          sessionId: input.id,
          workDir,
          homedir: workDir,
          extraMcpServers: toMcpServerInputs(input.mcpServers),
        },
        { sessionId: input.id },
      );
    },
    listSessions: async (options): Promise<readonly SessionSummaryLike[]> => {
      const records = await listNativeSessions(ensureClient(), options?.workDir);
      return records.map((record) => ({
        id: record.id,
        workDir: record.work_dir,
        title: record.title.length > 0 ? record.title : undefined,
        createdAt: Number(record.created_at) || 0,
        updatedAt: Number(record.updated_at) || 0,
        sessionDir: record.work_dir,
      }));
    },
    track: (): void => {
      // No-op: the previous harness had no telemetry client in the ACP path.
    },
    close: (): Promise<void> => {
      client?.close();
      client = undefined;
      return Promise.resolve();
    },
  };
}
