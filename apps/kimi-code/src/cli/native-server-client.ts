/**
 * native-server-client.ts — the thin transport layer between the TS host and
 * `kimi-server-serve` (stdio JSON-RPC).
 *
 * Why this exists (and why it is thin): the Rust engine owns the turn loop
 * natively (native LLM transport, native toolset, approval store) — the host
 * only issues pull-style RPCs (`session/create`, `session/prompt`,
 * `session/approval_resolve`) and consumes engine events. The wire protocol
 * is one JSON-RPC request per line on stdin/stdout (responses correlated by
 * id, dispatched concurrently server-side) plus `[event] {json}` lines on
 * stderr — the same shapes `kimi-server-client`'s `StdioClient` and
 * `kimi-ui::EventSource::Lines` speak. This module mirrors those two Rust
 * pieces for the TS host and carries **no protocol logic** beyond frame
 * codec + event-line parsing + a generic `call(method, params)`; it dies
 * with the TS host (G-6).
 *
 * The wire types and `map*` translation helpers were localized from
 * `node-sdk/src/rust/wire.ts` (2026-08-09, G-1 `/rust` consumption rewrite):
 * hosts shape adapter signatures against them unchanged.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  BackgroundTaskInfo,
  ContentPart,
  ContextMessage,
  CronTaskSnapshot,
  McpServerInfo,
  McpStartupMetrics,
  PluginInfo,
  PluginSummary,
  PromptOrigin,
  SessionStatus,
  SessionUsage,
  SkillSummary,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';

// ── Engine wire shapes (localized mirror of the generated RPC wire
//    contract; serde snake_case) ─────────────────────────────────────────

export interface EngineSessionRecord {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  work_dir: string;
}

export interface EngineSessionStatus {
  model?: string | undefined;
  thinking_effort: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  goal_enabled: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
  usage?: EngineSessionUsage | undefined;
}

export interface EngineTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface EngineSessionUsage {
  by_model?: Record<string, EngineTokenUsage> | undefined;
  total?: EngineTokenUsage | undefined;
  current_turn?: EngineTokenUsage | undefined;
}

export interface EngineMcpServerInfo {
  name: string;
  transport: string;
  status: string;
  tool_count: number;
  error?: string | undefined;
}

export interface EngineSkillSummary {
  name: string;
  description: string;
  skill_type: string;
  source?: string | undefined;
  path?: string | undefined;
  dir?: string | undefined;
}

export interface EngineSessionWarning {
  code: string;
  message: string;
  severity: string;
}

export interface EnginePluginSummary {
  id: string;
  display_name: string;
  version: string;
  enabled: boolean;
  state: string;
  skill_count: number;
  mcp_server_count: number;
  enabled_mcp_server_count: number;
  hook_count: number;
  command_count: number;
  has_errors: boolean;
  source: string;
}

export interface EnginePluginMcpServerInfo {
  name: string;
  runtime_name: string;
  enabled: boolean;
  transport: string;
  command?: string | undefined;
  url?: string | undefined;
}

export interface EnginePluginInfo extends EnginePluginSummary {
  root: string;
  installed_at: string;
  mcp_servers: Array<EnginePluginMcpServerInfo>;
  diagnostics: Array<unknown>;
}

// ── Host-resolved session-create inputs (localized from rust-loop; the
//    engine wire wants snake_case, so each input has a `to*Wire` mapper) ──

/** A host-resolved MCP server definition for the session. The host reads
 *  config + secrets (e.g. the bearer token from its env var) and hands the
 *  engine a flat spec; the engine connects it into the session's runtime. */
export interface McpServerInput {
  name: string;
  /** 'stdio' | 'sse' | 'http'. Inferred from command/url when omitted. */
  transport?: 'stdio' | 'sse' | 'http';
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  enabledTools?: string[];
  disabledTools?: string[];
  /** Remote: pre-resolved static bearer token. */
  bearerToken?: string;
  bearerTokenEnvVar?: string;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  hasHeaders?: boolean;
  /** From an untrusted `<repoRoot>/.mcp.json` (held for approval). */
  projectRoot?: boolean;
}

/** Map the camelCase host spec onto the engine's snake_case wire shape. */
export function toMcpServerWire(s: McpServerInput): Record<string, unknown> {
  return {
    name: s.name,
    transport: s.transport,
    enabled: s.enabled,
    command: s.command,
    args: s.args ?? [],
    env: s.env,
    cwd: s.cwd,
    url: s.url,
    enabled_tools: s.enabledTools,
    disabled_tools: s.disabledTools,
    bearer_token: s.bearerToken,
    bearer_token_env_var: s.bearerTokenEnvVar,
    startup_timeout_ms: s.startupTimeoutMs,
    tool_timeout_ms: s.toolTimeoutMs,
    has_headers: s.hasHeaders,
    project_root: s.projectRoot,
  };
}

