import {
  normalizeDisplayTodoStatus,
  type DisplayBlock as SharedDisplayBlock,
  type DisplayFileOperation,
  type DisplayInvocationKind,
} from "@moonshot-ai/kimi-code-vscode-display-model";
import type { DisplayBlock as LegacyDisplayBlock } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";

export function legacyDisplayBlocksToDisplay(blocks?: LegacyDisplayBlock[]): SharedDisplayBlock[] {
  return (blocks ?? []).flatMap((block): SharedDisplayBlock[] => {
    if (!block || typeof block !== "object" || !("type" in block)) {
      return [];
    }

    const record = block as Record<string, unknown>;
    switch (block.type) {
      case "brief":
        return typeof record.text === "string" ? [{ type: "brief", text: record.text }] : [];
      case "diff":
        return typeof record.path === "string" && typeof record.old_text === "string" && typeof record.new_text === "string"
          ? [{ type: "diff", path: record.path, oldText: record.old_text, newText: record.new_text }]
          : [];
      case "todo":
        return Array.isArray(record.items)
          ? [
              {
                type: "todo",
                items: record.items
                  .filter((item): item is { title: string; status?: unknown } => typeof item === "object" && item !== null && typeof (item as { title?: unknown }).title === "string")
                  .map((item) => ({ title: item.title, status: normalizeDisplayTodoStatus(item.status) })),
              },
            ]
          : [];
      case "command":
        return typeof record.command === "string"
          ? [
              {
                type: "command",
                language: typeof record.language === "string" ? record.language : "bash",
                command: record.command,
                cwd: typeof record.cwd === "string" ? record.cwd : undefined,
                description: typeof record.description === "string" ? record.description : undefined,
                danger: typeof record.danger === "string" ? record.danger : undefined,
              },
            ]
          : [];
      case "file-op":
        return isDisplayFileOperation(record.operation) && typeof record.path === "string"
          ? [
              {
                type: "file-op",
                operation: record.operation,
                path: record.path,
                detail: typeof record.detail === "string" ? record.detail : typeof record.description === "string" ? record.description : undefined,
              },
            ]
          : [];
      case "file-content":
        return typeof record.path === "string" && typeof record.content === "string"
          ? [{ type: "file-content", path: record.path, content: record.content, language: typeof record.language === "string" ? record.language : undefined }]
          : [];
      case "url-fetch":
        return typeof record.url === "string" ? [{ type: "url-fetch", url: record.url, method: typeof record.method === "string" ? record.method : undefined }] : [];
      case "search":
        return typeof record.query === "string" ? [{ type: "search", query: record.query, scope: typeof record.scope === "string" ? record.scope : undefined }] : [];
      case "invocation":
        return isDisplayInvocationKind(record.kind) && typeof record.name === "string"
          ? [{ type: "invocation", kind: record.kind, name: record.name, description: typeof record.description === "string" ? record.description : undefined }]
          : [];
      case "background-task": {
        const taskId = typeof record.task_id === "string" ? record.task_id : typeof record.taskId === "string" ? record.taskId : undefined;
        return taskId
          ? [
              {
                type: "background-task",
                taskId,
                kind: typeof record.kind === "string" ? record.kind : "background",
                status: typeof record.status === "string" ? record.status : "unknown",
                description: typeof record.description === "string" ? record.description : undefined,
              },
            ]
          : [];
      }
      default:
        return [];
    }
  });
}

export function displayBlocksToLegacy(blocks?: SharedDisplayBlock[]): LegacyDisplayBlock[] {
  return (blocks ?? []).map((block) => {
    switch (block.type) {
      case "brief":
        return { type: "brief", text: block.text };
      case "diff":
        return { type: "diff", path: block.path, old_text: block.oldText, new_text: block.newText };
      case "todo":
        return { type: "todo", items: block.items.map((item) => ({ title: item.title, status: item.status })) };
      case "command":
        return { type: "brief", text: block.description || block.command };
      case "file-op":
        return { type: "brief", text: `${block.operation} ${block.path}${block.detail ? `\n${block.detail}` : ""}` };
      case "file-content":
        return { type: "brief", text: `View ${block.path}` };
      case "url-fetch":
        return { type: "brief", text: `${block.method ?? "GET"} ${block.url}` };
      case "search":
        return { type: "brief", text: `Search ${block.query}${block.scope ? ` in ${block.scope}` : ""}` };
      case "invocation":
        return { type: "brief", text: `${block.kind} ${block.name}${block.description ? `\n${block.description}` : ""}` };
      case "background-task":
        return { type: "brief", text: `Background task ${block.taskId} (${block.kind}, ${block.status})${block.description ? `: ${block.description}` : ""}` };
    }
  });
}

function isDisplayFileOperation(value: unknown): value is DisplayFileOperation {
  return value === "read" || value === "write" || value === "edit" || value === "glob" || value === "grep";
}

function isDisplayInvocationKind(value: unknown): value is DisplayInvocationKind {
  return value === "agent" || value === "skill";
}
