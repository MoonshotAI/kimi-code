import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ModelCapability } from '#/llm/capability';
import type { ContentPart } from '#/llm/message';
import { mediaKindForPath, mediaMimeForPath } from '#/llm/media/mime';
import { buildMediaRefUrl } from '#/llm/media/ref';
import type { MediaStore } from '#/llm/media/store';
import type { ToolResult } from '#/tool/executor';
import { defineTool, type ToolDefinition } from '#/tool/tool';

import DESCRIPTION from './read-media.md?raw';

export const READ_MEDIA_FILE_TOOL_NAME = 'ReadMediaFile';
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export interface ReadMediaFileToolOptions {
  readonly store: MediaStore;
  readonly workspaceDir: string;
  readonly capability: ModelCapability;
}

function errorResult(output: string): ToolResult {
  return { content: [{ type: 'text', text: output }], isError: true };
}

export function createReadMediaFileTool(options: ReadMediaFileToolOptions): ToolDefinition {
  return defineTool({
    name: READ_MEDIA_FILE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to an image or video file. Relative paths resolve against the working directory. Directories and text files are not supported.',
        },
      },
      required: ['path'],
    },
    async execute({ toolCall }) {
      const args = JSON.parse(toolCall.arguments ?? '{}') as { path?: unknown };
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        return errorResult('File path cannot be empty.');
      }
      const filePath = path.resolve(options.workspaceDir, args.path);
      const kind = mediaKindForPath(filePath);
      if (kind === undefined) {
        return errorResult(`"${args.path}" is not a supported image or video file.`);
      }
      if (kind === 'image' && !options.capability.image_in) {
        return errorResult(
          'The current model does not support image input. Tell the user to use a model with image input capability.',
        );
      }
      if (kind === 'video' && !options.capability.video_in) {
        return errorResult(
          'The current model does not support video input. Tell the user to use a model with video input capability.',
        );
      }
      let data: Buffer;
      try {
        data = await fs.readFile(filePath);
      } catch (error) {
        return errorResult(
          `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (data.length === 0) {
        return errorResult(`"${args.path}" is empty.`);
      }
      if (data.length > MAX_MEDIA_BYTES) {
        return errorResult(
          `"${args.path}" is ${String(data.length)} bytes, which exceeds the maximum 100MB for media files.`,
        );
      }
      const mimeType = mediaMimeForPath(filePath) as string;
      const filename = path.basename(filePath);
      const ref = await options.store.put({
        bytes: new Uint8Array(data),
        mimeType,
        filename,
      });
      const url = buildMediaRefUrl(ref);
      const mediaPart: ContentPart =
        kind === 'image'
          ? { type: 'image_url', imageUrl: { url } }
          : { type: 'video_url', videoUrl: { url } };
      return {
        content: [
          { type: 'text', text: `<${kind} path="${filePath}">` },
          mediaPart,
          { type: 'text', text: `</${kind}>` },
        ],
      };
    },
  });
}
