import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export type FlagSurface = 'core' | 'tui' | 'both';

export type FlagId = string;

export interface FlagDefinitionInput {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
  /**
   * When true, the master switch (`KIMI_CODE_EXPERIMENTAL_FLAG`) does not
   * force this flag on. Reserved for experiments whose rollout must stay
   * independent of the master switch — the CLI force-enables that switch for
   * every v2 user, so a flag that followed it would turn on for everyone.
   * Per-flag env and `[experimental]` config overrides still apply.
   */
  readonly ignoreMaster?: boolean;
}

const contributedFlags: FlagDefinitionInput[] = [];

export function registerFlagDefinition(definition: FlagDefinitionInput): void {
  contributedFlags.push(definition);
}

export function getContributedFlags(): readonly FlagDefinitionInput[] {
  return contributedFlags;
}

export interface IFlagRegistry {
  readonly _serviceBrand: undefined;

  register(definition: FlagDefinitionInput): IDisposable;
  get(id: FlagId): FlagDefinitionInput | undefined;
  list(): readonly FlagDefinitionInput[];
}

export const IFlagRegistry: ServiceIdentifier<IFlagRegistry> =
  createDecorator<IFlagRegistry>('flagRegistry');
