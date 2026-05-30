import {
  RequestError,
  type ContentBlock,
  type EmbeddedResourceResource,
} from '@agentclientprotocol/sdk';
import type { PromptInput, PromptPart } from '@moonshot-ai/kimi-code-sdk';

export function acpPromptToKimiInput(prompt: readonly ContentBlock[]): PromptInput {
  return prompt.flatMap((block) => acpContentBlockToKimiParts(block));
}

function acpContentBlockToKimiParts(block: ContentBlock): PromptPart[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block.text }];
    case 'image':
      return [
        {
          type: 'image_url',
          imageUrl: {
            url: block.uri ?? `data:${block.mimeType};base64,${block.data}`,
          },
        },
      ];
    case 'resource_link':
      return [{ type: 'text', text: formatResourceLink(block) }];
    case 'resource':
      return embeddedResourceToPromptParts(block.resource);
    case 'audio':
      throw RequestError.invalidParams(
        { contentType: 'audio' },
        'audio prompt blocks are not supported',
      );
    default: {
      const exhaustive: never = block;
      void exhaustive;
      throw RequestError.invalidParams(undefined, 'unsupported prompt block');
    }
  }
}

function embeddedResourceToPromptParts(resource: EmbeddedResourceResource): PromptPart[] {
  if ('text' in resource) {
    return [{ type: 'text', text: resource.text }];
  }

  const mimeType = resource.mimeType ?? 'application/octet-stream';
  if (mimeType.startsWith('image/')) {
    return [
      {
        type: 'image_url',
        imageUrl: { url: `data:${mimeType};base64,${resource.blob}` },
      },
    ];
  }

  return [
    {
      type: 'text',
      text: `Embedded binary resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}`,
    },
  ];
}

function formatResourceLink(block: Extract<ContentBlock, { type: 'resource_link' }>): string {
  const lines = [block.title ?? block.name, block.description, block.uri].filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );
  return lines.join('\n');
}
