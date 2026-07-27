import type { AutocompleteItem, SlashCommand } from '@moonshot-ai/pi-tui';
import type { FlagId, Session } from '@moonshot-ai/kimi-code-sdk';

export type SlashCommandAvailability = 'always' | 'idle-only';

/**
 * Context passed to `completeArgs` callbacks so they can fetch dynamic data
 * (e.g. the list of workflows from the session) without reaching into the
 * editor component themselves.
 */
export interface SlashCommandCompletionContext {
  readonly session?: Pick<Session, 'listWorkflows'>;
}

export interface KimiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /** When set, the command is hidden from the palette and blocked unless this flag is enabled. */
  readonly experimentalFlag?: FlagId;
  /**
   * Generic argument autocompletion. `argumentPrefix` is the text typed after
   * `/<command> `; return suggestions or `null`. Declared as a plain function
   * property (not a method) so passing it around is `this`-free. Adapted to
   * pi-tui's `getArgumentCompletions` in the autocomplete setup.
   */
  readonly completeArgs?: (
    argumentPrefix: string,
    context: SlashCommandCompletionContext,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
