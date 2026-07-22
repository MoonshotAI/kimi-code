/**
 * `media` domain (L4) — request-time video reference resolver contract.
 *
 * Rewrites the `kimi-file://` video references a prompt carries in the
 * projected wire messages into a provider-acceptable form (an uploaded
 * `ms://` reference, an inline base64 `data:` part, or a `<video path>` text
 * tag) right before the messages reach the provider — so a `kimi-file://` url
 * never touches the wire. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';

export interface IAgentVideoResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]>;
}

export const IAgentVideoResolverService = createDecorator<IAgentVideoResolverService>(
  'agentVideoResolverService',
);
