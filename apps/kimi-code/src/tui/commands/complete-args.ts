import type { AutocompleteItem } from '@moonshot-ai/pi-tui';

export interface ArgCompletionSpec {
  readonly value: string;
  readonly description: string;
}

export function completeLeadingArg(
  specs: readonly ArgCompletionSpec[],
  argumentPrefix: string,
): AutocompleteItem[] | null {
  if (argumentPrefix.includes(' ')) return null;
  const lower = argumentPrefix.toLowerCase();
  const items = specs
    .filter((spec) => spec.value.toLowerCase().startsWith(lower))
    .map((spec) => ({ value: spec.value, label: spec.value, description: spec.description }));
  const [only] = items;
  if (items.length === 1 && only !== undefined && only.value.toLowerCase() === lower) {
    return null;
  }
  return items.length > 0 ? items : null;
}
