import type { ContentPart, PromptGate } from '@moonshot-ai/agent-core';

import type { OsFsPort } from '#/features/os/host/index';

import type { MediaStore } from '../store';
import type { ImageLimits } from '../state/configSection';
import { buildImageCompressionCaption, compressBase64ForModel } from '../transform/compress';
import { persistOriginalImage } from '../transform/originals';

export interface CreateMediaPromptGateProps {
  readonly store: MediaStore;
  readonly limits: () => ImageLimits;
  readonly originalsDir?: string;
  readonly fs?: OsFsPort;
}

export function createMediaPromptGate(props: CreateMediaPromptGateProps): PromptGate {
  return async (_queueItemId, message) => {
    const { readByteBudget, maxEdgePx } = props.limits();
    const content: ContentPart[] = [];
    let changed = false;
    for (const part of message.content) {
      if (part.type !== 'image_url' || part.source.kind !== 'inline') {
        content.push(part);
        continue;
      }
      const source = part.source;
      const approxBytes = Math.floor((source.data.length * 3) / 4);
      if (approxBytes <= readByteBudget) {
        content.push(part);
        continue;
      }
      const compressed = await compressBase64ForModel(source.data, source.mimeType, {
        byteBudget: readByteBudget,
        maxEdge: maxEdgePx,
      });
      if (!compressed.changed) {
        content.push(part);
        continue;
      }
      const originalPath =
        props.originalsDir === undefined || props.fs === undefined
          ? null
          : await persistOriginalImage(
              Buffer.from(source.data, 'base64'),
              source.mimeType,
              { dir: props.originalsDir, fs: props.fs },
            );
      const ref = await props.store.put({
        bytes: Buffer.from(compressed.base64, 'base64'),
        mimeType: compressed.mimeType,
        filename: part.name,
      });
      content.push({
        type: 'text',
        text: buildImageCompressionCaption({
          original: {
            width: compressed.originalWidth,
            height: compressed.originalHeight,
            byteLength: compressed.originalByteLength,
            mimeType: source.mimeType,
          },
          final: {
            width: compressed.width,
            height: compressed.height,
            byteLength: compressed.finalByteLength,
            mimeType: compressed.mimeType,
          },
          originalPath,
        }),
      });
      content.push({
        type: 'image_url',
        source: { kind: 'store', ref },
        name: part.name,
      });
      changed = true;
    }
    return changed ? { block: false, message: { ...message, content } } : { block: false, message };
  };
}
