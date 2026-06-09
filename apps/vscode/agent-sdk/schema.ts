import { z } from "zod/v3";

// ============================================================================
// Primitives
// ============================================================================

/** 审批响应类型 */
export const ApprovalResponseSchema = z.enum(["approve", "approve_for_session", "reject"]);
/**
 * 审批响应
 * - `approve`: 批准本次操作
 * - `approve_for_session`: 批准本会话中的同类操作
 * - `reject`: 拒绝操作
 */
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

/** 审批响应参数：固定响应或动态 optionId */
export type ApprovalResult = ApprovalResponse | { optionId: string };

/** ACP execution mode */
export const AgentModeSchema = z.enum(["default", "plan", "auto", "yolo"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/** 消息内容片段 */
export const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    /** 文本类型 */
    type: z.literal("text"),
    /** 文本内容 */
    text: z.string(),
  }),
  z.object({
    /** 思考类型，仅在思考模式下出现 */
    type: z.literal("think"),
    /** 思考内容 */
    think: z.string(),
    /** 加密的思考内容或签名 */
    encrypted: z.string().nullable().optional(),
  }),
  z.object({
    /** 图片类型 */
    type: z.literal("image_url"),
    image_url: z.object({
      /** 图片 URL，通常是 data URI（如 data:image/png;base64,...） */
      url: z.string(),
      /** 图片 ID，用于区分不同图片 */
      id: z.string().nullable().optional(),
    }),
  }),
  z.object({
    /** 音频类型 */
    type: z.literal("audio_url"),
    audio_url: z.object({
      /** 音频 URL，通常是 data URI（如 data:audio/aac;base64,...） */
      url: z.string(),
      /** 音频 ID，用于区分不同音频 */
      id: z.string().nullable().optional(),
    }),
  }),
  z.object({
    /** 视频类型 */
    type: z.literal("video_url"),
    video_url: z.object({
      /** 视频 URL，通常是 data URI（如 data:video/mp4;base64,...） */
      url: z.string(),
      /** 视频 ID，用于区分不同视频 */
      id: z.string().nullable().optional(),
    }),
  }),
]);
/**
 * 消息内容片段
 * - `text`: 文本内容
 * - `think`: 思考内容（思考模式）
 * - `image_url`: 图片
 * - `audio_url`: 音频
 * - `video_url`: 视频
 */
export type ContentPart = z.infer<typeof ContentPartSchema>;

