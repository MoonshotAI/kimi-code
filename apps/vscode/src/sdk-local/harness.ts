/**
 * Local `KimiHarness` implementation — the extension-host owner of one
 * `kimi-server-serve` stdio connection, replacing the node-sdk
 * `createKimiHarness` (G-1 vscode localization). Sessions are `LocalSession`
 * handles; MCP global config, skills discovery, and auth are implemented
 * locally (mcp-config / skills / auth modules).
 */

import { join } from "node:path";

import { LocalKimiAuth } from "./auth";
import {
  GlobalMcpConfigStore,
  beginGlobalMcpServerAuth,
  cancelGlobalMcpServerAuth,
  completeGlobalMcpServerAuth,
} from "./mcp-config";
import { testGlobalMcpServer } from "./mcp-test";
import { EngineRpcClient, METHODS } from "./rpc-client";
import { LocalSession } from "./session";
import { listWorkspaceSkills } from "./skills";
import type {
  KimiAuthFacade,
  KimiConfig,
  McpServerConfig,
  McpTestResult,
  SessionSummary,
  SkillSummary,
} from "./types";

/** Wire `NativeLlmConfig` shape (kimi-agent `rpc/wire.gen.ts`). */
interface NativeLlmConfig {
  readonly protocol: string;
  readonly base_url: string;
  readonly api_key: string;
  readonly model: string;
}

/** Options accepted by `createLocalHarness`. */
export interface LocalKimiHarnessOptions {
  readonly homeDir?: string;
  readonly identity?: { userAgentProduct?: string; version?: string };
  readonly uiMode?: string;
  /** Override the server binary (default: `findServerBinary()` resolution). */
  readonly binary?: string;
}

/** The harness surface the extension consumes (node-sdk `KimiHarness`
 *  parity, local implementation). */
export interface LocalKimiHarness {
  readonly homeDir: string;
  readonly auth: KimiAuthFacade;
  createSession(options: CreateSessionOptions): Promise<LocalSession>;
  resumeSession(input: ResumeSessionInput): Promise<LocalSession>;
  closeSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  forkSession(input: ForkSessionInput): Promise<LocalSession>;
  listSessions(options?: { sessionId?: string; workDir?: string }): Promise<readonly SessionSummary[]>;
  getConfig(options?: { reload?: boolean }): Promise<KimiConfig>;
  setConfig(patch: Record<string, unknown>): Promise<unknown>;
  listMcpServers(): Promise<readonly McpServerConfig[]>;
  addMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]>;
  updateMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]>;
  removeMcpServer(name: string): Promise<readonly McpServerConfig[]>;
  authenticateMcpServer(
    name: string,
    options: { onAuthorizationUrl: (url: string) => Promise<boolean> | boolean },
  ): Promise<void>;
  resetMcpServerAuth(name: string): Promise<void>;
  testMcpServer(name: string, options?: { cwd?: string }): Promise<McpTestResult>;
  listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]>;
  close(): Promise<void>;
}

export interface CreateSessionOptions {
  readonly id?: string;
  readonly workDir: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly includeSubagents?: boolean;
}

export interface ForkSessionInput {
  readonly id: string;
  readonly turnIndex?: number;
}

class LocalKimiHarnessImpl implements LocalKimiHarness {
  readonly homeDir: string;
  readonly auth: LocalKimiAuth;
  private readonly rpc: EngineRpcClient;
  private readonly mcpStore: GlobalMcpConfigStore;
  private readonly uiMode: string | undefined;
  private readonly identity: { userAgentProduct?: string; version?: string } | undefined;
  /** Host mirror of sessions this harness created/resumed, with host fields
   *  the engine's `session/list` record does not carry (`additionalDirs`).
   *  The engine store is process-global (shared across harnesses), so
   *  listing merges this mirror with the engine records (node-sdk parity). */
  private readonly sessionSummaries = new Map<string, SessionSummary>();
  private closed = false;

