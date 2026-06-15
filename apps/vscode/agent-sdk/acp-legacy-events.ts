/**
 * ACP → VS Code legacy StreamEvent compatibility layer.
 *
 * This module intentionally translates ACP `session/update` notifications and
 * `session/request_permission` requests into the legacy event shape consumed by
 * the VS Code webview. It is not the long-term public agent event contract.
 */
import type {
  ContentBlock as AcpProtocolContentBlock,
  KimiCompactionNotification,
  KimiNestedDisplayEvent,
  KimiStepInterruptedNotification,
  KimiSubagentNotification,
  RequestPermissionRequest as AcpProtocolPermissionRequest,
  SessionNotification as AcpProtocolSessionNotification,
  SessionUpdate as AcpProtocolSessionUpdate,
  ToolCallContent as AcpProtocolToolCallContent,
} from "@moonshot-ai/acp-adapter/protocol";
import { cleanSystemTags } from "./utils";
import type { AgentMode, CompactionBegin, CompactionEnd, DisplayBlock, StreamEvent, TodoBlock, WireEvent } from "./schema";

type UnknownAcpSessionUpdate = { sessionUpdate: string; [key: string]: unknown };
type AcpPermissionToolCall = NonNullable<AcpProtocolPermissionRequest["toolCall"]>;
type AcpPermissionOption = AcpProtocolPermissionRequest["options"][number];

export type AcpSessionNotification = Omit<AcpProtocolSessionNotification, "sessionId" | "update"> & {
  sessionId?: string;
  update?: AcpSessionUpdate;
};

export type AcpSessionUpdate = AcpProtocolSessionUpdate | UnknownAcpSessionUpdate;

export type AcpContentBlock = AcpProtocolContentBlock | { type: string; [key: string]: unknown };

export type AcpToolCallContent =
  | AcpProtocolToolCallContent
  | { type: "todo"; items?: unknown[]; entries?: unknown[]; todo?: unknown; todos?: unknown }
  | { type: string; [key: string]: unknown };

export interface AcpPlanEntry {
  content?: string;
  status?: string;
  priority?: string;
}

export interface AcpPermissionRequest extends Omit<AcpProtocolPermissionRequest, "sessionId" | "toolCall" | "options"> {
  sessionId?: string;
  toolCall?: Partial<AcpPermissionToolCall> & { content?: AcpToolCallContent[] };
  options?: Array<Partial<AcpPermissionOption> & { optionId?: string; name?: string; kind?: string }>;
}

export interface AcpTranslateOptions {
  /**
   * ACP session/load replay emits user_message_chunk events that should be
   * shown in history. Live prompts already emit a synthetic TurnBegin locally,
   * so user echo notifications from the active prompt stream are suppressed.
   */
  suppressUserEcho?: boolean;
  /**
   * Called for ACP session/update variants not explicitly mapped by this
   * compatibility layer. The default behavior remains to ignore them.
   */
  onUnknownSessionUpdate?: (update: AcpSessionUpdate) => void;
}

export class AcpLegacyEventTranslator {
  private toolArgs = new Map<string, string>();
  private toolTitles = new Map<string, string>();
  private seenTools = new Set<string>();

  reset(): void {
    this.toolArgs.clear();
    this.toolTitles.clear();
    this.seenTools.clear();
  }

