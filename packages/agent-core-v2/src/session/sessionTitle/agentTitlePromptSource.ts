import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * The first turn's excerpt: the opening natural-language user prompt and the
 * final assistant text of that turn. Either side is `undefined` when the
 * live window does not (yet) hold it — `first_turn` generation stays strict
 * and reports unavailability instead of degrading.
 */
export interface TitleTurnExcerpt {
  readonly user?: string | undefined;
  readonly assistant?: string | undefined;
}

/**
 * One turn of the whole-conversation digest: a natural-language user prompt
 * paired with the final assistant text of its turn (`undefined` while that
 * turn has not produced one).
 */
export interface TitleDigestTurn {
  readonly user: string;
  readonly assistant?: string;
}

/**
 * The whole-conversation digest excerpt: every natural-language user prompt
 * in the live window, each paired with its own turn's final assistant text,
 * in chronological order. The window may be post-compaction — the digest
 * covers whatever the window still holds.
 */
export interface TitleDigestExcerpt {
  readonly turns: readonly TitleDigestTurn[];
}

export interface IAgentTitlePromptSource {
  readonly _serviceBrand: undefined;

  firstUserPrompts(limit: number): Promise<readonly string[]>;

  firstTurnExcerpt(): Promise<TitleTurnExcerpt>;

  digestExcerpt(): Promise<TitleDigestExcerpt>;
}

export const IAgentTitlePromptSource: ServiceIdentifier<IAgentTitlePromptSource> =
  createDecorator<IAgentTitlePromptSource>('agentTitlePromptSource');
