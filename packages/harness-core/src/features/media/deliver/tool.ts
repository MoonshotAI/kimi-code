import * as path from 'node:path';

import {
  type AgentCommands,
  type ContentPart,
  type ToolDefinition,
  type ToolResult,
} from '@moonshot-ai/agent-core';

import type { OsHost } from '#/features/os/host/types';
import { renderPrompt } from '#/features/os/text/render-prompt';

import type { MediaStore } from '../store';
import type { ImageLimits } from '../state/configSection';
import { MEDIA_SNIFF_BYTES, detectFileType, sniffImageDimensions } from '../inspect/file-type';
import {
  MAX_IMAGE_DECODE_BYTES,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  isRecodableImage,
  type ImageCropRegion,
} from '../transform/compress';
import {
  buildImageConversionGuidance,
  buildOversizedImageConversionGuidance,
  isModelAcceptedImageMime,
  providerImagePolicy,
} from '../inspect/format-policy';
import DESCRIPTION from '../read-media.md?raw';

export const READ_MEDIA_FILE_TOOL_NAME = 'ReadMediaFile';
export const MAX_MEDIA_MEGABYTES = 100;
export const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

export const READ_MEDIA_HOST_UNAVAILABLE =
  'ReadMediaFile cannot read local files: no OS host filesystem is configured for this session.';

export interface CreateReadMediaFileToolProps {
  readonly store: MediaStore;
  readonly workDir: string;
  readonly agent: AgentCommands;
  readonly limits: () => ImageLimits;
  readonly host?: OsHost;
}

interface ReadMediaArgs {
  readonly path: string;
  readonly region?: ImageCropRegion;
  readonly fullResolution?: boolean;
}

interface ImageDelivery {
  readonly kind: 'untouched' | 'downsampled' | 'crop' | 'full';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly region?: ImageCropRegion;
  readonly resized?: boolean;
}

function parseArgs(raw: string | null): { args: ReadMediaArgs } | { error: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: `invalid ReadMediaFile arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: `invalid ReadMediaFile arguments: ${raw}` };
  }
  const { path: pathArg, region, full_resolution } = parsed as {
    path?: unknown;
    region?: unknown;
    full_resolution?: unknown;
  };
  if (typeof pathArg !== 'string' || pathArg.trim() === '') {
    return { error: 'File path cannot be empty.' };
  }
  let parsedRegion: ImageCropRegion | undefined;
  if (region !== undefined) {
    if (typeof region !== 'object' || region === null) {
      return { error: `invalid ReadMediaFile arguments: ${raw}` };
    }
    const { x, y, width, height } = region as Record<string, unknown>;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      return { error: `invalid ReadMediaFile arguments: ${raw}` };
    }
    parsedRegion = { x, y, width, height };
  }
  if (full_resolution !== undefined && typeof full_resolution !== 'boolean') {
    return { error: `invalid ReadMediaFile arguments: ${raw}` };
  }
  return {
    args: {
      path: pathArg,
      region: parsedRegion,
      fullResolution: full_resolution === true ? true : undefined,
    },
  };
}

function buildMediaNote(input: {
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly delivery?: ImageDelivery;
}): string {
  const parts: string[] = [
    `Read ${input.kind} file.`,
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
  ];
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
    );
  }
  const delivery = input.delivery;
  if (delivery?.kind === 'downsampled') {
    parts.push(
      `The attached image was downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels ` +
        `(${delivery.mimeType}, ${formatByteSize(delivery.byteLength)}) to fit model limits; ` +
        'fine detail may be lost.',
      'To inspect fine detail, call ReadMediaFile again with the region parameter ' +
        '(original-image pixel coordinates) to view a crop at full fidelity.',
    );
  } else if (delivery?.kind === 'crop' && delivery.region) {
    const { x, y, width, height } = delivery.region;
    parts.push(
      `Showing region (x=${String(x)}, y=${String(y)}, width=${String(width)}, height=${String(height)}) ` +
        `of the original image${
          delivery.resized === true
            ? `, downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels`
            : ' at native resolution'
        }.`,
      'To output coordinates in original-image pixels, locate them within this crop and add ' +
        `the region offset (x=${String(x)}, y=${String(y)}).`,
    );
  } else if (delivery?.kind === 'full') {
    parts.push('Shown at native resolution; no downscaling applied.');
  }
  if (input.kind === 'image' && input.dimensions && delivery?.kind !== 'crop') {
    parts.push(
      'If you need to output coordinates, output relative coordinates first ' +
        'and compute absolute coordinates using the original image size.',
    );
  }
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

function buildImageDeliveryLimitError(input: {
  readonly finalBytes: number;
  readonly readByteBudget: number;
  readonly maxEdge: number;
}): string {
  return (
    `Image is too large to send safely after compression (${String(input.finalBytes)} bytes; ` +
    `limit ${String(input.readByteBudget)} bytes and ${String(input.maxEdge)}px on the longest edge). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
    'then call ReadMediaFile on the smaller copy.'
  );
}