  sessionUpdateToEvents(notification: AcpSessionNotification, options: AcpTranslateOptions = {}): StreamEvent[] {
    const update = notification.update;
    if (!update) {
      return [];
    }

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (options.suppressUserEcho) {
          return [];
        }
        const text = cleanSystemTags(contentText(("content" in update ? update.content : undefined) as AcpContentBlock | undefined));
        return text ? [{ type: "TurnBegin", payload: { user_input: text } }, { type: "StepBegin", payload: { n: 1 } }] : [];
      }
      case "agent_message_chunk": {
        const text = contentText(("content" in update ? update.content : undefined) as AcpContentBlock | undefined);
        return text ? [{ type: "ContentPart", payload: { type: "text", text } }] : [];
      }
      case "agent_thought_chunk": {
        const think = thoughtText(("content" in update ? update.content : undefined) as AcpContentBlock | undefined);
        return think.trim() ? [{ type: "ContentPart", payload: { type: "think", think } }] : [];
      }
      case "tool_call":
        return typeof update.toolCallId === "string" ? [this.toolCallToEvent(update as Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" }>)] : [];
      case "tool_call_update":
        return typeof update.toolCallId === "string" ? this.toolCallUpdateToEvents(update as Extract<AcpSessionUpdate, { sessionUpdate: "tool_call_update" }>) : [];
      case "plan":
        return [{ type: "Plan", payload: { entries: normalizePlanEntries(Array.isArray(update.entries) ? (update.entries as AcpPlanEntry[]) : undefined) } }];
      case "config_option_update":
        return configOptionUpdateToEvents(Array.isArray(update.configOptions) ? update.configOptions : undefined);
      case "available_commands_update":
        return availableCommandsUpdateToEvents(Array.isArray(update.availableCommands) ? update.availableCommands : undefined);
      case "usage_update":
        return usageUpdateToEvents(update as Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }>);
      default:
        options.onUnknownSessionUpdate?.(update);
        return [];
    }
  }

  extensionNotificationToEvents(method: string, params: unknown): StreamEvent[] {
    switch (method) {
      case "kimi/step_interrupted":
        return isStepInterruptedNotification(params) ? [{ type: "StepInterrupted", payload: {} }] : [];
      case "kimi/compaction":
        return compactionNotificationToEvents(params);
      case "kimi/subagent_event":
        return subagentNotificationToEvents(params);
      default:
        return [];
    }
  }

  permissionRequestToEvent(id: string | number, request: AcpPermissionRequest): StreamEvent {
    const toolCall = request.toolCall;
    const display = toolContentToDisplay(toolCall?.content);
    const description = display.map(displayBlockSummary).filter(Boolean).join("\n") || toolCall?.title || "Permission requested";
    const options =
      request.options?.map((o) => ({
        optionId: typeof o.optionId === "string" ? o.optionId : "",
        name: typeof o.name === "string" ? o.name : o.optionId || "Option",
        kind: typeof o.kind === "string" ? o.kind : undefined,
      })) ?? [];

    return {
      type: "ApprovalRequest",
      payload: {
        id,
        tool_call_id: toolCall?.toolCallId ?? String(id),
        sender: toolCall?.title ?? "Kimi",
        action: permissionAction(request),
        description,
        display,
        options: options.length > 0 ? options : undefined,
      },
    };
  }

  private toolCallToEvent(update: Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" }>): StreamEvent {
    const toolCallId = update.toolCallId;
    const args = toolInputText(update.content, update.rawInput);
    this.seenTools.add(toolCallId);
    this.toolArgs.set(toolCallId, args);
    this.toolTitles.set(toolCallId, update.title || "tool");
    return {
      type: "ToolCall",
      payload: {
        type: "function",
        id: toolCallId,
        function: {
          name: update.title || "tool",
          arguments: args || null,
        },
        extras: {
          kind: update.kind,
          status: update.status,
        },
      },
    };
  }

  private toolCallUpdateToEvents(update: Extract<AcpSessionUpdate, { sessionUpdate: "tool_call_update" }>): StreamEvent[] {
    const events: StreamEvent[] = [];
    const toolCallId = update.toolCallId;
    if (!this.seenTools.has(toolCallId)) {
      events.push(
        this.toolCallToEvent({
          sessionUpdate: "tool_call",
          toolCallId,
          title: update.title || "tool",
          status: update.status ?? undefined,
          content: update.content ?? undefined,
          rawInput: update.rawInput,
        }),
      );
    }

    if (update.title && update.title !== this.toolTitles.get(toolCallId)) {
      this.toolTitles.set(toolCallId, update.title);
      events.push({
        type: "ToolCall",
        payload: {
          type: "function",
          id: toolCallId,
          function: {
            name: update.title,
            arguments: this.toolArgs.get(toolCallId) || null,
          },
          extras: {
            status: update.status,
          },
        },
      });
    }

    const status = update.status;
    if (status === "completed" || status === "failed") {
      events.push({
        type: "ToolResult",
        payload: {
          tool_call_id: toolCallId,
          return_value: {
            is_error: status === "failed",
            output: toolOutputText(update.content ?? undefined, update.rawOutput),
            message: update.title || "",
            display: toolResultDisplay(update.content ?? undefined, update.rawOutput),
            extras: { status },
          },
        },
      });
      return events;
    }

    const nextArgs = toolInputText(update.content ?? undefined, update.rawInput);
    if (!nextArgs) {
      return events;
    }
    const previous = this.toolArgs.get(toolCallId) ?? "";
    const argumentsPart = nextArgs.startsWith(previous) ? nextArgs.slice(previous.length) : nextArgs;
    this.toolArgs.set(toolCallId, nextArgs);
    if (argumentsPart) {
      events.push({ type: "ToolCallPart", payload: { tool_call_id: toolCallId, arguments_part: argumentsPart } });
    }
    return events;
  }
}

