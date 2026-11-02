export interface HostSlashCommand {
  readonly name: string;
  readonly args: string;
  readonly raw: string;
}

const HOST_COMMANDS = new Set([
  "init",
  "compact",
  "clear",
  "reset",
  "yolo",
  "auto",
  "afk",
  "plan",
  "add-dir",
  "export",
  "import",
]);

const MODEL_FREE_HOST_COMMANDS = new Set([
  "clear",
  "reset",
  "yolo",
  "auto",
  "afk",
  "plan",
  "add-dir",
  "export",
  "import",
]);

export function parseHostSlashCommand(content: string | readonly unknown[]): HostSlashCommand | undefined {
  if (typeof content !== "string") return undefined;
  const raw = content.trim();
  const match = /^\/([^\s]+)(?:\s+(.*))?\s*$/s.exec(raw);
  if (match === null) return undefined;
  const name = match[1]!.toLowerCase();
  if (!HOST_COMMANDS.has(name) && !name.startsWith("skill:")) return undefined;
  return { name, args: match[2]?.trim() ?? "", raw };
}

export function isModelFreeHostCommand(command: HostSlashCommand): boolean {
  return MODEL_FREE_HOST_COMMANDS.has(command.name);
}