  constructor(options: LocalKimiHarnessOptions) {
    this.homeDir = options.homeDir ?? "";
    this.uiMode = options.uiMode;
    this.identity = options.identity;
    this.rpc = new EngineRpcClient(
      options.binary,
      // The engine process resolves its own config; point it at the same
      // home the host uses so `config/get` and the native-LLM derivation
      // agree with the host's view.
      options.homeDir !== undefined && options.homeDir.length > 0
        ? {
            KIMI_CODE_HOME: options.homeDir,
            KIMI_CONFIG_PATH: join(options.homeDir, "config.toml"),
          }
        : undefined,
    );
    this.auth = new LocalKimiAuth(this.rpc);
    this.mcpStore = new GlobalMcpConfigStore(this.homeDir.length > 0 ? this.homeDir : undefined);
  }

  async createSession(options: CreateSessionOptions): Promise<LocalSession> {
    const sessionId =
      options.id ?? `sess-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const params: Record<string, unknown> = {
      session_id: sessionId,
      work_dir: options.workDir,
      // Native tool execution: the engine sandboxes write/bash/network tools
      // behind the permission gate (node-sdk `sessionCreate` parity). Without
      // it, tool calls route to a host `execute_tool` callback that a stdio
      // harness cannot serve.
      native_tools: true,
      workspace_root: options.workDir,
      ...(this.homeDir.length > 0 ? { homedir: this.homeDir } : {}),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(this.uiMode === undefined ? {} : { ui_mode: this.uiMode }),
      goal_enabled: false,
    };
    // Derive the native LLM from the engine config (mirrors the node-sdk
    // harness `config_llm` behavior): the first provider with a token and a
    // base URL, resolved through the requested/default model alias.
    const nativeLlm = await this.deriveNativeLlm(options.model).catch(() => {});
    if (nativeLlm !== undefined) {
      params["native_llm"] = nativeLlm;
    }
    await this.rpc.call(METHODS.SESSION_CREATE, params);
    const now = Date.now();
    const summary: SessionSummary = {
      id: sessionId,
      workDir: options.workDir,
      createdAt: now,
      updatedAt: now,
    };
    this.sessionSummaries.set(sessionId, summary);
    const session = new LocalSession(sessionId, this.rpc, summary, (updated) => {
      this.sessionSummaries.set(sessionId, updated);
    });
    if (options.thinking !== undefined && options.thinking.length > 0) {
      await this.rpc
        .call(METHODS.SESSION_SET_THINKING, {
          session_id: sessionId,
          effort: options.thinking,
        })
        .catch(() => {});
    }
    if (options.permission !== undefined && options.permission.length > 0) {
      await this.rpc
        .call(METHODS.PERMISSION_SET_MODE, { mode: options.permission })
        .catch(() => {});
    }
    if (options.metadata !== undefined && Object.keys(options.metadata).length > 0) {
      await this.rpc
        .call(METHODS.SESSION_UPDATE_METADATA, {
          session_id: sessionId,
          metadata: options.metadata,
        })
        .catch(() => {});
    }
    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<LocalSession> {
    const sessionId = input.id;
    // The persisted record carries the workspace; surface it as the native
    // tool sandbox root on the re-create (the engine also falls back to the
    // persisted work_dir, this makes it explicit).
    const known = await this.findSummary(sessionId).catch(() => {});
    await this.rpc.call(METHODS.SESSION_CREATE, {
      session_id: sessionId,
      native_tools: true,
      ...(known !== undefined && known.workDir.length > 0
        ? { workspace_root: known.workDir }
        : {}),
      ...(this.homeDir.length > 0 ? { homedir: this.homeDir } : {}),
      goal_enabled: false,
    });
    await this.rpc.call(METHODS.SESSION_LOAD, { session_id: sessionId });
    const summary = await this.findSummary(sessionId);
    if (summary !== undefined) {
      this.sessionSummaries.set(sessionId, summary);
    }
    const session = new LocalSession(sessionId, this.rpc, summary, (updated) => {
      this.sessionSummaries.set(sessionId, updated);
    });
    // Resume snapshot for the replay adapter: rebuild from the engine
    // context (the same `mapContextMessage` mapping the context surface
    // uses), with the minimal session-metadata envelope.
    const context = await this.rpc
      .call(METHODS.SESSION_GET_STATUS, { session_id: sessionId })
      .catch(() => null);
    const history = await this.rpc
      .call(METHODS.SESSION_GET_CONTEXT, { session_id: sessionId })
      .catch(() => null);
    session.setResumeState(
      LocalSession.resumeStateFromContext(
        sessionId,
        summary?.workDir,
        history,
        (context ?? {}) as Record<string, unknown>,
      ),
    );
    return session;
  }

  async closeSession(id: string): Promise<void> {
    await this.rpc.call(METHODS.SESSION_SAVE, { session_id: id }).catch(() => {});
  }

  async deleteSession(id: string): Promise<void> {
    await this.rpc.call(METHODS.SESSION_DELETE, { session_id: id });
  }

  async forkSession(input: ForkSessionInput): Promise<LocalSession> {
    const forkId = `sess-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const params: Record<string, unknown> = {
      session_id: input.id,
      fork_id: forkId,
    };
    if (input.turnIndex !== undefined) params["turn_index"] = input.turnIndex;
    await this.rpc.call(METHODS.SESSION_FORK, params);
    const summary = await this.findSummary(forkId);
    if (summary !== undefined) {
      this.sessionSummaries.set(forkId, summary);
    }
    return new LocalSession(forkId, this.rpc, summary, (updated) => {
      this.sessionSummaries.set(forkId, updated);
    });
  }

