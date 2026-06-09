import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { KimiPaths } from "../paths";
import { cleanUserInput } from "../utils";
import { parseEventPayload, type ContentPart, type StreamEvent, type WireEvent } from "../schema";

// Constants
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Parse Session Events
export async function parseSessionEvents(workDir: string, sessionId: string): Promise<StreamEvent[]> {
  const sessionDir = KimiPaths.sessionDir(workDir, sessionId);
  const wireFile = path.join(sessionDir, "wire.jsonl");
  const contextFile = path.join(sessionDir, "context.jsonl");

  // Try wire.jsonl first (complete event stream)
  if (fs.existsSync(wireFile)) {
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
      const event = parseWireRecord(record);
      if (event) {
        events.push(event);
      }
    } catch {
      // Skip invalid lines
    }
  }

  return events;
}

function parseWireRecord(record: unknown): StreamEvent | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const rec = record as Record<string, unknown>;
  const message = rec.message as { type?: string; payload?: unknown } | undefined;

  if (!message?.type) {
    return null;
  }

  const result = parseEventPayload(message.type, message.payload);
  if (!result.ok) {
    return null;
  }

  return cleanTurnBeginEvent(result.value);
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
  const events: WireEvent[] = [];

  // Convert role-based context records to events
  if (rec.role === "user" && rec.content) {
    const userInput =
      typeof rec.content === "string" || Array.isArray(rec.content)
        ? cleanUserInput(rec.content as string | ContentPart[])
        : null;
    if (!userInput) {
      return events;
    }

    events.push({
      type: "TurnBegin",
      payload: { user_input: userInput },
    });
  }

  if (rec.role === "assistant" && rec.content) {
    const content = rec.content;
    if (typeof content === "string") {
      events.push({
        type: "ContentPart",
        payload: { type: "text", text: content },
      });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "type" in part) {
          const result = parseEventPayload("ContentPart", part);
          if (result.ok) {
            events.push(result.value);
          }
        }
      }
    }
  }

  // Handle tool calls
  if (rec.tool_calls && Array.isArray(rec.tool_calls)) {
    for (const call of rec.tool_calls) {
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

  return events;
}

function cleanTurnBeginEvent(event: StreamEvent): StreamEvent | null {
  if (event.type !== "TurnBegin") {
    return event;
  }

  const userInput = cleanUserInput(event.payload.user_input);
  return userInput ? { ...event, payload: { user_input: userInput } } : null;
}
