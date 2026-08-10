/**
 * Rust engine wire shapes + host-side translation functions.
 *
 * The engine reports snake_case wire records (mirrored from
 * `@moonshot-ai/kimi-agent/rust-loop`); host consumers use the SDK's
 * camelCase shapes. This module owns every wire → SDK translation so the
 * engine-facing clients (`RustRpcClient`) stay thin. Promoted from
 * `apps/kimi-code/src/cli/native-session.ts` (2026-08-02).
 */
import type {
  McpServerInfoRpc,
  PluginInfoRpc,
  PluginSummaryRpc,
  SessionStatusResult,
  SessionSummaryRpc,
  SessionWarning,
  SkillSummaryRpc,
  TaskInfoBase,
  TokenUsage,
  UsageStatus,
} from '@moonshot-ai/kimi-agent/rpc/wire';
import type {
  BackgroundTaskInfo,
  ContextMessage,
  ContentPart,
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
} from '#/types';

// ── Engine wire shapes (single source: the generated RPC wire contract) ──
// The engine's session-level RPC results live in
// `@moonshot-ai/kimi-agent/rpc/wire` (generated from `rpc/types.rs`). These
// aliases keep the historical `Engine*` names so map*/clients stay stable.

export type EngineSessionRecord = SessionSummaryRpc;
export type EngineSessionStatus = SessionStatusResult;
export type EngineMcpServerInfo = McpServerInfoRpc;
export type EngineTaskInfo = TaskInfoBase;
export type EngineSkillSummary = SkillSummaryRpc;
export type EngineSessionWarning = SessionWarning;
export type EngineSessionUsage = UsageStatus;
export type EnginePluginSummary = PluginSummaryRpc;
export type EnginePluginInfo = PluginInfoRpc;

// ── Translation helpers ──────────────────────────────────────────────────

/** A capability the Rust engine does not back yet: fail loud, never fake. */
export function nativeUnavailable(feature: string): never {
  throw new Error(
    `${feature} is a JS-host capability and is not available under the native engine yet.`,
  );
}

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
  triple: TokenUsage | undefined,
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
