/**
 * Local SDK surface types — minimal definitions matching what the extension
 * actually consumes, replacing the `@moonshot-ai/kimi-code-sdk` import (G-1
 * vscode localization). The engine emits snake_case wire events; the
 * `sessionId`/`agentId` routing fields are stamped by the local client
 * (same rule as the node-sdk `dispatchEngineEvent`).
 */

/** One engine event (`session.*` / `llm.*` wire shape + routing fields).
 *  Common wire fields are declared so hosts can dot-access them under
 *  `noPropertyAccessFromIndexSignature`. */
export interface EngineEvent {
  readonly type: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turn_id?: number;
  readonly stop_reason?: string;
  readonly code?: string;
  readonly message?: string;
  readonly details?: unknown;
  readonly part?: {
    readonly type?: string;
    readonly text?: string;
    readonly think?: string;
    readonly [key: string]: unknown;
  };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly [key: string]: unknown;
  };
  readonly tool_call_id?: string;
  readonly tool_name?: string;
  readonly arguments?: unknown;
  readonly is_error?: boolean;
  readonly content?: string;
  readonly [key: string]: unknown;
}

/** A prompt content part (the engine's context wire shape, camelCase). */
export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "think"; readonly think: string; readonly encrypted?: unknown }
  | { readonly type: "image_url"; readonly imageUrl: { readonly url: string; readonly id?: string } }
  | { readonly type: "audio_url"; readonly audioUrl: { readonly url: string; readonly id?: string } }
  | { readonly type: "video_url"; readonly videoUrl: { readonly url: string; readonly id?: string } }
  | { readonly type: "encrypted"; readonly encrypted?: unknown };

/** Prompt input accepted by `Session.prompt` / `Session.steer`. */
export type PromptInput = readonly ContentPart[] | string;

/** A persisted session summary (engine `session/list` record). */
export interface SessionSummary {
  readonly id: string;
  readonly workDir: string;
  readonly metadata?: Record<string, unknown>;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastPrompt?: string;
  readonly additionalDirs?: readonly string[];
  readonly [key: string]: unknown;
}

/** A skill bundle discovered for a workspace (node-sdk `SkillSummary`). */
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: "project" | "user";
  readonly path: string;
  readonly type?: string;
  readonly disableModelInvocation?: boolean;
}

/** One user-global MCP server entry (`mcp.json` `mcpServers.<name>`). */
export interface McpServerConfig {
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly [key: string]: unknown;
}

/** Result of the host-side stdio probe (`testMcpServer`). */
export interface McpTestResult {
  readonly success: boolean;
  readonly output: string;
}

/** The harness auth facade surface the extension uses. */
export interface KimiAuthFacade {
  status(): Promise<{ providers: readonly { hasToken: boolean }[] }>;
  login(
    providerName?: string,
    options?: {
      baseUrl?: string;
      onDeviceCode?: (authorization: {
        verificationUri: string;
        verificationUriComplete?: string;
      }) => Promise<void> | void;
    },
  ): Promise<unknown>;
  logout(): Promise<unknown>;
}

// ── Additional consumed types (minimal, node-sdk shapes) ───────────────────

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type PermissionMode = "yolo" | "manual" | "auto";

/** A tool call in a context message (engine wire → camelCase). */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments?: string | null;
}

