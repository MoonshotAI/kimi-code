import type { FlagId } from './registry';

/** Which layer consumes a flag — documentation/grouping only; not used in resolution. */
export type FlagSurface = 'core' | 'tui' | 'both';

/** Shape of a registry entry (id is a loose string so `as const satisfies` can validate it). */
export interface FlagDefinitionInput {
  readonly id: string;
  /** Full environment variable name, e.g. `KIMI_CODE_EXPERIMENTAL_MY_FEATURE`. Read directly by the resolver. */
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
}

/** FlagId-typed view so consumers can fetch a definition by its literal id. */
export type FlagDefinition = FlagDefinitionInput & { readonly id: FlagId };

/** Resolved enabled-state of every experimental flag (flag id → enabled); used for the SDK snapshot. */
export type ExperimentalFlagMap = Record<string, boolean>;
