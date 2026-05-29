import type { FlagDefinitionInput } from './types';

/**
 * Experimental feature flags. Empty by default — there are no experimental features yet.
 *
 * To add one, append an entry and gate the feature with `flags.enabled('my-feature')`:
 *   { id: 'my-feature', env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
 *
 * Keep the `as const satisfies` — it derives the literal `FlagId` union that gives `enabled()`
 * autocomplete and typo-checking. `env` must start with 'KIMI_CODE_EXPERIMENTAL_', be unique, and
 * not equal the master switch 'KIMI_CODE_EXPERIMENTAL_FLAG'; `id` must not be 'flag'.
 */
export const FLAG_DEFINITIONS = [] as const satisfies readonly FlagDefinitionInput[];

/** Literal union of registered flag ids (currently none → `never`). */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
