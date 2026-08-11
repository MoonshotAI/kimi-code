/**
 * `blob` domain — `IAgentBlobService` contract.
 *
 * Offloads large inline media payloads to content-addressed blob storage and
 * loads them back on read. Bound at Agent scope.
 */

import type { ContentPart } from '#/kosong/contract/message';

import { createDecorator } from "#/_base/di/instantiation";

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface IAgentBlobService {
  readonly _serviceBrand: undefined;

  offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  isBlobRef(url: string): boolean;
}

export const IAgentBlobService = createDecorator<IAgentBlobService>(
  'agentBlobService',
);