/** A host-resolved external lifecycle hook (config `[[hooks]]` + plugin
 *  contributions). The engine executes these natively. */
export interface HookDefInput {
  /** Lifecycle event name, e.g. 'PreToolUse' (TS `HookEventType`). */
  event: string;
  /** Optional regex matched against the tool name / prompt text. */
  matcher?: string;
  /** Shell command; receives the snake_case JSON payload on stdin. */
  command: string;
  /** Timeout in seconds (engine default 30, cap 600). */
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/** Hook wire shape — field names already match the engine's serde form. */
export function toHookWire(h: HookDefInput): Record<string, unknown> {
  return {
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeout: h.timeout,
    cwd: h.cwd,
    env: h.env,
  };
}

/** The native LLM transport definition (wire shape; `kimi-cli` resolves it
 *  from the config). */
export interface NativeLlmDef {
  protocol: 'openai' | 'anthropic' | 'google';
  base_url: string;
  api_key: string;
  model: string;
  max_tokens?: number;
}

/** `session/create` input (camelCase host shape; mapped to the wire inside
 *  {@link NativeServerClient.sessionCreate}). */
export interface SessionCreateOptions {
  sessionId?: string;
  homedir?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  /** Host-resolved max context tokens for the session model (drives the
   *  engine's compaction window and import-overflow guard). */
  maxContextSize?: number;
  goalEnabled?: boolean;
  nativeLlm?: NativeLlmDef;
  /** MCP servers to register into the session's runtime (engine-native). */
  mcpServers?: McpServerInput[];
  /** External lifecycle hooks the engine executes natively. */
  hooks?: HookDefInput[];
}

/** Locate the `kimi-server-serve` binary. Candidates (newest mtime wins):
 *  `KIMI_SERVER_BIN` explicit override, then `target/{debug,release}/`
 *  walking up from cwd (repo/dev layout), then the packaged `bin/` next to
 *  this module (release layout). Returns null when nothing exists — callers
 *  fall back to the harness, so this never hard-breaks a run. */
export function findServerBinary(): string | null {
  const explicit = process.env['KIMI_SERVER_BIN'];
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates: string[] = [];
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(join(dir, 'target', 'debug', `kimi-server-serve${exe}`));
    candidates.push(join(dir, 'target', 'release', `kimi-server-serve${exe}`));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(
    join(import.meta.dirname, '..', 'bin', `kimi-server-serve${exe}`),
  );
  const found = candidates.filter((c) => existsSync(c));
  if (found.length === 0) return null;
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface NativeServerClientOptions {
  /** Binary path; defaults to `findServerBinary()` (throws when absent). */
  bin?: string;
}

/**
 * The client surface an adapter/host depends on (structural, so tests can
 * inject a fake). `NativeServerClient` satisfies it by construction.
 */
export interface NativeServerClientLike {
  call(method: string, params?: unknown): Promise<unknown>;
  sessionCreate(options: SessionCreateOptions): Promise<{ session_id: string }>;
  sessionPrompt(
    sessionId: string,
    input: unknown,
    agentId?: string,
  ): Promise<unknown>;
  sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null>;
  approvalList(sessionId?: string): Promise<unknown[]>;
  approvalResolve(approvalId: string, allow: boolean, reason?: string): Promise<boolean>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  onSessionEvent(
    sessionId: string,
    listener: (event: Record<string, unknown>) => void,
  ): () => void;
  close(): void;
}

/**
 * A stdio JSON-RPC client for `kimi-server-serve`.
 *
 * - `call(method, params)`: one line out, correlated by id; responses arrive
 *   concurrently (server dispatches per line), pending calls resolve as they
 *   land. EOF / process exit fails every in-flight call (aligns with
 *   `StdioClient::spawn_reader`).
 * - Events: stderr `[event] {json}` lines are parsed and fanned out to
 *   subscribers; `onSessionEvent(sessionId, …)` filters by `session_id`
 *   (engine events carry it, stamped by the engine; approval requests are
 *   routed the same way).
 * - `close()` terminates the child and rejects pending calls.
 */
export class NativeServerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
  private nextId = 1;
  private closed = false;

  constructor(options: NativeServerClientOptions = {}) {
    const bin = options.bin ?? findServerBinary();
    if (bin === null) {
      throw new Error(
        'kimi-server-serve binary not found (set KIMI_SERVER_BIN or build target/debug/kimi-server-serve)',
      );
    }
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    const stdout = this.child.stdout;
    if (stdout !== null) {
      const lines = createInterface({ input: stdout });
      lines.on('line', (line) => {
        this.dispatchResponse(line);
      });
    }
    const stderr = this.child.stderr;
    if (stderr !== null) {
      const lines = createInterface({ input: stderr });
      lines.on('line', (line) => {
        this.dispatchEvent(line);
      });
    }
    this.child.on('error', (err) => {
      this.failPending(new Error(`kimi-server-serve failed to start: ${err.message}`));
    });
    this.child.on('exit', (code) => {
      this.failPending(
        new Error(`kimi-server-serve exited (code ${String(code)}) while a call was pending`),
      );
    });
  }

  /** One JSON-RPC call; resolves the `result`, rejects on an error envelope
   *  or when the transport dies. */
  async call(method: string, params: unknown = null): Promise<unknown> {
    if (this.closed) {
      throw new Error('kimi-server-serve client is closed');
    }
    const id = this.nextId++;
    const body = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    const stdin = this.child.stdin;
    if (stdin === null) {
      throw new Error('kimi-server-serve stdin is not available');
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(body, (err) => {
        if (err !== null && err !== undefined) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Subscribe to every engine event line; returns an unsubscribe function.
   *  Events arrive as the raw wire object (`type` discriminates). */
  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to engine events for one session id (wire `session_id` must
   *  match exactly; events without a session id are not delivered). */
  onSessionEvent(
    sessionId: string,
    listener: (event: Record<string, unknown>) => void,
  ): () => void {
    return this.onEvent((event) => {
      if (event['session_id'] === sessionId) {
        listener(event);
      }
    });
  }

  /** Terminate the server process; in-flight calls reject. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
  }

  // ── High-frequency typed calls (the rest go through `call`) ────────────

  /** Create a session + agent; resolves the engine-assigned session id. */
  async sessionCreate(options: SessionCreateOptions): Promise<{ session_id: string }> {
    const result = (await this.call('session/create', {
      session_id: options.sessionId ?? null,
      homedir: options.homedir ?? null,
      system_prompt: options.systemPrompt ?? null,
      provider: options.provider ?? null,
      model: options.model ?? null,
      max_context_size: options.maxContextSize ?? null,
      goal_enabled: options.goalEnabled ?? null,
      native_llm: options.nativeLlm ?? null,
      mcp_servers: (options.mcpServers ?? []).map(toMcpServerWire),
      hooks: (options.hooks ?? []).map(toHookWire),
    })) as { session_id: string };
    return result;
  }

  /** Run one prompt turn (blocks until the turn ends; events stream in via
   *  the stderr channel while it runs). */
  async sessionPrompt(
    sessionId: string,
    input: unknown,
    agentId?: string,
  ): Promise<unknown> {
    return this.call('session/prompt', { session_id: sessionId, input, agent_id: agentId ?? null });
  }

  /** Cancel the running turn. */
  async sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null> {
    return (await this.call('session/cancel', { session_id: sessionId })) as {
      cancelled: boolean;
    } | null;
  }

  /** Pending tool approvals for a session scope. */
  async approvalList(sessionId?: string): Promise<unknown[]> {
    const result = (await this.call('session/approval_list', {
      session_id: sessionId ?? null,
    })) as { pending: unknown[] };
    return result.pending;
  }

  /** Feed a decision into the waiting tool call. */
  async approvalResolve(
    approvalId: string,
    allow: boolean,
    reason?: string,
  ): Promise<boolean> {
    const result = (await this.call('session/approval_resolve', {
      id: approvalId,
      decision: allow ? 'allow' : 'deny',
      reason: reason ?? null,
    })) as { resolved: boolean };
    return result.resolved;
  }

  private dispatchResponse(line: string): void {
    let body: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      body = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } };
    } catch {
      return; // non-JSON diagnostic line — ignore (mirrors StdioClient)
    }
    const id = typeof body.id === 'number' ? body.id : undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (body.error !== undefined) {
      pending.reject(new Error(body.error.message ?? `RPC error for call ${String(id)}`));
      return;
    }
    pending.resolve(body.result);
  }

  private dispatchEvent(line: string): void {
    if (!line.startsWith('[event] ')) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice('[event] '.length));
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Ignore a misbehaving subscriber; keep delivering.
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// ── Wire → SDK translation helpers (localized from node-sdk/rust/wire.ts;
//    the engine reports snake_case, hosts consume the SDK's camelCase) ─────

/** Extract the plain text of a prompt input; multimodal parts degrade to text. */
export function promptText(input: string | readonly { type: string; text?: string }[]): string {
  if (typeof input === 'string') return input;
  return input
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/** The engine tracks a single input total and no cache split; map it onto the
 *  SDK's four-way shape with the cache lanes zeroed (documented approximation
 *  until the engine reports cache-read / cache-creation separately). */
function mapTokenUsage(
  triple: EngineTokenUsage | undefined,
):
  | { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }
  | undefined {
  if (triple === undefined) return undefined;
  return {
    inputOther: triple.input_tokens ?? 0,
    output: triple.output_tokens ?? 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
}

export function mapUsage(raw: unknown): SessionUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const u = raw as EngineSessionUsage;
  const byModel =
    u.by_model === undefined
      ? undefined
      : Object.fromEntries(Object.entries(u.by_model).map(([model, triple]) => [model, mapTokenUsage(triple)!]));
  return {
    byModel,
    total: mapTokenUsage(u.total),
    currentTurn: mapTokenUsage(u.current_turn),
  };
}

export function mapStatus(e: EngineSessionStatus): SessionStatus {
  return {
    model: e.model ?? undefined,
    thinkingEffort: e.thinking_effort,
    permission: e.permission as SessionStatus['permission'],
    planMode: e.plan_mode,
    swarmMode: e.swarm_mode,
    contextTokens: e.context_tokens,
    maxContextTokens: e.max_context_tokens,
    contextUsage: e.context_usage,
    usage: mapUsage(e.usage),
  };
}

const SKILL_SOURCES = new Set(['builtin', 'user', 'extra', 'project']);

export function mapSkill(s: EngineSkillSummary): SkillSummary {
  const source = SKILL_SOURCES.has(s.source ?? '')
    ? (s.source as SkillSummary['source'])
    : 'user';
  return {
    name: s.name,
    description: s.description,
    path: s.path ?? '',
    source,
    type: s.skill_type,
  };
}

const NATIVE_ENGINE_TRANSPORTS = new Set(['stdio', 'http', 'sse']);
const MCP_STATUSES = new Set(['pending', 'connected', 'failed', 'disabled', 'needs-auth']);

export function mapMcpServer(m: EngineMcpServerInfo): McpServerInfo {
  // The engine's `pending-approval` has no SDK counterpart; fold it into
  // `pending`. Any other unexpected value also degrades to `pending`.
  const status = MCP_STATUSES.has(m.status)
    ? (m.status as McpServerInfo['status'])
    : 'pending';
  const transport = NATIVE_ENGINE_TRANSPORTS.has(m.transport) ? m.transport : 'stdio';
  return {
    name: m.name,
    transport: transport as McpServerInfo['transport'],
    status,
    toolCount: m.tool_count,
    error: m.error ?? undefined,
  };
}

/** Map an engine tool-call (arguments is a JSON value) onto the SDK `ToolCall`
 *  (arguments is a JSON string). */
export function mapToolCall(raw: unknown): ToolCall {
  const r = (raw ?? {}) as Record<string, unknown>;
  const args = r['arguments'];
  return {
    type: typeof r['type'] === 'string' ? (r['type'] as string) : 'function',
    id: typeof r['id'] === 'string' ? (r['id'] as string) : '',
    name: typeof r['name'] === 'string' ? (r['name'] as string) : '',
    arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
  } as ToolCall;
}

/** Map an engine context message (serde snake_case) onto the SDK `ContextMessage`
 *  (camelCase). ContentPart type tags and origin `kind` are identical on both
 *  sides, so those pass through; only the top-level keys are renamed. */
export function mapContextMessage(raw: Record<string, unknown>): ContextMessage {
  const toolCalls = Array.isArray(raw['tool_calls'])
    ? (raw['tool_calls'] as unknown[]).map(mapToolCall)
    : [];
  return {
    role: typeof raw['role'] === 'string' ? (raw['role'] as string) : 'user',
    content: (Array.isArray(raw['content']) ? raw['content'] : []) as ContentPart[],
    toolCalls,
    toolCallId: typeof raw['tool_call_id'] === 'string' ? (raw['tool_call_id'] as string) : undefined,
    origin: raw['origin'] as PromptOrigin | undefined,
    isError: typeof raw['is_error'] === 'boolean' ? (raw['is_error'] as boolean) : undefined,
    partial: typeof raw['partial'] === 'boolean' ? (raw['partial'] as boolean) : undefined,
    name: typeof raw['name'] === 'string' ? (raw['name'] as string) : undefined,
  } as ContextMessage;
}

/** Map an engine background-task wire record (untagged union with a nested
 *  `base` object) onto the flat SDK `BackgroundTaskInfo` union. Status/kind
 *  strings are identical on both sides, so they pass through. */
export function mapBackgroundTask(raw: unknown): BackgroundTaskInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const base = (r['base'] ?? {}) as Record<string, unknown>;
  const common = {
    taskId: typeof base['task_id'] === 'string' ? (base['task_id'] as string) : '',
    description: typeof base['description'] === 'string' ? (base['description'] as string) : '',
    status: base['status'],
    detached: typeof base['detached'] === 'boolean' ? (base['detached'] as boolean) : undefined,
    startedAt: typeof base['started_at'] === 'number' ? (base['started_at'] as number) : 0,
    endedAt: typeof base['ended_at'] === 'number' ? (base['ended_at'] as number) : null,
    stopReason: typeof base['stop_reason'] === 'string' ? (base['stop_reason'] as string) : undefined,
  };
  const kind = r['kind'];
  if (kind === 'agent') {
    return {
      ...common,
      kind: 'agent',
      agentId: typeof r['agent_id'] === 'string' ? (r['agent_id'] as string) : undefined,
      subagentType: typeof r['subagent_type'] === 'string' ? (r['subagent_type'] as string) : undefined,
    } as unknown as BackgroundTaskInfo;
  }
  if (kind === 'question') {
    return {
      ...common,
      kind: 'question',
      questionCount: typeof r['question_count'] === 'number' ? (r['question_count'] as number) : 0,
      toolCallId: typeof r['tool_call_id'] === 'string' ? (r['tool_call_id'] as string) : undefined,
    } as unknown as BackgroundTaskInfo;
  }
  return {
    ...common,
    kind: 'process',
    command: typeof r['command'] === 'string' ? (r['command'] as string) : '',
    pid: typeof r['pid'] === 'number' ? (r['pid'] as number) : 0,
    exitCode: typeof r['exit_code'] === 'number' ? (r['exit_code'] as number) : null,
  } as BackgroundTaskInfo;
}

/** Map an engine plugin summary wire record onto the SDK `PluginSummary`. */
export function mapPluginSummary(w: EnginePluginSummary): PluginSummary {
  return {
    id: w.id,
    displayName: w.display_name,
    version: w.version,
    enabled: w.enabled,
    state: w.state as PluginSummary['state'],
    skillCount: w.skill_count,
    mcpServerCount: w.mcp_server_count,
    enabledMcpServerCount: w.enabled_mcp_server_count,
    hookCount: w.hook_count,
    commandCount: w.command_count,
    hasErrors: w.has_errors,
    source: w.source as PluginSummary['source'],
  };
}

/** Map an engine plugin detail wire record onto the SDK `PluginInfo`. */
export function mapPluginInfo(w: EnginePluginInfo): PluginInfo {
  type McpInfo = PluginInfo['mcpServers'][number];
  type Diag = PluginInfo['diagnostics'][number];
  return {
    ...mapPluginSummary(w),
    root: w.root,
    installedAt: w.installed_at,
    mcpServers: w.mcp_servers.map(
      (m): McpInfo => ({
        name: m.name,
        runtimeName: m.runtime_name,
        enabled: m.enabled,
        transport: m.transport as McpInfo['transport'],
        command: m.command ?? undefined,
        url: m.url ?? undefined,
      }),
    ),
    diagnostics: w.diagnostics.map(
      (raw): Diag => {
        const d = raw as { severity: string; message: string };
        return { severity: d.severity as Diag['severity'], message: d.message };
      },
    ),
  };
}

/** Map an engine cron-task wire record (`CronTaskSnapshotRpc`) onto the SDK
 *  `CronTaskSnapshot` (created_at → createdAt, …). */
export function mapCronTaskSnapshot(raw: unknown): CronTaskSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof r['id'] === 'string' ? (r['id'] as string) : '',
    cron: typeof r['cron'] === 'string' ? (r['cron'] as string) : '',
    recurring: r['recurring'] === true,
    createdAt: typeof r['created_at'] === 'number' ? (r['created_at'] as number) : 0,
    lastFiredAt: typeof r['last_fired_at'] === 'number' ? (r['last_fired_at'] as number) : undefined,
    nextFireAt: typeof r['next_fire_at'] === 'number' ? (r['next_fire_at'] as number) : null,
  };
}

/** Map the engine mcp startup-metrics wire record onto `McpStartupMetrics`
 *  (duration_ms → durationMs). */
export function mapMcpStartupMetrics(raw: unknown): McpStartupMetrics {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    durationMs: typeof r['duration_ms'] === 'number' ? (r['duration_ms'] as number) : 0,
  };
}
