import type { PluginCommandDef } from '@moonshot-ai/kimi-code-sdk';

import type { KimiSlashCommand } from './types';

export interface PluginSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  /** Maps a namespaced command name (`plugin:command`) to its markdown body. */
  readonly commandMap: ReadonlyMap<string, string>;
}

export function pluginCommandName(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

export function buildPluginSlashCommands(defs: readonly PluginCommandDef[]): PluginSlashCommands {
  const commandMap = new Map<string, string>();
  const commands = defs.map((def) => {
    const commandName = pluginCommandName(def.pluginId, def.name);
    commandMap.set(commandName, def.body);
    return {
      name: commandName,
      aliases: [],
      description: def.description,
    } satisfies KimiSlashCommand;
  });
  return { commands, commandMap };
}

/**
 * Expand `$ARGUMENTS` placeholders in a plugin command body with the typed args.
 * If the body has no placeholder but args are present, append them so nothing
 * is silently dropped.
 */
export function expandCommandArguments(body: string, args: string): string {
  const replaced = body.replaceAll('$ARGUMENTS', args);
  if (!body.includes('$ARGUMENTS') && args.length > 0) {
    return `${replaced}\n\nARGUMENTS: ${args}`;
  }
  return replaced;
}