function buildImageDecodeLimitError(finalBytes: number): string {
  return (
    `Image is too large to process safely for region or full_resolution (${String(finalBytes)} bytes; ` +
    `safe decode limit ${String(MAX_IMAGE_DECODE_BYTES)} bytes). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
    'region into a separate image, then call ReadMediaFile on the resulting file.'
  );
}

function buildFullResolutionLimitError(
  path: string,
  finalBytes: number,
  inlineByteBudget: number,
): string {
  return (
    `"${path}" is ${String(finalBytes)} bytes (${formatByteSize(finalBytes)}), ` +
    `over the ${String(inlineByteBudget)}-byte (${formatByteSize(inlineByteBudget)}) ` +
    'per-image limit, so full_resolution cannot be honored. ' +
    'Use region to view a crop at full fidelity instead.'
  );
}

export function createReadMediaFileTool(
  props: CreateReadMediaFileToolProps,
): ToolDefinition {
  return {
    name: READ_MEDIA_FILE_TOOL_NAME,
    description: renderPrompt(DESCRIPTION, { MAX_MEDIA_MEGABYTES }),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to an image or video file. Relative paths resolve against the working directory; ' +
            'a path outside the working directory must be absolute. ' +
            'Directories and text files are not supported.',
        },
        region: {
          type: 'object',
          properties: {
            x: {
              type: 'integer',
              minimum: 0,
              description: 'Left edge of the crop, in original-image pixels.',
            },
            y: {
              type: 'integer',
              minimum: 0,
              description: 'Top edge of the crop, in original-image pixels.',
            },
            width: {
              type: 'integer',
              minimum: 1,
              description: 'Crop width, in original-image pixels.',
            },
            height: {
              type: 'integer',
              minimum: 1,
              description: 'Crop height, in original-image pixels.',
            },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
          description:
            'Images only: view just this rectangle of the image (original-image pixel coordinates). ' +
            'Use after a downsampled full view to inspect fine detail — a region within the size ' +
            'limits is delivered at full fidelity.',
        },
        full_resolution: {
          type: 'boolean',
          description:
            'Images only: skip the default downscaling and view at native resolution. Fails with an ' +
            'explicit error when the payload would exceed the per-image byte limit; use region for ' +
            'files that large.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute({ toolCall }): Promise<ToolResult> {
      const parsed = parseArgs(toolCall.arguments);
      if ('error' in parsed) {
        return { content: [{ type: 'text', text: parsed.error }], isError: true };
      }
      const args = parsed.args;
      const host = props.host;
      if (host === undefined) {
        return { content: [{ type: 'text', text: READ_MEDIA_HOST_UNAVAILABLE }], isError: true };
      }
      await host.environment.ready;
      const filePath = path.resolve(props.workDir, args.path);
      const model = props.agent.model?.spec;
      const providerType = model?.provider;
      try {
        const header = await host.fs.readBytes(filePath, MEDIA_SNIFF_BYTES);
        const fileType = detectFileType(filePath, header, 'media');
        if (fileType.kind === 'text') {
          return {
            content: [
              {
                type: 'text',
                text: `"${args.path}" is a text file. Use Read to read text files.`,
              },
            ],
            isError: true,
          };
        }
        if (fileType.kind === 'unknown') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `"${args.path}" is not a supported image or video file. ` +
                  'Use Read for text files, or Bash or an MCP tool for other binary formats.',
              },
            ],
            isError: true,
          };
        }
        if (fileType.kind === 'image' && model?.capability?.image_in !== true) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'The current model does not support image input. ' +
                  'Tell the user to use a model with image input capability.',
              },
            ],
            isError: true,
          };
        }
        if (
          fileType.kind === 'image' &&
          !isModelAcceptedImageMime(fileType.mimeType, providerType)
        ) {
          return {
            content: [
              {
                type: 'text',
                text: buildImageConversionGuidance(
                  filePath,
                  fileType.mimeType,
                  host.environment.osKind,
                ),
              },
            ],
            isError: true,
          };
        }
        if (fileType.kind === 'video' && model?.capability?.video_in !== true) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'The current model does not support video input. ' +
                  'Tell the user to use a model with video input capability.',
              },
            ],
            isError: true,
          };
        }
        const stat = await host.fs.stat(filePath);
        if (stat.size === 0) {
          return { content: [{ type: 'text', text: `"${args.path}" is empty.` }], isError: true };
        }
        if (stat.size > MAX_MEDIA_BYTES) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `"${args.path}" is ${String(stat.size)} bytes, which exceeds the ` +
                  `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
              },
            ],
            isError: true,
          };
        }
        if (fileType.kind === 'video' && (args.region !== undefined || args.fullResolution === true)) {
          return {
            content: [
              { type: 'text', text: 'region and full_resolution apply only to image files.' },
            ],
            isError: true,
          };
        }
        if (
          fileType.kind === 'image' &&
          stat.size > MAX_IMAGE_DECODE_BYTES &&
          (args.region !== undefined || args.fullResolution === true)
        ) {
          return {
            content: [{ type: 'text', text: buildImageDecodeLimitError(stat.size) }],
            isError: true,
          };
        }
        const inlineImageByteBudget = providerImagePolicy(providerType).inlineByteBudget;
        if (
          fileType.kind === 'image' &&
          args.region === undefined &&
          args.fullResolution === true &&
          stat.size > inlineImageByteBudget
        ) {
          return {
            content: [
              {
                type: 'text',
                text: buildFullResolutionLimitError(args.path, stat.size, inlineImageByteBudget),
              },
            ],
            isError: true,
          };
        }
        const { readByteBudget, maxEdgePx } = props.limits();
        if (
          fileType.kind === 'image' &&
          args.region === undefined &&
          args.fullResolution !== true &&
          stat.size > MAX_IMAGE_DECODE_BYTES &&
          stat.size > readByteBudget
        ) {
          return {
            content: [
              {
                type: 'text',
                text: buildImageDeliveryLimitError({
                  finalBytes: stat.size,
                  readByteBudget,
                  maxEdge: maxEdgePx,
                }),
              },
            ],
            isError: true,
          };
        }
        const data = await host.fs.readBytes(filePath);
        let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
        let outBytes: Uint8Array = data;
        let outMime = fileType.mimeType;
        let delivery: ImageDelivery | undefined;
        if (fileType.kind === 'image') {
          if (args.region !== undefined) {
            const outcome = await cropImageForModel(data, fileType.mimeType, args.region, {
              skipResize: args.fullResolution === true,
              maxEdge: maxEdgePx,
            });
            if (!outcome.ok) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Cannot read region from "${args.path}": ${outcome.error}`,
                  },
                ],
                isError: true,
              };
            }
            outBytes = outcome.data;
            outMime = outcome.mimeType;
            delivery = {
              kind: 'crop',
              width: outcome.width,
              height: outcome.height,
              byteLength: outcome.finalByteLength,
              mimeType: outcome.mimeType,
              region: outcome.region,
              resized: outcome.resized,
            };
            dimensions = { width: outcome.originalWidth, height: outcome.originalHeight };
          } else if (args.fullResolution === true) {
            if (data.length > inlineImageByteBudget) {
              return {
                content: [
                  {
                    type: 'text',
                    text: buildFullResolutionLimitError(
                      args.path,
                      data.length,
                      inlineImageByteBudget,
                    ),
                  },
                ],
                isError: true,
              };
            }
            delivery = {
              kind: 'full',
              width: dimensions?.width ?? 0,
              height: dimensions?.height ?? 0,
              byteLength: data.length,
              mimeType: fileType.mimeType,
            };
          } else {
            const inlineOnly = !isRecodableImage(data, fileType.mimeType);
            const compressed = await compressImageForModel(data, fileType.mimeType, {
              byteBudget: readByteBudget,
              maxEdge: maxEdgePx,
            });
            if (inlineOnly) {
              const inlineLimit = Math.max(readByteBudget, inlineImageByteBudget);
              if (compressed.finalByteLength > inlineLimit) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: buildOversizedImageConversionGuidance(
                        filePath,
                        fileType.mimeType,
                        host.environment.osKind,
                        compressed.finalByteLength,
                        inlineLimit,
                      ),
                    },
                  ],
                  isError: true,
                };
              }
            } else if (
              compressed.finalByteLength > readByteBudget ||
              Math.max(compressed.width, compressed.height) > maxEdgePx
            ) {
              return {
                content: [
                  {
                    type: 'text',
                    text: buildImageDeliveryLimitError({
                      finalBytes: compressed.finalByteLength,
                      readByteBudget,
                      maxEdge: maxEdgePx,
                    }),
                  },
                ],
                isError: true,
              };
            }
            outBytes = compressed.data;
            outMime = compressed.mimeType;
            delivery = {
              kind: compressed.changed ? 'downsampled' : 'untouched',
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            };
            if (compressed.changed) {
              dimensions = { width: compressed.originalWidth, height: compressed.originalHeight };
            }
          }
        }
        const ref = await props.store.put({
          bytes: outBytes,
          mimeType: outMime,
          filename: path.basename(filePath),
        });
        const tag = fileType.kind === 'image' ? 'image' : 'video';
        const mediaPart: ContentPart =
          tag === 'image'
            ? { type: 'image_url', source: { kind: 'store', ref } }
            : { type: 'video_url', source: { kind: 'store', ref } };
        const note = buildMediaNote({
          kind: fileType.kind,
          mimeType: fileType.mimeType,
          byteSize: stat.size,
          dimensions,
          delivery,
        });
        return {
          content: [
            { type: 'text', text: `<${tag} path="${filePath}">` },
            mediaPart,
            { type: 'text', text: `</${tag}>` },
            { type: 'text', text: note },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read ${args.path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