function configOptionUpdateToEvents(configOptions: unknown[] | undefined): StreamEvent[] {
  if (!Array.isArray(configOptions)) {
    return [];
  }
  return [
    {
      type: "ConfigOptionUpdate",
      payload: { configOptions: configOptions.filter((option): option is Record<string, unknown> => option !== null && typeof option === "object" && !Array.isArray(option)) },
    },
  ];
}

function normalizeSlashCommandName(name: unknown): string {
  if (typeof name !== "string") {
    return "";
  }
  return name.startsWith("/") ? name.slice(1) : name;
}

function availableCommandsUpdateToEvents(availableCommands: unknown[] | undefined): StreamEvent[] {
  if (!Array.isArray(availableCommands)) {
    return [];
  }
  return [
    {
      type: "AvailableCommandsUpdate",
      payload: {
        availableCommands: availableCommands
          .filter((cmd): cmd is Record<string, unknown> => cmd !== null && typeof cmd === "object" && !Array.isArray(cmd))
          .map((cmd) => ({
            name: normalizeSlashCommandName(cmd.name),
            description: typeof cmd.description === "string" ? cmd.description : "",
            group: typeof cmd.group === "string" ? cmd.group : undefined,
          }))
          .filter((cmd) => cmd.name.length > 0),
      },
    },
  ];
}

function usageUpdateToEvents(update: Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }>): StreamEvent[] {
  const used = readFiniteNumber(update.used);
  const size = readFiniteNumber(update.size);
  const computedContextUsage = used !== undefined && size !== undefined && size > 0 ? used / size : undefined;
  const meta = update._meta && typeof update._meta === "object" ? (update._meta as Record<string, unknown>) : undefined;
  const contextUsageMeta = readFiniteNumber(meta?.contextUsage);

  return [
    {
      type: "StatusUpdate",
      payload: {
        context_usage: contextUsageMeta ?? computedContextUsage ?? null,
        context_tokens: used ?? null,
        max_context_tokens: size ?? null,
        token_usage: tokenUsageFromMeta(meta?.currentTurn) ?? null,
        message_id: null,
      },
    },
  ];
}

function compactionDetails(notification: Partial<KimiCompactionNotification> | undefined): CompactionBegin {
  const details: CompactionBegin = {};
  if (notification?.trigger) details.trigger = notification.trigger;
  if (notification?.instruction) details.instruction = notification.instruction;
  if (notification?.message) details.message = notification.message;
  return details;
}

function compactionNotificationToEvents(params: unknown): StreamEvent[] {
  const notification = asRecord(params) as Partial<KimiCompactionNotification> | undefined;
  const phase = notification?.phase;
  const details = compactionDetails(notification);

  if (phase === "started") {
    return [{ type: "CompactionBegin", payload: details }];
  }
  if (phase === "completed" || phase === "cancelled" || phase === "blocked") {
    const payload: CompactionEnd = { ...details, status: phase };
    if (notification?.result?.summary) payload.summary = notification.result.summary;
    if (typeof notification?.result?.compactedCount === "number") payload.compactedCount = notification.result.compactedCount;
    if (typeof notification?.result?.tokensBefore === "number") payload.tokensBefore = notification.result.tokensBefore;
    if (typeof notification?.result?.tokensAfter === "number") payload.tokensAfter = notification.result.tokensAfter;
    return [{ type: "CompactionEnd", payload }];
  }
  return [];
}

