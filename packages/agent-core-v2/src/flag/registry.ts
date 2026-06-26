/**
 * `flag` domain (L3) — flag definition catalog (`FlagRegistry`) and the
 * `[experimental]` config section schema.
 */

import { z } from 'zod';

export type FlagSurface = 'core' | 'tui' | 'both';

export interface FlagDefinitionInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
}

export const FLAG_DEFINITIONS = [
  {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older large tool results from context while keeping recent conversation intact.',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    default: true,
    surface: 'core',
  },
] as const satisfies readonly FlagDefinitionInput[];

export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];

export type FlagDefinition = FlagDefinitionInput & { readonly id: FlagId };

export const ExperimentalConfigSchema = z.record(z.string(), z.boolean());
export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;

export class FlagRegistry {
  private readonly byId: ReadonlyMap<string, FlagDefinitionInput>;

  constructor(readonly definitions: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS) {
    this.byId = new Map(definitions.map((def) => [def.id, def]));
  }

  get(id: FlagId): FlagDefinition | undefined {
    return this.byId.get(id) as FlagDefinition | undefined;
  }

  list(): readonly FlagDefinition[] {
    return this.definitions as readonly FlagDefinition[];
  }
}
