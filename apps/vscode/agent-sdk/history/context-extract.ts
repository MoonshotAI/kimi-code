import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { KimiPaths } from "../paths";
import { cleanUserInput } from "../utils";
import { parseEventPayload, type ContentPart, type DisplayBlock, type StreamEvent, type ToolResult, type WireEvent } from "../schema";

// Constants
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Parse Session Events
export async function parseSessionEvents(workDir: string, sessionId: string): Promise<StreamEvent[]> {
  const sessionDir = KimiPaths.sessionDir(workDir, sessionId);
  const wireFile = findFirstExistingFile(path.join(sessionDir, "agents", "main", "wire.jsonl"), path.join(sessionDir, "wire.jsonl"));
  const contextFile = path.join(sessionDir, "context.jsonl");

  // Try wire.jsonl first (complete event stream)
  if (wireFile) {
    const stat = await fsp.stat(wireFile);
    if (stat.size <= MAX_FILE_SIZE) {
      return parseWireFile(wireFile);
    }
  }

  // Fallback to context.jsonl (compacted)
  if (fs.existsSync(contextFile)) {
    return parseContextFile(contextFile);
  }

  return [];
}

function findFirstExistingFile(...files: string[]): string | null {
  return files.find((file) => fs.existsSync(file)) ?? null;
}

// Wire File Parser
async function parseWireFile(filePath: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line);
      events.push(...parseWireRecord(record));
    } catch {
      // Skip invalid lines
    }
  }

  return events;
}

function parseWireRecord(record: unknown): StreamEvent[] {
  if (!record || typeof record !== "object") {
    return [];
  }

  const rec = record as Record<string, unknown>;
  const converted = convertRecordWireRecord(rec);
  if (converted.length > 0) {
    return converted;
  }

  const message = rec.message as { type?: string; payload?: unknown } | undefined;

  if (!message?.type) {
    return [];
  }

  const result = parseEventPayload(message.type, message.payload);
  if (!result.ok) {
    return [];
  }

  const event = cleanTurnBeginEvent(result.value);
  return event ? [event] : [];
}

function convertRecordWireRecord(record: Record<string, unknown>): StreamEvent[] {
  if (record.type === "context.append_message") {
    return convertContextMessage(record.message, false);
  }
  if (record.type === "context.append_loop_event") {
    return convertLoopEvent(record.event);
  }
  return [];
}

function convertLoopEvent(raw: unknown): StreamEvent[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const event = raw as Record<string, unknown>;
  if (event.type === "step.begin") {
    const n = typeof event.step === "number" ? event.step : 1;
    return [{ type: "StepBegin", payload: { n } }];
  }
  if (event.type === "content.part") {
    return [{ type: "ContentPart", payload: normalizeContentPart(event.part) }];
  }
  if (event.type === "tool.call") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : typeof event.uuid === "string" ? event.uuid : null;
    const name = typeof event.name === "string" ? event.name : "tool";
    if (!toolCallId) {
      return [];
    }
    return [
      {
        type: "ToolCall",
        payload: {
          type: "function",
          id: toolCallId,
          function: {
            name,
            arguments: stringifyToolArguments(event.args),
          },
          extras: {
            description: event.description,
          },
        },
      },
    ];
  }
  if (event.type === "tool.result") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : typeof event.parentUuid === "string" ? event.parentUuid : null;
    if (!toolCallId) {
      return [];
    }
    const result = normalizeToolResult(event.result);
    return [
      {
        type: "ToolResult",
        payload: {
          tool_call_id: toolCallId,
          return_value: result,
        },
      },
    ];
  }

  return [];
}

// Context File Parser
async function parseContextFile(filePath: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line);
      const converted = convertContextRecord(record);
      events.push(...converted);
    } catch {
      // Skip invalid lines
    }
  }

  return events;
}

function convertContextRecord(record: unknown): WireEvent[] {
  if (!record || typeof record !== "object") {
    return [];
  }

  const rec = record as Record<string, unknown>;
  return convertContextMessage(rec, true);
}

function convertContextMessage(rec: unknown, synthesizeStepBegin: boolean): WireEvent[] {
  if (!rec || typeof rec !== "object") {
    return [];
  }

  const message = rec as Record<string, unknown>;
  const events: WireEvent[] = [];
  const role = message.role;

  // Convert role-based context records to events
  if (role === "user" && message.content) {
    if (isInjectedMessage(message)) {
      return events;
    }

    const content = normalizeContent(message.content);
    const userInput = cleanUserInput(content);
    if (!userInput) {
      return events;
    }

    events.push({
      type: "TurnBegin",
      payload: { user_input: userInput },
    });
    if (synthesizeStepBegin) {
      events.push({
        type: "StepBegin",
        payload: { n: 1 },
      });
    }
  }

  if (role === "assistant" && message.content) {
    for (const part of normalizeContent(message.content)) {
      events.push({
        type: "ContentPart",
        payload: part,
      });
    }
  }

  // Handle tool calls
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (call && typeof call === "object") {
        const tc = call as Record<string, unknown>;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (tc.id && fn?.name) {
          events.push({
            type: "ToolCall",
            payload: {
              type: "function",
              id: tc.id as string,
              function: {
                name: fn.name as string,
                arguments: fn.arguments as string | undefined,
              },
            },
          });
        }
      }
    }
  }

  if (role === "tool") {
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : typeof message.tool_call_id === "string" ? message.tool_call_id : null;
    if (toolCallId) {
      events.push({
        type: "ToolResult",
        payload: {
          tool_call_id: toolCallId,
          return_value: {
            is_error: false,
            output: normalizeContent(message.content),
            message: "",
            display: [],
          },
        },
      });
    }
  }

  return events;
}