  async listSessions(options?: { sessionId?: string; workDir?: string }): Promise<readonly SessionSummary[]> {
    // The engine's `session/list` default limit is 50 (most recent first);
    // hosts list the whole store (node-sdk `sessionList` parity), so request
    // an unbounded page — a small default silently drops older sessions from
    // cross-harness listing and resume lookups.
    const result = (await this.rpc.call(METHODS.SESSION_LIST, { limit: 100_000 })) as {
      sessions?: readonly Record<string, unknown>[];
    };
    let sessions = (result?.sessions ?? []).map(mapSessionSummary);
    // Merge the host mirror (host fields such as `additionalDirs`) over the
    // engine records, keyed by id (node-sdk `sessionSummaries` parity).
    const byId = new Map<string, SessionSummary>();
    for (const summary of sessions) {
      byId.set(summary.id, summary);
    }
    for (const [id, summary] of this.sessionSummaries) {
      const existing = byId.get(id);
      byId.set(id, existing === undefined ? summary : { ...existing, ...summary });
    }
    sessions = [...byId.values()];
    if (options?.sessionId !== undefined) {
      sessions = sessions.filter((summary) => summary.id === options.sessionId);
    }
    if (options?.workDir !== undefined) {
      sessions = sessions.filter((summary) => summary.workDir === options.workDir);
    }
    return sessions;
  }

  async getConfig(options?: { reload?: boolean }): Promise<KimiConfig> {
    return (await this.rpc.call(METHODS.CONFIG_GET, options ?? {})) as KimiConfig;
  }

  async setConfig(patch: Record<string, unknown>): Promise<unknown> {
    return this.rpc.call(METHODS.CONFIG_SET, { patch });
  }

  async listMcpServers(): Promise<readonly McpServerConfig[]> {
    return this.mcpStore.list();
  }