function subagentNotificationToEvents(params: unknown): StreamEvent[] {
  const notification = asRecord(params) as Partial<KimiSubagentNotification> | undefined;
  const parentToolCallId = notification?.parentToolCallId;
  const phase = notification?.phase;
  const subagentId = notification?.subagentId;
  if (!notification || typeof parentToolCallId !== "string" || typeof phase !== "string" || typeof subagentId !== "string") {
    return [];
  }

  const nestedEvent = nestedDisplayEvent(params);
  const event: WireEvent | null =
    nestedEvent ??
    (phase === "started"
      ? ({ type: "StepBegin", payload: { n: 1 } } satisfies WireEvent)
      : phase === "completed" && typeof notification.resultSummary === "string"
        ? ({ type: "ContentPart", payload: { type: "text", text: notification.resultSummary } } satisfies WireEvent)
        : phase === "failed" && typeof notification.error === "string"
          ? ({ type: "ContentPart", payload: { type: "text", text: notification.error } } satisfies WireEvent)
          : phase === "suspended" && typeof notification.reason === "string"
            ? ({ type: "ContentPart", payload: { type: "text", text: `Subagent suspended: ${notification.reason}` } } satisfies WireEvent)
            : null);

  return event ? [{ type: "SubagentEvent", payload: { task_tool_call_id: parentToolCallId, event } }] : [];
}

function nestedDisplayEvent(params: unknown): WireEvent | null {
  const notification = asRecord(params);
  const event = asRecord(notification?.event) as KimiNestedDisplayEvent | undefined;
  if (!event || typeof event.type !== "string") {
    return null;
  }

  switch (event.type) {
    case "StepBegin": {
      const payload = asRecord(event.payload);
      return typeof payload?.n === "number" ? { type: "StepBegin", payload: { n: payload.n } } : null;
    }
    case "ContentPart": {
      const payload = asRecord(event.payload);
      if (payload?.type === "text" && typeof payload.text === "string") {
        return { type: "ContentPart", payload: { type: "text", text: payload.text } };
      }
      if (payload?.type === "think" && typeof payload.think === "string") {
        return { type: "ContentPart", payload: { type: "think", think: payload.think } };
      }
      return null;
    }
    case "ToolCall": {
      const payload = asRecord(event.payload);
      const fn = asRecord(payload?.function);
      return typeof payload?.type === "string" && typeof payload.id === "string" && typeof fn?.name === "string"
        ? {
            type: "ToolCall",
            payload: {
              type: "function",
              id: payload.id,
              function: {
                name: fn.name,
                arguments: typeof fn.arguments === "string" || fn.arguments === null ? fn.arguments : null,
              },
              extras: asRecord(payload.extras) ?? null,
            },
          }
        : null;
    }
    case "ToolCallPart": {
      const payload = asRecord(event.payload);
      return typeof payload?.tool_call_id === "string"
        ? {
            type: "ToolCallPart",
            payload: {
              tool_call_id: payload.tool_call_id,
              arguments_part: typeof payload.arguments_part === "string" || payload.arguments_part === null ? payload.arguments_part : undefined,
            },
          }
        : null;
    }
    case "ToolResult": {
      const payload = asRecord(event.payload);
      const returnValue = asRecord(payload?.return_value);
      return typeof payload?.tool_call_id === "string" && returnValue
        ? {
            type: "ToolResult",
            payload: {
              tool_call_id: payload.tool_call_id,
              return_value: {
                is_error: returnValue.is_error === true,
                output: stringify(returnValue.output),
                message: typeof returnValue.message === "string" ? returnValue.message : "",
                display: Array.isArray(returnValue.display) ? (returnValue.display as DisplayBlock[]) : [],
                extras: asRecord(returnValue.extras) ?? null,
              },
            },
          }
        : null;
    }
    case "StatusUpdate": {
      const payload = asRecord(event.payload);
      const tokenUsage = tokenUsageFromMeta(payload?.token_usage);
      return {
        type: "StatusUpdate",
        payload: {
          context_usage: readFiniteNumber(payload?.context_usage) ?? null,
          context_tokens: readFiniteNumber(payload?.context_tokens) ?? null,
          max_context_tokens: readFiniteNumber(payload?.max_context_tokens) ?? null,
          token_usage: tokenUsage ?? null,
          message_id: typeof payload?.message_id === "string" || payload?.message_id === null ? payload.message_id : null,
        },
      };
    }
    default:
      return null;
  }
}

