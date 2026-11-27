import type { AutocompleteItem, SlashCommand, TuiMode } from '@moonshot-ai/pi-tui';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface SlashCommandContext {
  readonly tuiMode: TuiMode;
}

export interface KimiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSummary['source'];
  readonly isSkill?: boolean;
  readonly workspaceDir?: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  readonly experimentalFlag?: string;
  readonly visible?: (context: SlashCommandContext) => boolean;
  readonly completeArgs?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
