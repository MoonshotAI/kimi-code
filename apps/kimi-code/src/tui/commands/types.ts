import type { SlashCommand } from '@earendil-works/pi-tui';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface KimiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';
