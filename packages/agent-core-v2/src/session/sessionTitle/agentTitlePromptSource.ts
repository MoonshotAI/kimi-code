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
 * The whole-conversation digest excerpt: the first and last natural-language
 * user prompts (collapsed into one when the conversation has a single
 * prompt) and the final assistant text of the latest turn.
 */
export interface TitleDigestExcerpt {
  readonly firstUser?: string | undefined;
  readonly lastUser?: string | undefined;
  readonly assistant?: string | undefined;
}

export interface IAgentTitlePromptSource {
  readonly _serviceBrand: undefined;

  firstUserPrompts(limit: number): Promise<readonly string[]>;

  firstTurnExcerpt(): Promise<TitleTurnExcerpt>;

  digestExcerpt(): Promise<TitleDigestExcerpt>;
}

export const IAgentTitlePromptSource: ServiceIdentifier<IAgentTitlePromptSource> =
  createDecorator<IAgentTitlePromptSource>('agentTitlePromptSource');
