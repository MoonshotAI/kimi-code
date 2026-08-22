import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Which conversation excerpt a title generation draws from:
 * - `user_prompts` (default): the first natural-language user prompts.
 * - `first_turn`: the opening user prompt plus the first turn's final
 *   assistant text; strict — unavailable until the first turn has produced
 *   an assistant reply.
 * - `digest`: the whole conversation arc — every natural-language user
 *   prompt in the live window paired with its own turn's final assistant
 *   text, using whatever the (possibly compacted) window still holds;
 *   meant for explicit regeneration on multi-turn sessions.
 */
export type SessionTitleSource = 'user_prompts' | 'first_turn' | 'digest';

export interface ISessionTitleService {
  readonly _serviceBrand: undefined;

  generateTitle(opts?: {
    force?: boolean;
    source?: SessionTitleSource;
  }): Promise<string | undefined>;
}

export const ISessionTitleService: ServiceIdentifier<ISessionTitleService> =
  createDecorator<ISessionTitleService>('sessionTitleService');
