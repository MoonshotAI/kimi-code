import type { DisplayBlock } from "../../shared/legacy-sdk";

export function deriveToolDisplay(name: string, args: unknown): DisplayBlock[] {
  if (!isRecord(args)) return [{ type: "brief", text: name }];
  const command = stringField(args, "command");
  if (command !== undefined) {
    return [{
      type: "shell",
      language: stringField(args, "language") ?? "bash",
      command,
    }];
  }
  const oldString = stringField(args, "old_string");
  const newString = stringField(args, "new_string");
  const filePath = stringField(args, "file_path") ?? stringField(args, "path");
  if (oldString !== undefined && newString !== undefined) {
    return [{ type: "diff", path: filePath ?? "", old_text: oldString, new_text: newString }];
  }
  const content = stringField(args, "content");
  if (filePath !== undefined && content !== undefined && isWriteLike(name)) {
    return [{ type: "diff", path: filePath, old_text: "", new_text: content }];
  }
  const todos = todoItems(args);
  if (todos !== undefined) return [{ type: "todo", items: todos }];
  return [{ type: "brief", text: describeToolCall(name, args) }];
}

export function describeToolCall(name: string, args: unknown): string {
  if (!isRecord(args)) return name;
  const command = stringField(args, "command");
  if (command !== undefined) return command;
  const oldString = stringField(args, "old_string");
  const filePath = stringField(args, "file_path") ?? stringField(args, "path");
  if (oldString !== undefined && stringField(args, "new_string") !== undefined) {
    return `Edit ${filePath ?? ""}`;
  }
  if (filePath !== undefined) return `${inferFileOperation(name)} ${filePath}`;
  const query = stringField(args, "query") ?? stringField(args, "pattern");
  if (query !== undefined) return `Search for ${query}`;
  const url = stringField(args, "url");
  if (url !== undefined) return url;
  const prompt = stringField(args, "prompt");
  if (prompt !== undefined && (name === "Agent" || name === "AgentSwarm")) return prompt;
  const skillName = stringField(args, "skill_name") ?? stringField(args, "name");
  if (skillName !== undefined && name === "Skill") {
    const skillArgs = stringField(args, "args");
    return skillArgs === undefined ? skillName : `${skillName} ${skillArgs}`;
  }
  if (todoItems(args) !== undefined) return "Update the task list";
  const description = stringField(args, "description");
  if (description !== undefined) return description;
  return name;
}

function isWriteLike(name: string): boolean {
  return name === "Write" || name === "WriteFile";
}

function inferFileOperation(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("write")) return "write";
  if (lower.includes("edit")) return "edit";
  if (lower.includes("glob")) return "glob";
  if (lower.includes("grep")) return "grep";
  return "read";
}

function todoItems(
  args: Record<string, unknown>,
): Array<{ title: string; status: "pending" | "in_progress" | "done" }> | undefined {
  const value = args["todos"];
  if (!Array.isArray(value)) return undefined;
  const items: Array<{ title: string; status: "pending" | "in_progress" | "done" }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const title = entry["title"];
    if (typeof title !== "string") return undefined;
    const status = entry["status"];
    items.push({
      title,
      status: status === "done" || status === "in_progress" ? status : "pending",
    });
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}