function isStepInterruptedNotification(params: unknown): params is KimiStepInterruptedNotification {
  const notification = asRecord(params);
  return (
    typeof notification?.turnId === "number" &&
    typeof notification.step === "number" &&
    typeof notification.reason === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function tokenUsageFromMeta(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const inputOther = readFiniteNumber(record.inputOther) ?? readFiniteNumber(record.input_other);
  const output = readFiniteNumber(record.output);
  const inputCacheRead = readFiniteNumber(record.inputCacheRead) ?? readFiniteNumber(record.input_cache_read);
  const inputCacheCreation = readFiniteNumber(record.inputCacheCreation) ?? readFiniteNumber(record.input_cache_creation);

  if (inputOther === undefined && output === undefined && inputCacheRead === undefined && inputCacheCreation === undefined) {
    return undefined;
  }

  return {
    input_other: inputOther ?? 0,
    output: output ?? 0,
    input_cache_read: inputCacheRead ?? 0,
    input_cache_creation: inputCacheCreation ?? 0,
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(content: AcpContentBlock | undefined): string {
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
}

function thoughtText(content: AcpContentBlock | undefined): string {
  const text = contentText(content);
  if (text) {
    return text;
  }
  if (!content || typeof content !== "object") {
    return "";
  }

  const record = content as Record<string, unknown>;
  for (const key of ["text", "thought", "thinking", "reasoning"] as const) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return "";
}

function toolInputText(content: AcpToolCallContent[] | undefined, rawInput: unknown): string {
  const text = toolContentText(content);
  if (text) {
    return text;
  }
  return stringify(rawInput);
}

function toolOutputText(content: AcpToolCallContent[] | undefined, rawOutput: unknown): string {
  const text = toolContentText(content);
  if (text) {
    return text;
  }
  return stringify(rawOutput);
}

function toolContentText(content: AcpToolCallContent[] | undefined): string {
  if (!content) {
    return "";
  }
  return content
    .map((entry) => (entry.type === "content" ? contentText((entry as { content?: AcpContentBlock }).content) : ""))
    .filter(Boolean)
    .join("\n");
}

function displayBlockFromAcpToolContent(entry: AcpToolCallContent): DisplayBlock | null {
  const record = entry as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  const description = typeof record.description === "string" ? record.description : undefined;

  if (entry.type === "diff" && path) {
    return {
      type: "diff",
      path,
      old_text: typeof record.oldText === "string" ? record.oldText : typeof record.old_text === "string" ? record.old_text : "",
      new_text: typeof record.newText === "string" ? record.newText : typeof record.new_text === "string" ? record.new_text : "",
    };
  }
  if (entry.type === "command" && typeof record.command === "string") {
    return {
      type: "command",
      language: typeof record.language === "string" ? record.language : "bash",
      command: record.command,
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
      ...(description ? { description } : {}),
      ...(typeof record.danger === "string" ? { danger: record.danger } : {}),
    };
  }
  if (entry.type === "file-op" && path && isFileOperation(record.operation)) {
    const detail = typeof record.detail === "string" ? record.detail : description;
    return { type: "file-op", operation: record.operation, path, ...(detail ? { detail } : {}) };
  }
  if (entry.type === "file-content" && path && typeof record.content === "string") {
    return { type: "file-content", path, content: record.content, ...(typeof record.language === "string" ? { language: record.language } : {}) };
  }
  if (entry.type === "url-fetch" && typeof record.url === "string") {
    return { type: "url-fetch", url: record.url, ...(typeof record.method === "string" ? { method: record.method } : {}) };
  }
  if (entry.type === "search" && typeof record.query === "string") {
    return { type: "search", query: record.query, ...(typeof record.scope === "string" ? { scope: record.scope } : {}) };
  }
  if (entry.type === "invocation" && isInvocationKind(record.kind) && typeof record.name === "string") {
    return { type: "invocation", kind: record.kind, name: record.name, ...(description ? { description } : {}) };
  }
  const taskId = typeof record.task_id === "string" ? record.task_id : typeof record.taskId === "string" ? record.taskId : undefined;
  if (entry.type === "background-task" && taskId) {
    return {
      type: "background-task",
      task_id: taskId,
      kind: typeof record.kind === "string" ? record.kind : "background",
      status: typeof record.status === "string" ? record.status : "unknown",
      ...(description ? { description } : {}),
    };
  }
  return null;
}

function isFileOperation(value: unknown): value is "read" | "write" | "edit" | "glob" | "grep" {
  return value === "read" || value === "write" || value === "edit" || value === "glob" || value === "grep";
}

function isInvocationKind(value: unknown): value is "agent" | "skill" {
  return value === "agent" || value === "skill";
}

function toolContentToDisplay(content: AcpToolCallContent[] | undefined): DisplayBlock[] {
  if (!content) {
    return [];
  }
  const blocks: DisplayBlock[] = [];
  for (const entry of content) {
    const displayBlock = displayBlockFromAcpToolContent(entry);
    if (displayBlock) {
      blocks.push(displayBlock);
      continue;
    }
    if (entry.type === "content") {
      const inner = (entry as { content?: AcpContentBlock }).content;
      if (inner?.type === "todo") {
        const items = todoItemsFromAcpTodoContent(inner as unknown as AcpToolCallContent);
        if (items.length > 0) {
          blocks.push({ type: "todo", items });
        }
      } else {
        const text = contentText(inner);
        if (text) {
          const todoItems = parseTodoListText(text);
          if (todoItems) {
            blocks.push({ type: "todo", items: todoItems });
          } else {
            blocks.push({ type: "brief", text });
          }
        }
      }
    } else if (entry.type === "todo") {
      const items = todoItemsFromAcpTodoContent(entry);
      if (items.length > 0) {
        blocks.push({ type: "todo", items });
      }
    }
  }
  return blocks;
}

function toolResultDisplay(content: AcpToolCallContent[] | undefined, rawOutput: unknown): DisplayBlock[] {
  const blocks = toolContentToDisplay(content);
  if (blocks.some((block) => block.type === "todo")) {
    return blocks;
  }

  const items = todoItemsFromUnknown(rawOutput);
  if (items.length > 0) {
    return [...blocks, { type: "todo", items }];
  }

  return blocks;
}

type TodoStatus = TodoBlock["items"][number]["status"];

function normalizeTodoItemStatus(status: unknown): TodoStatus {
  const normalized = typeof status === "string" ? status.trim().toLowerCase().replace(/[\s-]+/g, "_") : status;
  if (normalized === "done" || normalized === "completed" || normalized === "complete" || normalized === "finished") {
    return "done";
  }
  if (normalized === "in_progress" || normalized === "active" || normalized === "running") {
    return "in_progress";
  }
  return "pending";
}

function todoItemTitle(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const item = value as Record<string, unknown>;
  const title = item.title ?? item.content ?? item.text ?? item.name ?? item.task;
  return typeof title === "string" ? title.trim() : "";
}

function todoItemsFromArray(value: unknown): TodoBlock["items"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const title = todoItemTitle(entry);
      if (!title) {
        return null;
      }
      const status = entry && typeof entry === "object" ? normalizeTodoItemStatus((entry as Record<string, unknown>).status) : "pending";
      return { title, status };
    })
    .filter((entry): entry is TodoBlock["items"][number] => entry !== null);
}

function parseTodoListText(text: string): TodoBlock["items"] | null {
  const items: TodoBlock["items"] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:[-*]\s*)?\[([^\]]+)\]\s*(.+)$/.exec(line);
    if (match) {
      const status = match[1].trim();
      const title = match[2].trim();
      if (title) {
        items.push({ title, status: normalizeTodoItemStatus(status) });
      }
    }
  }
  return items.length > 0 ? items : null;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function todoItemsFromUnknown(value: unknown): TodoBlock["items"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    const parsedText = parseTodoListText(value);
    if (parsedText) {
      return parsedText;
    }
    const parsedJson = parseJsonValue(value);
    return parsedJson === null ? [] : todoItemsFromUnknown(parsedJson);
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
          return (entry as Record<string, unknown>).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    const textItems = parseTodoListText(text);
    return textItems ?? todoItemsFromArray(value);
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  for (const key of ["items", "entries", "todos", "todo", "list", "todo_list"] as const) {
    const items = todoItemsFromUnknown(record[key]);
    if (items.length > 0) {
      return items;
    }
  }

  for (const key of ["text", "content", "output", "message", "raw"] as const) {
    if (typeof record[key] === "string") {
      const items = parseTodoListText(record[key]);
      if (items) {
        return items;
      }
    }
  }

  const title = todoItemTitle(record);
  return title ? [{ title, status: normalizeTodoItemStatus(record.status) }] : [];
}

