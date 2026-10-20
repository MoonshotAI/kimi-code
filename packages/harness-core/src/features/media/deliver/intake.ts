import type { ContentPart } from '@moonshot-ai/agent-core/llm/message';
import type {
  MessageAppendingDecision,
  MessageAppendingEvent,
} from '@moonshot-ai/agent-core/loop/index';

import type { OsFsPort } from '#/features/os/host/index';

import type { ImageLimits } from '../state/configSection';
import type { MediaContent } from '../store';
import { buildImageCompressionCaption, compressBase64ForModel } from '../transform/compress';
import { persistOriginalImage } from '../transform/originals';

export interface CreateMediaIntakeProps {
  readonly putMedia: (content: MediaContent) => Promise<string>;
  readonly limits: () => ImageLimits;
  readonly originalsDir?: string;
  readonly fs?: OsFsPort;
}

export function createMediaIntake(
  props: CreateMediaIntakeProps,
): (event: MessageAppendingEvent) => Promise<MessageAppendingDecision | undefined> {
  return async ({ item }) => {
    const { entry } = item;
    if (entry.message.role !== 'user') return undefined;
    const { readByteBudget, maxEdgePx } = props.limits();
    const content: ContentPart[] = [];
    let changed = false;
    for (const part of entry.message.content) {
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
      const ref = await props.putMedia({
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
    return changed
      ? { entry: { message: { role: 'user', content }, meta: entry.meta } }
      : undefined;
  };
}
