/**
 * `media` domain — request-time media reference resolver contract.
 *
 * Rewrites the `kimi-file://` daemon references a prompt carries in the
 * projected wire messages into provider-acceptable parts (an uploaded
 * `ms://` video reference, an inline base64 `data:` part, a `<video path>`
 * or `<image path>` text tag, or an unavailable-placeholder text part)
 * right before the messages reach the provider — so a `kimi-file://` url
 * never touches the wire. Bound at Agent scope.
 *
 * The decorator keeps the historical `agentVideoResolverService` name so the
 * DI identity (and the debug-RPC channel surface built from decorator names)
 * stays stable across the video-only → media rename.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';

export interface IAgentMediaResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]>;
}

export const IAgentMediaResolverService = createDecorator<IAgentMediaResolverService>(
  'agentVideoResolverService',
);
