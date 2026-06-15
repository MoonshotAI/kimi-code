import type { DisplayAvailableCommand } from "@moonshot-ai/kimi-code-vscode-display-model";

export interface SlashCommand {
  name: string;
  description: string;
  group?: string;
}

export function normalizeSlashCommandName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

export function availableCommandsToSlashCommands(dynamic: DisplayAvailableCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];

  for (const cmd of dynamic) {
    const name = normalizeSlashCommandName(cmd.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    commands.push({
      name,
      description: cmd.description,
      group: cmd.group,
    });
  }

  return commands;
}
