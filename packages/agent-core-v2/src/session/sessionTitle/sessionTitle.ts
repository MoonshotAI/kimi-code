import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

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