function todoItemsFromAcpTodoContent(entry: AcpToolCallContent): TodoBlock["items"] {
  const record = entry as Record<string, unknown>;
  const candidates = [record.items, record.entries, record.todos, record.todo];
  for (const candidate of candidates) {
    const items = todoItemsFromArray(candidate);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function normalizePlanEntries(entries: AcpPlanEntry[] | undefined): Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority?: "low" | "medium" | "high" }> {
  if (!entries) {
    return [];
  }

  return entries
    .map((entry) => {
      const content = typeof entry.content === "string" ? entry.content : "";
      const status: "pending" | "in_progress" | "completed" = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
      const priority: "low" | "medium" | "high" | undefined = entry.priority === "low" || entry.priority === "medium" || entry.priority === "high" ? entry.priority : undefined;
      return { content, status, priority };
    })
    .filter((entry) => entry.content.length > 0);
}

function displayBlockSummary(block: DisplayBlock): string {
  const record = block as Record<string, unknown>;
  switch (block.type) {
    case "brief":
      return typeof record.text === "string" ? record.text : "";
    case "diff":
      return `Modify ${typeof record.path === "string" ? record.path : ""}`;
    case "todo":
      return Array.isArray(record.items)
        ? record.items
            .map((item) => (item && typeof item === "object" && typeof (item as { title?: unknown }).title === "string" ? (item as { title: string }).title : ""))
            .filter(Boolean)
            .join("\n")
        : "";
    case "command":
      return typeof record.description === "string" ? record.description : typeof record.command === "string" ? record.command : "";
    case "file-op": {
      const detail = typeof record.detail === "string" ? record.detail : typeof record.description === "string" ? record.description : "";
      return `${typeof record.operation === "string" ? record.operation : "file"} ${typeof record.path === "string" ? record.path : ""}${detail ? `\n${detail}` : ""}`;
    }
    case "file-content":
      return `View ${typeof record.path === "string" ? record.path : ""}`;
    case "url-fetch":
      return `${typeof record.method === "string" ? record.method : "GET"} ${typeof record.url === "string" ? record.url : ""}`;
    case "search":
      return `Search ${typeof record.query === "string" ? record.query : ""}${typeof record.scope === "string" ? ` in ${record.scope}` : ""}`;
    case "invocation":
      return `${typeof record.kind === "string" ? record.kind : "invocation"} ${typeof record.name === "string" ? record.name : ""}${typeof record.description === "string" ? `\n${record.description}` : ""}`;
    case "background-task": {
      const taskId = typeof record.task_id === "string" ? record.task_id : typeof record.taskId === "string" ? record.taskId : "";
      const kind = typeof record.kind === "string" ? record.kind : "background";
      const status = typeof record.status === "string" ? record.status : "unknown";
      const description = typeof record.description === "string" ? `: ${record.description}` : "";
      return `Background task ${taskId} (${kind}, ${status})${description}`;
    }
    default:
      return "";
  }
}

function permissionAction(request: AcpPermissionRequest): string {
  const kinds = request.options?.map((o) => o.kind).filter(Boolean).join(", ");
  return kinds || "request permission";
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeAcpMode(options: { mode?: AgentMode; yoloMode?: boolean }): AgentMode {
  if (options.mode === "default" || options.mode === "plan" || options.mode === "auto" || options.mode === "yolo") {
    return options.mode;
  }
  return options.yoloMode ? "yolo" : "default";
}
