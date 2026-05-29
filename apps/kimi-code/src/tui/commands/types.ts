import type { SlashCommand } from '@earendil-works/pi-tui';
import type { FlagId } from '@moonshot-ai/kimi-code-sdk';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface KimiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /** When set, the command is hidden from the palette and blocked unless this flag is enabled. */
  readonly experimentalFlag?: FlagId;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
