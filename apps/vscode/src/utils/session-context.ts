import type {
  ContentPart,
  ContextMessage,
  PromptOrigin,
  ToolCall,
} from "@moonshot-ai/kimi-code-sdk";

const INTERNAL_ORIGINS = new Set<PromptOrigin["kind"]>([
  "injection",
  "system_trigger",
  "compaction_summary",
  "hook_result",
  "cron_job",
  "cron_missed",
]);

const TOOL_HINT_KEYS = ["path", "file_path", "command", "query", "url", "name", "pattern"];

export function buildExportMarkdown(input: {
  readonly sessionId: string;
  readonly workDir: string;
  readonly history: readonly ContextMessage[];
  readonly tokenCount: number;
  readonly now: Date;
}): string {
  const turns = groupIntoTurns(input.history);
  const firstUser = input.history.find(
    (message) => message.role === "user" && !isInternalMessage(message),
  );
  const topic = firstUser === undefined ? "" : shorten(stringifyParts(firstUser.content), 80);
  const toolCalls = input.history.reduce((count, message) => count + message.toolCalls.length, 0);
  const lines = [
    "---",
    `session_id: ${input.sessionId}`,
    `exported_at: ${input.now.toISOString()}`,
    `work_dir: ${input.workDir}`,
    `message_count: ${String(input.history.length)}`,
    `token_count: ${String(input.tokenCount)}`,
    "---",
    "",
    "# Kimi Session Export",
    "",
    "## Overview",
    "",
    topic ? `- **Topic**: ${topic}` : "- **Topic**: (empty)",
    `- **Conversation**: ${String(turns.length)} turns | ${String(toolCalls)} tool calls`,
    "",
    "---",
    "",
  ];

  for (let index = 0; index < turns.length; index += 1) {
    lines.push(formatTurn(turns[index]!, index + 1));
  }
  return lines.join("\n");
}

export function stringifyContextHistory(history: readonly ContextMessage[]): string {
  const messages: string[] = [];
  for (const message of history) {
    if (isInternalMessage(message)) continue;
    const sections: string[] = [];
    const content = stringifyParts(message.content);
    if (content.trim()) sections.push(content);
    if (message.toolCalls.length > 0) {
      sections.push(message.toolCalls.map(stringifyToolCall).join("\n"));
    }
    if (sections.length === 0) continue;
    const callId = message.role === "tool" && message.toolCallId
      ? ` (call_id: ${message.toolCallId})`
      : "";
    messages.push(`[${message.role.toUpperCase()}]${callId}\n${sections.join("\n")}`);
  }
  return messages.join("\n\n");
}

export function isImportableTextFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return true;
  return IMPORTABLE_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

export function isSensitiveFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return [".env", "credentials", "secrets", ".pem", ".key", ".p12", ".pfx", ".keystore"]
    .some((pattern) => normalized.includes(pattern));
}

function isInternalMessage(message: ContextMessage): boolean {
  return message.origin !== undefined && INTERNAL_ORIGINS.has(message.origin.kind);
}

function groupIntoTurns(history: readonly ContextMessage[]): ContextMessage[][] {
  const turns: ContextMessage[][] = [];
  let current: ContextMessage[] = [];
  for (const message of history) {
    if (isInternalMessage(message)) continue;
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function formatTurn(messages: readonly ContextMessage[], turnNumber: number): string {
  const lines = [`## Turn ${String(turnNumber)}`, ""];
  const toolInfo = new Map<string, { name: string; hint: string }>();
  let assistantHeading = false;
  for (const message of messages) {
    if (message.role === "user") {
      lines.push("### User", "", stringifyParts(message.content), "");
      continue;
    }
    if (message.role === "assistant") {
      if (!assistantHeading) {
        lines.push("### Assistant", "");
        assistantHeading = true;
      }
      const content = formatPartsMarkdown(message.content);
      if (content) lines.push(content, "");
      for (const call of message.toolCalls) {
        const hint = toolCallHint(call);
        toolInfo.set(call.id, { name: call.name, hint });
        lines.push(formatToolCallMarkdown(call, hint), "");
      }
      continue;
    }
    if (message.role === "tool") {
      const info = toolInfo.get(message.toolCallId ?? "") ?? { name: "unknown", hint: "" };
      const hint = info.hint ? ` (\`${info.hint}\`)` : "";
      lines.push(
        `<details><summary>Tool Result: ${info.name}${hint}</summary>`,
        "",
        `<!-- call_id: ${message.toolCallId ?? "unknown"} -->`,
        formatPartsMarkdown(message.content),
        "",
        "</details>",
        "",
      );
      continue;
    }
    lines.push(`### ${capitalize(message.role)}`, "", formatPartsMarkdown(message.content), "");
  }
  return lines.join("\n");
}

function formatToolCallMarkdown(call: ToolCall, hint: string): string {
  let args = call.arguments ?? "{}";
  try {
    args = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    // Preserve malformed arguments exactly as recorded.
  }
  const suffix = hint ? ` (\`${hint}\`)` : "";
  return `#### Tool Call: ${call.name}${suffix}\n<!-- call_id: ${call.id} -->\n\`\`\`json\n${args}\n\`\`\``;
}

function toolCallHint(call: ToolCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments ?? "{}");
  } catch {
    return "";
  }
  if (!isRecord(args)) return "";
  for (const key of TOOL_HINT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return shorten(value, 60);
  }
  return "";
}

function stringifyToolCall(call: ToolCall): string {
  let args = call.arguments ?? "{}";
  try {
    args = JSON.stringify(JSON.parse(args));
  } catch {
    // Preserve malformed arguments exactly as recorded.
  }
  return `Tool Call: ${call.name}(${args})`;
}

function formatPartsMarkdown(parts: readonly ContentPart[]): string {
  return parts.map(formatPartMarkdown).filter(Boolean).join("\n");
}

function formatPartMarkdown(part: ContentPart): string {
  switch (part.type) {
    case "text": return part.text;
    case "think": return part.think.trim()
      ? `<details><summary>Thinking</summary>\n\n${part.think}\n\n</details>`
      : "";
    case "image_url": return "[image]";
    case "audio_url": return "[audio]";
    case "video_url": return "[video]";
  }
}

function stringifyParts(parts: readonly ContentPart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "think") return part.think.trim() ? `<thinking>\n${part.think}\n</thinking>` : "";
    if (part.type === "image_url") return "[image]";
    if (part.type === "audio_url") return "[audio]";
    return "[video]";
  }).filter(Boolean).join("\n");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function shorten(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IMPORTABLE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".json", ".jsonl", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".csv", ".tsv", ".xml", ".env", ".properties",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".kt", ".go", ".rs", ".c", ".cpp",
  ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".scala", ".sh", ".bash", ".zsh",
  ".fish", ".ps1", ".bat", ".cmd", ".r", ".lua", ".pl", ".pm", ".ex", ".exs",
  ".erl", ".hs", ".ml", ".sql", ".graphql", ".proto", ".html", ".htm", ".css",
  ".scss", ".sass", ".less", ".svg", ".log", ".tex", ".bib", ".org", ".adoc", ".wiki",
]);