/** Message origin (engine `origin` → `{ kind, trigger?, phase? }`). */
export interface PromptOrigin {
  readonly kind: string;
  readonly trigger?: string;
  readonly phase?: string;
  readonly skillArgs?: string;
  readonly skillName?: string;
  readonly commandArgs?: string;
  readonly pluginId?: string;
  readonly commandName?: string;
  readonly variant?: string;
  readonly activationId?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

/** One context message (the engine `session/get_context` history entry). */
export interface ContextMessage {
  /** Engine wire role; hosts compare against `"user"` / `"assistant"` /
   *  `"tool"` but the engine may emit other values. */
  readonly role: string;
  readonly content: readonly ContentPart[];
  readonly toolCalls: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly origin?: PromptOrigin;
  readonly isError?: boolean;
  readonly partial?: boolean;
  readonly name?: string;
  readonly toolCallDisplays?: Record<string, unknown>;
}

/** A host tool-input display (legacy wire `ToolInputDisplay`, loose). */
export interface ToolInputDisplay {
  readonly kind: string;
  readonly command?: string;
  readonly operation?: string;
  readonly path?: string;
  readonly query?: string;
  readonly url?: string;
  readonly prompt?: string;
  readonly args?: string;
  readonly skill_name?: string;
  readonly description?: string;
  readonly task_description?: string;
  readonly plan?: string;
  readonly objective?: string;
  readonly summary?: string;
  readonly language?: string;
  readonly before?: string;
  readonly after?: string;
  readonly content?: string;
  readonly items?: readonly { readonly title?: string; readonly status?: string }[];
  readonly [key: string]: unknown;
}

export type ApprovalDecision = "approved" | "rejected" | "cancelled";

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: string;
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface ApprovalRequest {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly {
    readonly question: string;
    readonly header?: string;
    readonly body?: string;
    readonly multiSelect?: boolean;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
  }[];
}

export type QuestionResult =
  | null
  | Record<string, string | true>
  | { readonly answers: Record<string, string | true>; readonly method?: string };

/** One replay record (`type: "message"` + mapped context message). */
export interface AgentReplayRecord {
  readonly type: string;
  readonly message?: ContextMessage;
  readonly time?: number;
  readonly enabled?: boolean;
  readonly result?: unknown;
  readonly instruction?: string;
  readonly [key: string]: unknown;
}

/** A resumed agent snapshot (hosts read `replay` / `config` / `plan`). */
export interface ResumedAgentState {
  readonly replay?: readonly AgentReplayRecord[];
  readonly config: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly modelCapabilities?: {
      readonly max_context_tokens?: number;
      readonly image_in?: boolean;
      readonly video_in?: boolean;
      readonly audio_in?: boolean;
      readonly thinking?: boolean;
      readonly tool_use?: boolean;
    };
    readonly [key: string]: unknown;
  };
  readonly plan?: unknown;
  readonly usage?: {
    readonly total?: {
      readonly inputOther: number;
      readonly output: number;
      readonly inputCacheRead: number;
      readonly inputCacheCreation: number;
    };
    readonly byModel?: Record<
      string,
      {
        readonly inputOther: number;
        readonly output: number;
        readonly inputCacheRead: number;
        readonly inputCacheCreation: number;
      }
    >;
    readonly currentTurn?: {
      readonly inputOther: number;
      readonly output: number;
      readonly inputCacheRead: number;
      readonly inputCacheCreation: number;
    };
    readonly [key: string]: unknown;
  };
  readonly context?: { readonly tokenCount?: number; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** The resumed session state the replay adapter reads. */
export interface ResumedSessionState {
  readonly agents: Record<string, ResumedAgentState>;
  readonly sessionMetadata: {
    readonly agents: Record<
      string,
      { readonly parentAgentId?: string | null; readonly [key: string]: unknown }
    >;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/** Model alias config record (explicit fields the hosts read). */
export interface ModelAlias {
  readonly displayName?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly capabilities?: readonly string[];
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly maxInputSize?: number;
  readonly maxContextSize?: number;
  readonly overrides?: Partial<ModelAlias>;
  readonly [key: string]: unknown;
}

/** The engine `config/get` result (camelCase KimiConfig; explicit fields
 *  for the ones hosts touch — `noPropertyAccessFromIndexSignature` requires
 *  declared fields for dot access). */
export interface KimiConfig {
  readonly models?: Record<string, ModelAlias>;
  readonly defaultModel?: string;
  readonly thinking?: { readonly enabled?: boolean; readonly effort?: string };
  readonly providers?: Record<string, Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** A session status snapshot (`session/get_status` result, explicit fields). */
export interface SessionStatus {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly planMode?: boolean;
  readonly permission?: string;
  readonly additionalDirs?: readonly string[];
  readonly [key: string]: unknown;
}

/** Thinking effort setting. */
export type ThinkingEffort = string;
