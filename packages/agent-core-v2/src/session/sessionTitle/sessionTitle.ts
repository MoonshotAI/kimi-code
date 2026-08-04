/**
 * `sessionTitle` domain (L6) — session title generation contract.
 *
 * Defines the Session-scoped `ISessionTitleService` that generates a
 * session title from the main Agent's conversation history. An
 * already-generated title is not regenerated; a custom title is never
 * overwritten.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionTitleService {
  readonly _serviceBrand: undefined;

  generateTitle(): Promise<string | undefined>;
}

export const ISessionTitleService: ServiceIdentifier<ISessionTitleService> =
  createDecorator<ISessionTitleService>('sessionTitleService');
