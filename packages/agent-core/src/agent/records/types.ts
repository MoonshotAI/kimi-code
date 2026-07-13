import type { ContentPart, ThinkingEffort, TokenUsage } from '@moonshot-ai/kosong';

import type { LoopRecordedEvent } from '../../loop';
import type { GoalActor, GoalBudgetLimits, GoalStatus } from '../goal';
import type { MCPToolDefinition } from '../../mcp/types';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMessage, PromptOrigin } from '../context';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { McpToolCollision, UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';
import type { SwarmModeTrigger } from '../swarm';

/** One entry of a tools table as sent in a request's top-level `tools[]`. */
export interface LlmRequestToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Agent records are the ordered event log used to rebuild agent state on resume.
// Use records, not state.json, when correctness depends on the order in which
// state transitions happened.
//
// Two record classes exist, and being persisted is not the same as being
// replayed:
//   - State records (the default): each type must have explicit state-rebuild
//     semantics in restoreAgentRecord; a write-only state record is not
//     persistence.
//   - Observability records (`llm.tools_snapshot`, `llm.request`,
//     `mcp.tools_discovered`): a durable trace of the data sent to the model,
//     for debugging and trajectory replay. They never feed state rebuild;
//     their only resume semantics is restoring the write-dedup cursors so a
//     resumed session does not re-log snapshots it already persisted.
export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  forked: {};

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  'swarm_mode.enter': {
    trigger: SwarmModeTrigger;
  };
  'swarm_mode.exit': {};

  'tools.register_user_tool': UserToolRegistration;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  'micro_compaction.apply': { cutoff: number };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };

  'tools.update_store': ToolStoreUpdate;

  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
  };
  'goal.update': {
    status?: GoalStatus;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    reason?: string;
    actor?: GoalActor;
  };
  'goal.clear': {};

  // Observability records (see the header note): request-trace data, not
  // state. Resume only restores the write-dedup cursors.

  /**
   * Content-addressed snapshot of a request's top-level `tools[]` (after the
   * `deferred` strip — exactly what the provider receives). Written once per
   * unique table; `llm.request.toolsHash` points here.
   */
  'llm.tools_snapshot': {
    hash: string;
    tools: readonly LlmRequestToolSchema[];
  };

  /**
   * One record per outbound model request (every retry attempt, strict
   * resend, and compaction round included). Together with `config.update`
   * (system prompt full text), context records (messages), and
   * `llm.tools_snapshot` (tool schemas), this makes each request
   * reconstructable from the wire log at the logical-request level.
   */
  'llm.request': {
    kind: 'loop' | 'compaction';
    provider: string;
    model: string;
    modelAlias?: string;
    /**
     * Provider-effective thinking effort — for Kimi providers this is derived
     * from the request body's thinking payload, so env overrides
     * (`KIMI_MODEL_THINKING_EFFORT`) are already reflected.
     */
    thinkingEffort?: ThinkingEffort;
    /**
     * Kimi preserved-thinking passthrough (`thinking.keep`) in effect for
     * this request — resolved from env, config, and the default, none of
     * which are otherwise recorded.
     */
    thinkingKeep?: string;
    /** Effective env-driven sampling overrides (Kimi provider only). */
    temperature?: number;
    topP?: number;
    /**
     * Effective completion-token cap the provider sends on the wire — read
     * from the effective provider, so provider-side clamping (remaining
     * context window, transport ceilings) and provider-level defaults (e.g.
     * Anthropic's required `max_tokens`) are included.
     */
    maxTokens?: number;
    betaApi?: boolean;
    /** Progressive tool disclosure in effect (env flag × model capability). */
    toolSelect: boolean;
    systemPromptHash: string;
    /**
     * Inlined only when the request's system prompt differs from the current
     * `config.update` value (no such caller today; defensive for future ones).
     */
    systemPrompt?: string;
    toolsHash: string;
    messageCount: number;
    turnStep?: string;
    attempt?: string;
    /** Set when this request is a fallback resend (strict rebuild,
     * media-degraded rebuild, or media-stripped rebuild). */
    projection?: 'strict' | 'media-degraded' | 'media-stripped';
    /** Compaction only: messages dropped so far by overflow/empty shrinking. */
    droppedCount?: number;
  };

  /**
   * Raw MCP `tools/list` result as advertised by the server, plus how this
   * agent gated it (allow-list, name collisions). Written on registration,
   * deduplicated per server by content hash.
   */
  'mcp.tools_discovered': {
    serverName: string;
    hash: string;
    tools: readonly MCPToolDefinition[];
    enabledNames: readonly string[];
    collisions?: readonly McpToolCollision[];
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
