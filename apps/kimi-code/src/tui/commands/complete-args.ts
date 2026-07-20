import type { AutocompleteItem } from '@moonshot-ai/pi-tui';

/**
 * A completable token (subcommand or flag) for a slash command's argument
 * position. Generic across commands — any `KimiSlashCommand` can build a
 * `getArgumentCompletions` from a list of these via {@link completeLeadingArg}.
 */
export interface ArgCompletionSpec {
  /** The token inserted on completion, e.g. `pause` or `resume`. */
  readonly value: string;
  /** Short description shown in the autocomplete menu. */
  readonly description: string;
}

/**
 * Generic leading-token completer for slash-command arguments.
 *
 * pi-tui passes `argumentPrefix` = everything typed after `/<command> `. We only
 * complete the *first* token: once the user has typed a space after it (moved on
 * to an objective, a flag value, etc.) we return `null` so completion never
 * clobbers free text. Matching is case-insensitive prefix match on `value`.
 */
export function completeLeadingArg(
  specs: readonly ArgCompletionSpec[],
  argumentPrefix: string,
): AutocompleteItem[] | null {
  if (argumentPrefix.includes(' ')) return null;
  const lower = argumentPrefix.toLowerCase();
  const items = specs
    .filter((spec) => spec.value.toLowerCase().startsWith(lower))
    .map((spec) => ({ value: spec.value, label: spec.value, description: spec.description }));
  // Nothing left to complete: the user has finished typing a token that is the
  // sole remaining match (e.g. `status`). Keeping the menu open here would make
  // Enter confirm the no-op completion instead of submitting the command, so we
  // suppress it. (A space after the token already returns null above.)
  const [only] = items;
  if (items.length === 1 && only !== undefined && only.value.toLowerCase() === lower) {
    return null;
  }
  return items.length > 0 ? items : null;
}