function isInjectedMessage(message: Record<string, unknown>): boolean {
  const origin = message.origin;
  if (!origin || typeof origin !== "object") {
    return false;
  }
  return (origin as Record<string, unknown>).kind !== "user";
}

function normalizeContent(raw: unknown): ContentPart[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  if (!Array.isArray(raw)) {
    return raw === undefined || raw === null ? [] : [{ type: "text", text: stringifyUnknown(raw) }];
  }
  return raw.map(normalizeContentPart);
}

function normalizeContentPart(raw: unknown): ContentPart {
  if (!raw || typeof raw !== "object") {
    return { type: "text", text: stringifyUnknown(raw) };
  }

  const part = raw as Record<string, unknown>;
  if (part.type === "text") {
    return { type: "text", text: stringifyUnknown(part.text) };
  }
  if (part.type === "think") {
    const encrypted = typeof part.encrypted === "string" ? part.encrypted : part.encrypted === null ? null : undefined;
    return { type: "think", think: stringifyUnknown(part.think), encrypted };
  }
  if (part.type === "image" || part.type === "image_url") {
    return mediaPart("image_url", part, "imageUrl", "image_url");
  }
  if (part.type === "audio" || part.type === "audio_url") {
    return mediaPart("audio_url", part, "audioUrl", "audio_url");
  }
  if (part.type === "video" || part.type === "video_url") {
    return mediaPart("video_url", part, "videoUrl", "video_url");
  }

  const result = parseEventPayload("ContentPart", raw);
  return result.ok && result.value.type === "ContentPart" ? result.value.payload : { type: "text", text: `[unsupported content: ${stringifyUnknown(raw)}]` };
}

function mediaPart(type: "image_url" | "audio_url" | "video_url", part: Record<string, unknown>, camelKey: string, snakeKey: string): ContentPart {
  const directUrl = typeof part.url === "string" ? part.url : undefined;
  const nested = typeof part[camelKey] === "object" && part[camelKey] !== null ? (part[camelKey] as Record<string, unknown>) : typeof part[snakeKey] === "object" && part[snakeKey] !== null ? (part[snakeKey] as Record<string, unknown>) : undefined;
  const url = directUrl ?? (typeof nested?.url === "string" ? nested.url : "");
  const id = typeof part.id === "string" ? part.id : typeof nested?.id === "string" ? nested.id : undefined;

  if (type === "image_url") {
    return { type, image_url: { url, id } };
  }
  if (type === "audio_url") {
    return { type, audio_url: { url, id } };
  }
  return { type, video_url: { url, id } };
}

function stringifyToolArguments(args: unknown): string | null {
  if (args === undefined || args === null) {
    return null;
  }
  if (typeof args === "string") {
    return args;
  }
  return stringifyUnknown(args);
}

function normalizeToolResult(raw: unknown): ToolResult["return_value"] {
  if (!raw || typeof raw !== "object") {
    const output = stringifyUnknown(raw);
    return { is_error: false, output, message: output, display: [] };
  }

  const result = raw as Record<string, unknown>;
  const output = "output" in result ? normalizeToolOutput(result.output) : normalizeToolOutput(raw);
  return {
    is_error: result.is_error === true || result.isError === true,
    output,
    message: typeof result.message === "string" ? result.message : typeof output === "string" ? output : "",
    display: Array.isArray(result.display) ? (result.display as DisplayBlock[]) : [],
    extras: typeof result.extras === "object" && result.extras !== null ? (result.extras as Record<string, unknown>) : undefined,
  };
}

function normalizeToolOutput(raw: unknown): string | ContentPart[] {
  if (Array.isArray(raw)) {
    return normalizeContent(raw);
  }
  if (typeof raw === "string") {
    return raw;
  }
  return stringifyUnknown(raw);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function cleanTurnBeginEvent(event: StreamEvent): StreamEvent | null {
  if (event.type !== "TurnBegin") {
    return event;
  }

  const userInput = cleanUserInput(event.payload.user_input);
  return userInput ? { ...event, payload: { user_input: userInput } } : null;
}