/** Token 用量统计 */
export const TokenUsageSchema = z.object({
  /** 输入 token 数（非缓存） */
  input_other: z.number(),
  /** 输出 token 数 */
  output: z.number(),
  /** 从缓存读取的输入 token 数 */
  input_cache_read: z.number(),
  /** 写入缓存的输入 token 数 */
  input_cache_creation: z.number(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// ============================================================================
// DisplayBlock
// ============================================================================

/** 简短文本显示块 */
export const BriefBlockSchema = z.object({
  type: z.literal("brief"),
  /** 简短的文本内容 */
  text: z.string(),
});
export type BriefBlock = z.infer<typeof BriefBlockSchema>;

/** 文件差异显示块 */
export const DiffBlockSchema = z.object({
  type: z.literal("diff"),
  /** 文件路径 */
  path: z.string(),
  /** 原始内容 */
  old_text: z.string(),
  /** 新内容 */
  new_text: z.string(),
});
export type DiffBlock = z.infer<typeof DiffBlockSchema>;

function normalizeTodoItemStatus(status: unknown): unknown {
  if (status === undefined || status === null || status === "") {
    return "pending";
  }
  if (status === "completed" || status === "complete" || status === "finished") {
    return "done";
  }
  if (status === "active" || status === "running") {
    return "in_progress";
  }
  if (status === "todo" || status === "not_started") {
    return "pending";
  }
  return status;
}

const TodoItemStatusSchema = z.preprocess(normalizeTodoItemStatus, z.enum(["pending", "in_progress", "done"]));

function normalizeTodoItem(item: unknown): unknown {
  if (typeof item === "string") {
    return { title: item };
  }
  if (!item || typeof item !== "object") {
    return item;
  }

  const record = item as Record<string, unknown>;
  if (typeof record.title === "string") {
    return record;
  }
  const title = record.content ?? record.text ?? record.name ?? record.task;
  return typeof title === "string" ? { ...record, title } : record;
}

const TodoItemSchema = z.preprocess(
  normalizeTodoItem,
  z.object({
    /** 待办事项标题 */
    title: z.string(),
    /** 状态：pending | in_progress | done（兼容 completed/active 等状态） */
    status: TodoItemStatusSchema.optional().default("pending"),
  }),
);

/** 待办事项显示块 */
export const TodoBlockSchema = z.object({
  type: z.literal("todo"),
  /** 待办事项列表 */
  items: z.array(TodoItemSchema),
});
export type TodoBlock = z.infer<typeof TodoBlockSchema>;

/** 命令执行显示块 */
export interface CommandBlock {
  type: "command";
  language: string;
  command: string;
  cwd?: string;
  description?: string;
  danger?: string;
}

export type FileOperation = "read" | "write" | "edit" | "glob" | "grep";

/** 文件操作显示块 */
export interface FileOpBlock {
  type: "file-op";
  operation: FileOperation;
  path: string;
  detail?: string;
}

/** 文件内容显示块 */
export interface FileContentBlock {
  type: "file-content";
  path: string;
  content: string;
  language?: string;
}

/** URL 请求显示块 */
export interface UrlFetchBlock {
  type: "url-fetch";
  url: string;
  method?: string;
}

/** 搜索显示块 */
export interface SearchBlock {
  type: "search";
  query: string;
  scope?: string;
}

export type InvocationKind = "agent" | "skill";

/** Agent / Skill 调用显示块 */
export interface InvocationBlock {
  type: "invocation";
  kind: InvocationKind;
  name: string;
  description?: string;
}

/** 后台任务显示块 */
export interface BackgroundTaskBlock {
  type: "background-task";
  task_id: string;
  /** Camel-case compatibility alias accepted from older/internal display payloads. */
  taskId?: string;
  kind: string;
  status: string;
  description?: string;
}

/** 未知类型显示块（fallback） */
export interface UnknownBlock {
  /** 类型标识 */
  type: string;
  /** 原始数据 */
  data: Record<string, unknown>;
}

/**
 * 显示块联合类型
 * - `brief`: 简短文本
 * - `diff`: 文件差异
 * - `todo`: 待办事项
 * - `command` / `file-op` / `file-content` / `url-fetch` / `search` / `invocation` / `background-task`: approval 语义块
 * - 其他: UnknownBlock fallback
 */
export type DisplayBlock =
  | BriefBlock
  | DiffBlock
  | TodoBlock
  | CommandBlock
  | FileOpBlock
  | FileContentBlock
  | UrlFetchBlock
  | SearchBlock
  | InvocationBlock
  | BackgroundTaskBlock
  | UnknownBlock;

const FileOperationSchema = z.enum(["read", "write", "edit", "glob", "grep"]);
const InvocationKindSchema = z.enum(["agent", "skill"]);

/** DisplayBlock 原始解析 schema */
const RawDisplayBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    path: z.string().optional(),
    old_text: z.string().optional(),
    new_text: z.string().optional(),
    items: z.array(TodoItemSchema).optional(),
    language: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    description: z.string().optional(),
    danger: z.string().optional(),
    operation: FileOperationSchema.optional(),
    detail: z.string().optional(),
    content: z.string().optional(),
    url: z.string().optional(),
    method: z.string().optional(),
    query: z.string().optional(),
    scope: z.string().optional(),
    kind: z.string().optional(),
    name: z.string().optional(),
    task_id: z.string().optional(),
    taskId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

/** DisplayBlock schema，自动转换为强类型 */
export const DisplayBlockSchema = RawDisplayBlockSchema.transform((raw): DisplayBlock => {
  if (raw.type === "brief" && typeof raw.text === "string") {
    return { type: "brief", text: raw.text };
  }
  if (raw.type === "diff" && typeof raw.path === "string" && typeof raw.old_text === "string" && typeof raw.new_text === "string") {
    return { type: "diff", path: raw.path, old_text: raw.old_text, new_text: raw.new_text };
  }
  if (raw.type === "todo" && Array.isArray(raw.items)) {
    return { type: "todo", items: raw.items };
  }
  if (raw.type === "command" && typeof raw.command === "string") {
    return {
      type: "command",
      language: raw.language ?? "bash",
      command: raw.command,
      ...(raw.cwd !== undefined ? { cwd: raw.cwd } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(raw.danger !== undefined ? { danger: raw.danger } : {}),
    };
  }
  const fileOpDetail = raw.detail ?? raw.description;
  if (raw.type === "file-op" && raw.operation !== undefined && typeof raw.path === "string") {
    return { type: "file-op", operation: raw.operation, path: raw.path, ...(fileOpDetail !== undefined ? { detail: fileOpDetail } : {}) };
  }
  if (raw.type === "file-content" && typeof raw.path === "string" && typeof raw.content === "string") {
    return { type: "file-content", path: raw.path, content: raw.content, ...(raw.language !== undefined ? { language: raw.language } : {}) };
  }
  if (raw.type === "url-fetch" && typeof raw.url === "string") {
    return { type: "url-fetch", url: raw.url, ...(raw.method !== undefined ? { method: raw.method } : {}) };
  }
  if (raw.type === "search" && typeof raw.query === "string") {
    return { type: "search", query: raw.query, ...(raw.scope !== undefined ? { scope: raw.scope } : {}) };
  }
  if (raw.type === "invocation" && typeof raw.name === "string" && InvocationKindSchema.safeParse(raw.kind).success) {
    return { type: "invocation", kind: raw.kind as InvocationKind, name: raw.name, ...(raw.description !== undefined ? { description: raw.description } : {}) };
  }
  const taskId = raw.task_id ?? raw.taskId;
  if (raw.type === "background-task" && typeof taskId === "string") {
    return {
      type: "background-task",
      task_id: taskId,
      kind: raw.kind ?? "background",
      status: raw.status ?? "unknown",
      ...(raw.description !== undefined ? { description: raw.description } : {}),
    };
  }
  const { type, ...rest } = raw;
  return { type, data: rest };
});

// ============================================================================
// Tool Types
// ============================================================================

/** 工具调用 */
export const ToolCallSchema = z.object({
  /** 固定为 "function" */
  type: z.literal("function"),
  /** 工具调用 ID，用于关联 ToolResult */
  id: z.string(),
  function: z.object({
    /** 工具名称，如 "Shell"、"ReadFile"、"WriteFile" */
    name: z.string(),
    /** JSON 格式的参数字符串，流式时可能不完整 */
    arguments: z.string().nullable().optional(),
  }),
  /** 额外信息 */
  extras: z.record(z.unknown()).nullable().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** 工具调用参数片段（流式） */
export const ToolCallPartSchema = z.object({
  /** 对应的工具调用 ID */
  tool_call_id: z.string(),
  /** 参数片段，追加到指定 ToolCall 的 arguments */
  arguments_part: z.string().nullable().optional(),
});
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

/** 工具执行结果 */
export const ToolResultSchema = z.object({
  /** 对应的工具调用 ID */
  tool_call_id: z.string(),
  return_value: z.object({
    /** 是否为错误 */
    is_error: z.boolean(),
    /** 返回给模型的输出内容，可以是纯文本或内容片段数组 */
    output: z.union([z.string(), z.array(ContentPartSchema)]),
    /** 给模型的解释性消息 */
    message: z.string(),
    /** 显示给用户的内容块 */
    display: z.array(DisplayBlockSchema),
    /** 额外调试信息 */
    extras: z.record(z.unknown()).nullable().optional(),
  }),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ============================================================================
// Event Payloads
// ============================================================================

/** 轮次开始事件 */
export const TurnBeginSchema = z.object({
  /** 用户输入，可以是纯文本或内容片段数组 */
  user_input: z.union([z.string(), z.array(ContentPartSchema)]),
});
export type TurnBegin = z.infer<typeof TurnBeginSchema>;

/** 步骤开始事件 */
export const StepBeginSchema = z.object({
  /** 步骤编号，从 1 开始 */
  n: z.number(),
});
export type StepBegin = z.infer<typeof StepBeginSchema>;

/** 空 payload（用于 StepInterrupted, ConversationReset） */
export const EmptyPayloadSchema = z.object({});
/** 步骤被中断，无额外字段 */
export type StepInterrupted = z.infer<typeof EmptyPayloadSchema>;
/** 上下文压缩开始 */
export const CompactionBeginSchema = z.object({
  /** manual 或 auto 触发来源。 */
  trigger: z.union([z.literal("manual"), z.literal("auto")]).optional(),
  /** 可选压缩指令。 */
  instruction: z.string().optional(),
  /** 附加展示消息。 */
  message: z.string().optional(),
});
export type CompactionBegin = z.infer<typeof CompactionBeginSchema>;
/** 上下文压缩结束 */
export const CompactionEndSchema = z.object({
  /** 压缩结束状态。 */
  status: z.union([z.literal("completed"), z.literal("cancelled"), z.literal("blocked")]).optional(),
  /** manual 或 auto 触发来源。 */
  trigger: z.union([z.literal("manual"), z.literal("auto")]).optional(),
  /** 可选压缩指令。 */
  instruction: z.string().optional(),
  /** 压缩摘要。 */
  summary: z.string().optional(),
  /** 被压缩的上下文条数。 */
  compactedCount: z.number().optional(),
  /** 压缩前 token 数。 */
  tokensBefore: z.number().optional(),
  /** 压缩后 token 数。 */
  tokensAfter: z.number().optional(),
  /** 附加展示消息。 */
  message: z.string().optional(),
});
export type CompactionEnd = z.infer<typeof CompactionEndSchema>;
/** 会话上下文重置，无额外字段 */
export type ConversationReset = z.infer<typeof EmptyPayloadSchema>;

/** 状态更新事件 */
export const StatusUpdateSchema = z.object({
  /** 上下文使用率，0-1 之间的浮点数；溢出时可能大于 1 */
  context_usage: z.number().nullable().optional(),
  /** 当前上下文已使用 token 数 */
  context_tokens: z.number().nullable().optional(),
  /** 当前模型上下文窗口 token 总数 */
  max_context_tokens: z.number().nullable().optional(),
  /** 当前步骤的 token 用量统计 */
  token_usage: TokenUsageSchema.nullable().optional(),
  /** 当前步骤的消息 ID */
  message_id: z.string().nullable().optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

/** ACP 审批选项 */
export const ApprovalOptionSchema = z.object({
  /** 选项 ID，用于响应时引用 */
  optionId: z.string(),
  /** 显示名称 */
  name: z.string(),
  /** 选项类型/分类 */
  kind: z.string().optional(),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

/** 审批请求 payload */
export const ApprovalRequestPayloadSchema = z.object({
  /** 请求 ID，用于响应时引用（ACP 使用 JSON-RPC id，可能是 number 且从 0 起） */
  id: z.union([z.string(), z.number()]),
  /** 关联的工具调用 ID */
  tool_call_id: z.string(),
  /** 发起者（工具名称），如 "Shell"、"WriteFile" */
  sender: z.string(),
  /** 操作描述，如 "run shell command" */
  action: z.string(),
  /** 详细说明，如 "Run command `rm -rf /`" */
  description: z.string(),
  /** 显示给用户的内容块 */
  display: z.array(DisplayBlockSchema).optional(),
  /** ACP 动态选项（plan-review 等场景） */
  options: z.array(ApprovalOptionSchema).optional(),
});
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

/** 审批请求已解决事件 */
export const ApprovalRequestResolvedSchema = z.object({
  /** 已解决的审批请求 ID（ACP JSON-RPC id 可能是 number） */
  request_id: z.union([z.string(), z.number()]),
  /** 审批结果：固定响应或动态 optionId */
  response: z.union([ApprovalResponseSchema, z.object({ optionId: z.string() })]),
});
export type ApprovalRequestResolved = z.infer<typeof ApprovalRequestResolvedSchema>;

/** ACP plan / TodoList entry */
export const PlanEntrySchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

/** ACP plan update. Each update replaces the whole current plan. */
export const PlanSchema = z.object({
  entries: z.array(PlanEntrySchema),
});
export type Plan = z.infer<typeof PlanSchema>;

/** ACP config option as reported by session/update config_option_update. */
export const ConfigOptionSchema = z.object({}).passthrough();
export type ConfigOption = z.infer<typeof ConfigOptionSchema>;

/** ACP config option update. */
export const ConfigOptionUpdateSchema = z.object({
  configOptions: z.array(ConfigOptionSchema),
});
export type ConfigOptionUpdate = z.infer<typeof ConfigOptionUpdateSchema>;

/** ACP available command entry */
export const AvailableCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  group: z.string().optional(),
});
export type AvailableCommand = z.infer<typeof AvailableCommandSchema>;

/** ACP available commands update. */
export const AvailableCommandsUpdateSchema = z.object({
  availableCommands: z.array(AvailableCommandSchema),
});
export type AvailableCommandsUpdate = z.infer<typeof AvailableCommandsUpdateSchema>;

// ============================================================================
// Wire Events & Requests
// ============================================================================

/**
 * Legacy wire event union consumed by the VS Code webview.
 * Prefer ACP-native wire/display contracts for new cross-client semantics.
 */
export type WireEvent =
  | { type: "TurnBegin"; payload: TurnBegin }
  | { type: "StepBegin"; payload: StepBegin }
  | { type: "StepInterrupted"; payload: StepInterrupted }
  | { type: "CompactionBegin"; payload: CompactionBegin }
  | { type: "CompactionEnd"; payload: CompactionEnd }
  | { type: "ConversationReset"; payload: ConversationReset }
  | { type: "StatusUpdate"; payload: StatusUpdate }
  | { type: "ContentPart"; payload: ContentPart }
  | { type: "ToolCall"; payload: ToolCall }
  | { type: "ToolCallPart"; payload: ToolCallPart }
  | { type: "ToolResult"; payload: ToolResult }
  | { type: "SubagentEvent"; payload: SubagentEvent }
  | { type: "ApprovalRequestResolved"; payload: ApprovalRequestResolved }
  | { type: "Plan"; payload: Plan }
  | { type: "ConfigOptionUpdate"; payload: ConfigOptionUpdate }
  | { type: "AvailableCommandsUpdate"; payload: AvailableCommandsUpdate };

/** 子 Agent 事件 */
export interface SubagentEvent {
  /** 关联的 Task 工具调用 ID */
  task_tool_call_id: string;
  /** 子 Agent 产生的事件，嵌套的 Wire 消息格式，可能多层嵌套 */
  event: WireEvent;
}

/**
 * Legacy wire request union consumed by the VS Code webview.
 * New ACP request semantics should be mapped through the compatibility layer explicitly.
 */
export type WireRequest = { type: "ApprovalRequest"; payload: ApprovalRequestPayload };

/** 事件类型 -> schema 映射 */
export const EventSchemas: Record<string, z.ZodSchema> = {
  TurnBegin: TurnBeginSchema,
  StepBegin: StepBeginSchema,
  StepInterrupted: EmptyPayloadSchema,
  CompactionBegin: CompactionBeginSchema,
  CompactionEnd: CompactionEndSchema,
  ConversationReset: EmptyPayloadSchema,
  StatusUpdate: StatusUpdateSchema,
  ContentPart: ContentPartSchema,
  ToolCall: ToolCallSchema,
  ToolCallPart: ToolCallPartSchema,
  ToolResult: ToolResultSchema,
  ApprovalRequestResolved: ApprovalRequestResolvedSchema,
  Plan: PlanSchema,
  ConfigOptionUpdate: ConfigOptionUpdateSchema,
  AvailableCommandsUpdate: AvailableCommandsUpdateSchema,
};

/** 请求类型 -> schema 映射 */
export const RequestSchemas: Record<string, z.ZodSchema> = {
  ApprovalRequest: ApprovalRequestPayloadSchema,
};

/** 解析 Wire 事件（内部使用） */
function parseWireEvent(raw: { type: string; payload?: unknown }): WireEvent | null {
  const result = parseEventPayload(raw.type, raw.payload);
  return result.ok ? result.value : null;
}

/** SubagentEvent schema */
export const SubagentEventSchema = z.lazy(() =>
  z.object({
    /** 关联的 Task 工具调用 ID */
    task_tool_call_id: z.string(),
    /** 子 Agent 产生的事件 */
    event: z.object({ type: z.string(), payload: z.unknown() }).transform((raw): WireEvent => {
      const result = parseWireEvent(raw);
      if (!result) {
        return { type: "StepInterrupted", payload: {} };
      }
      return result;
    }),
  }),
);
EventSchemas.SubagentEvent = SubagentEventSchema;

// ============================================================================
// Stream Event
// ============================================================================

/** 协议解析错误 */
export interface ParseError {
  type: "error";
  /** 错误代码 */
  code: string;
  /** 错误消息 */
  message: string;
  /** 原始数据（截断至 500 字符） */
  raw?: string;
}

/**
 * Legacy stream event union returned by the VS Code SDK Turn iterator.
 * Includes legacy WireEvent, WireRequest, and parse errors.
 */
export type StreamEvent = WireEvent | WireRequest | ParseError;
export type LegacyWireEvent = WireEvent;
export type LegacyWireRequest = WireRequest;
export type LegacyStreamEvent = StreamEvent;

// ============================================================================
// Run Result
// ============================================================================

/** 轮次运行结果 */
export const RunResultSchema = z.object({
  /**
   * 完成状态
   * - `finished`: 轮次正常完成
   * - `cancelled`: 轮次被 cancel 取消
   * - `max_steps_reached`: 达到最大步数限制
   */
  status: z.enum(["finished", "cancelled", "max_steps_reached"]),
  /** 当 status 为 max_steps_reached 时，返回已执行的步数 */
  steps: z.number().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

// ============================================================================
// RPC Messages
// ============================================================================

/** RPC 错误 */
export const RpcErrorSchema = z.object({
  /** 错误代码 */
  code: z.number(),
  /** 错误消息 */
  message: z.string(),
  /** 额外数据 */
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/** RPC 消息（请求、通知或响应） */
export const RpcMessageSchema = z.object({
  jsonrpc: z.string().optional(),
  /** JSON-RPC id：ACP 的请求/响应 id 可能是 string 或 number（含 0） */
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: RpcErrorSchema.optional(),
});
export type RpcMessage = z.infer<typeof RpcMessageSchema>;

// ============================================================================
// Config Types
// ============================================================================

/** 模型配置 */
export interface ModelConfig {
  /** 模型 ID，用于 API 调用 */
  id: string;
  /** 模型显示名称 */
  name: string;
  /** 模型能力列表，如 ["thinking", "image_in", "video_in"] */
  capabilities: string[];
}

/** Kimi 配置 */
export interface KimiConfig {
  /** 默认模型 ID */
  defaultModel: string | null;
  /** 默认思考模式 */
  defaultThinking: boolean;
  /** 可用模型列表 */
  models: ModelConfig[];
}

/** MCP 服务器配置 */
export interface MCPServerConfig {
  /** 服务器名称，用于标识 */
  name: string;
  /** 传输方式 */
  transport: "http" | "stdio";
  /** HTTP 传输时的服务器 URL */
  url?: string;
  /** stdio 传输时的启动命令 */
  command?: string;
  /** stdio 传输时的命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** HTTP 请求头 */
  headers?: Record<string, string>;
  /** 认证方式，目前仅支持 "oauth" */
  auth?: "oauth";
}

// ============================================================================
// Session Types
// ============================================================================

/** 会话选项 */
export interface SessionOptions {
  /** 工作目录路径，必填 */
  workDir: string;
  /** 会话 ID，不提供则自动生成 UUID */
  sessionId?: string;
  /** 模型 ID */
  model?: string;
  /** 是否启用思考模式，默认 false */
  thinking?: boolean;
  /** ACP execution mode，默认 "default" */
  mode?: AgentMode;
  /** 是否自动批准所有操作，默认 false */
  yoloMode?: boolean;
  /** CLI 可执行文件路径，默认 "kimi" */
  executable?: string;
  /** 传递给 CLI 的环境变量 */
  env?: Record<string, string>;
}

/** 会话信息 */
export interface SessionInfo {
  /** 会话 ID */
  id: string;
  /** 工作目录 */
  workDir: string;
  /** 上下文文件路径 */
  contextFile: string;
  /** 最后更新时间戳（毫秒） */
  updatedAt: number;
  /** 第一条用户消息的摘要 */
  brief: string;
}

// ============================================================================
// Context Record (for history parsing)
// ============================================================================

/** 上下文记录（用于解析历史） */
export const ContextRecordSchema = z.object({
  role: z.string().optional(),
  content: z.unknown().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().optional(),
        function: z
          .object({
            name: z.string().optional(),
            arguments: z.union([z.string(), z.record(z.unknown())]).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});
export type ContextRecord = z.infer<typeof ContextRecordSchema>;

// ============================================================================
// Parse Helpers
// ============================================================================

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** 解析事件 payload */
export function parseEventPayload(type: string, payload: unknown): Result<WireEvent> {
  const schema = EventSchemas[type];
  if (!schema) {
    return { ok: false, error: `Unknown event type: ${type}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: `Invalid payload for ${type}: ${result.error.message}` };
  }
  return { ok: true, value: { type, payload: result.data } as WireEvent };
}

/** 解析请求 payload */
export function parseRequestPayload(type: string, payload: unknown): Result<WireRequest> {
  const schema = RequestSchemas[type];
  if (!schema) {
    return { ok: false, error: `Unknown request type: ${type}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: `Invalid payload for ${type}: ${result.error.message}` };
  }
  return { ok: true, value: { type, payload: result.data } as WireRequest };
}
