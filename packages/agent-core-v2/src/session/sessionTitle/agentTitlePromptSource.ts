import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface TitleTurnExcerpt {
  readonly user?: string | undefined;
  readonly assistant?: string | undefined;
}

export interface TitleDigestTurn {
  readonly user: string;
  readonly assistant?: string;
}

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