  async addMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    return this.mcpStore.add(server);
  }

  async updateMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    return this.mcpStore.update(server);
  }

  async removeMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    return this.mcpStore.remove(name);
  }

  async authenticateMcpServer(
    name: string,
    options: { onAuthorizationUrl: (url: string) => Promise<boolean> | boolean },
  ): Promise<void> {
    const server = await this.mcpStore.get(name);
    const started = beginGlobalMcpServerAuth(server);
    if (started.status === "already-authorized") return;
    try {
      const opened = await options.onAuthorizationUrl(started.authorizationUrl);
      if (opened === false) {
        throw new Error("MCP OAuth authorization was cancelled");
      }
      completeGlobalMcpServerAuth(started.flowId);
    } catch (error) {
      cancelGlobalMcpServerAuth(started.flowId);
      throw error;
    }
  }

  async resetMcpServerAuth(name: string): Promise<void> {
    const server = await this.mcpStore.get(name);
    if (server.transport !== "http" && server.transport !== "sse") {
      throw new Error(`MCP server "${name}" does not use a remote transport`);
    }
  }

  async testMcpServer(name: string, _options?: { cwd?: string }): Promise<McpTestResult> {
    const server = await this.mcpStore.get(name);
    return testGlobalMcpServer(server);
  }

  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    return listWorkspaceSkills(workDir);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rpc.close();
  }

  private async findSummary(sessionId: string): Promise<SessionSummary | undefined> {
    const sessions = await this.listSessions({ sessionId });
    return sessions[0];
  }

  /** Build a `NativeLlmConfig` from the engine config (mirrors the engine's
   *  `extract_native_llm` mapping: kimi/openai → `openai`, anthropic →
   *  `anthropic`, google → `google`). `None` when no usable provider exists
   *  (the engine then reports the missing-LLM error to the host). */
  private async deriveNativeLlm(requestedModel: string | undefined): Promise<NativeLlmConfig | undefined> {
    const config = await this.getConfig();
    const aliasName =
      requestedModel !== undefined && config.models?.[requestedModel] !== undefined
        ? requestedModel
        : config.defaultModel;
    if (aliasName === undefined) return undefined;
    const alias = config.models?.[aliasName];
    if (alias === undefined || alias.model === undefined) return undefined;
    const providerName = alias.provider;
    if (providerName === undefined) return undefined;
    const provider = config.providers?.[providerName];
    if (provider === undefined) return undefined;
    const apiKey = provider["apiKey"];
    if (typeof apiKey !== "string" || apiKey.length === 0) return undefined;
    const providerType = typeof provider["type"] === "string" ? provider["type"] : "";
    const protocol =
      providerType === "anthropic"
        ? "anthropic"
        : providerType === "google" || providerType === "google-genai"
          ? "google"
          : "openai";
    const baseUrl = typeof provider["baseUrl"] === "string" ? provider["baseUrl"] : undefined;
    if (baseUrl === undefined || baseUrl.length === 0) {
      // Google defaults to its public endpoint; others require an explicit URL.
      if (protocol !== "google") return undefined;
    }
    // Stable host identity on outbound provider requests (node-sdk
    // `KimiHostIdentity` parity): the engine's default UA is
    // `kimi-code-cli/<version>`; hosts that want their own product identity
    // override it via `custom_headers`.
    const identity = this.identity;
    const customHeaders =
      identity !== undefined && identity.userAgentProduct !== undefined
        ? {
            "user-agent": `${identity.userAgentProduct}/${identity.version ?? "0.0.0"}`,
          }
        : undefined;
    return {
      protocol,
      base_url: baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
      api_key: apiKey,
      model: alias.model,
      ...(customHeaders === undefined ? {} : { custom_headers: customHeaders }),
    };
  }
}

function mapSessionSummary(raw: Record<string, unknown>): SessionSummary {
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    workDir: typeof raw["work_dir"] === "string" ? raw["work_dir"] : "",
    createdAt: typeof raw["created_at"] === "number" ? raw["created_at"] : 0,
    updatedAt: typeof raw["updated_at"] === "number" ? raw["updated_at"] : 0,
    ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
    ...(typeof raw["last_prompt"] === "string" ? { lastPrompt: raw["last_prompt"] } : {}),
    ...(raw["metadata"] !== undefined && typeof raw["metadata"] === "object"
      ? { metadata: raw["metadata"] as Record<string, unknown> }
      : {}),
  };
}

/** Create a local harness over a spawned `kimi-server-serve` process. */
export function createLocalHarness(options: LocalKimiHarnessOptions = {}): LocalKimiHarness {
  return new LocalKimiHarnessImpl(options);
}
