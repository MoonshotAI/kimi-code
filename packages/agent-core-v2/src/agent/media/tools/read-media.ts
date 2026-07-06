/**
 * ReadMediaFileTool — read image/video files as multi-modal content.
 *
 * Returns a 4-part wrap:
 * `[TextPart('<system>…</system>'), TextPart('<image|video path="…">'),
 *   ImageContent|VideoContent, TextPart('</image|video>')]`
 * and adapts its description and per-call behavior to the model's
 * `image_in` / `video_in` capability.
 *
 * The leading `<system>` block summarizes mime type, byte size and (for
 * images) original pixel dimensions, states exactly how the image was
 * delivered (untouched, downsampled, cropped, or native resolution) so
 * compression is never silent, guides the model to derive absolute
 * coordinates from the original size, and reminds it to re-read any media
 * it generates or edits.
 *
 * Images support two opt-in delivery controls: `region` cuts a rectangle
 * (original-image pixel coordinates) out of the file so fine detail survives
 * at full fidelity, and `full_resolution` skips the default downscale when
 * the payload fits the per-image byte budget (refusing explicitly when it
 * does not, instead of silently degrading).
 *
 * Path safety: goes through the shared path access resolver used by
 * Read/Write/Edit.
 *
 * Registration is capability-gated by `registerMediaTools`: this tool is
 * only registered when the active model supports image or video input.
 */

import type {
  ContentPart,
  ModelCapability,
  VideoUploadInput as ProviderVideoUploadInput,
  VideoURLPart,
} from '#/app/llmProtocol';
import { z } from 'zod';

import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ToolAccesses } from '#/agent/tool';
import type { BuiltinTool, ExecutableToolResult, ToolExecution } from '#/agent/tool';
import { resolvePathAccessPath } from '#/_base/tools/policies/path-access';
import {
  MEDIA_SNIFF_BYTES,
  detectFileType,
  sniffImageDimensions,
} from '#/_base/tools/support/file-type';
import {
  IMAGE_BYTE_BUDGET,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  type ImageCropRegion,
} from '#/_base/tools/support/image-compress';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/_base/tools/support/rule-match';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { renderPrompt } from '#/_base/utils/render-prompt';
import readMediaDescriptionHead from './read-media.md?raw';

// ── Constants ────────────────────────────────────────────────────────

const MAX_MEDIA_MEGABYTES = 100;
const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

export type VideoUploadInput = ProviderVideoUploadInput;

export type VideoUploader = (input: VideoUploadInput) => Promise<VideoURLPart>;

// ── Input schema ─────────────────────────────────────────────────────

export const ReadMediaFileInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to an image or video file. Relative paths resolve against the working directory; ' +
        'a path outside the working directory must be absolute. ' +
        'Directories and text files are not supported.',
    ),
  region: z
    .object({
      x: z.number().int().min(0).describe('Left edge of the crop, in original-image pixels.'),
      y: z.number().int().min(0).describe('Top edge of the crop, in original-image pixels.'),
      width: z.number().int().min(1).describe('Crop width, in original-image pixels.'),
      height: z.number().int().min(1).describe('Crop height, in original-image pixels.'),
    })
    .optional()
    .describe(
      'Images only: view just this rectangle of the image (original-image pixel coordinates). ' +
        'Use after a downsampled full view to inspect fine detail — a region within the size ' +
        'limits is delivered at full fidelity.',
    ),
  full_resolution: z
    .boolean()
    .optional()
    .describe(
      'Images only: skip the default downscaling and view at native resolution. Fails with an ' +
        'explicit error when the payload would exceed the per-image byte limit; use region for ' +
        'files that large.',
    ),
});

export type ReadMediaFileInput = z.infer<typeof ReadMediaFileInputSchema>;

// ── Tool description (capability-driven) ─────────────────────────────

function buildDescription(capabilities: ModelCapability): string {
  const head = renderPrompt(readMediaDescriptionHead, { MAX_MEDIA_MEGABYTES });
  const lines: string[] = [head];
  const hasImage = capabilities.image_in;
  const hasVideo = capabilities.video_in;
  if (hasImage && hasVideo) {
    lines.push('- This tool supports image and video files for the current model.');
  } else if (hasImage) {
    lines.push(
      '- This tool supports image files for the current model.',
      '- Video files are not supported by the current model.',
    );
  } else if (hasVideo) {
    lines.push(
      '- This tool supports video files for the current model.',
      '- Image files are not supported by the current model.',
    );
  } else {
    lines.push('- The current model does not support image or video input.');
  }
  return lines.join('\n');
}

// ── System summary ───────────────────────────────────────────────────

interface ImageDelivery {
  readonly kind: 'untouched' | 'downsampled' | 'crop' | 'full';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly region?: ImageCropRegion;
  readonly resized?: boolean;
}

function buildSystemSummary(input: {
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
  // Coordinate guidance is only emitted when the original size is actually
  // known — sniffing fails for some image formats (TIFF/ICO/HEIC/…), and
  // telling the model to use a size that is not in the block would mislead it.
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
    );
  }
  const delivery = input.delivery;
  if (delivery?.kind === 'downsampled') {
    parts.push(
      `The image below was downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels ` +
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

// ── Implementation ───────────────────────────────────────────────────

export class ReadMediaFileTool implements BuiltinTool<ReadMediaFileInput> {
  readonly name = 'ReadMediaFile' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMediaFileInputSchema);
  constructor(
    private readonly fs: IHostFileSystem,
    private readonly env: IHostEnvironment,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly videoUploader?: VideoUploader,
  ) {
    this.description = buildDescription(capabilities);
  }

  resolveExecution(args: ReadMediaFileInput): ToolExecution {
    // Validate before resolving the path: `resolvePathAccessPath` throws on an
    // empty path, and returning a tool error result here gives the model a
    // clear message instead of an opaque path-security failure.
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading media: ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(
    args: ReadMediaFileInput,
    safePath: string,
  ): Promise<ExecutableToolResult> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }

    try {
      // For media input, the bytes are authoritative; the extension is only
      // a fallback for formats that cannot be sniffed from the header.
      const header = await this.fs.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header, 'media');

      if (fileType.kind === 'text') {
        return {
          isError: true,
          output: `"${args.path}" is a text file. Use Read to read text files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output:
            `"${args.path}" is not a supported image or video file. ` +
            'Use Read for text files, or Bash or an MCP tool for other binary formats.',
        };
      }

      if (fileType.kind === 'image' && !this.capabilities.image_in) {
        return {
          isError: true,
          output:
            'The current model does not support image input. ' +
            'Tell the user to use a model with image input capability.',
        };
      }
      if (fileType.kind === 'video' && !this.capabilities.video_in) {
        return {
          isError: true,
          output:
            'The current model does not support video input. ' +
            'Tell the user to use a model with video input capability.',
        };
      }

      const stat = await this.fs.stat(safePath);
      if (stat.size === 0) {
        return { isError: true, output: `"${args.path}" is empty.` };
      }
      if (stat.size > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          output:
            `"${args.path}" is ${String(stat.size)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
        };
      }

      if (fileType.kind === 'video' && (args.region !== undefined || args.full_resolution === true)) {
        return {
          isError: true,
          output: 'region and full_resolution apply only to image files.',
        };
      }

      const data = Buffer.from(await this.fs.readBytes(safePath));
      let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
      let mediaPart: ContentPart;
      let delivery: ImageDelivery | undefined;
      if (fileType.kind === 'image') {
        if (args.region !== undefined) {
          const outcome = await cropImageForModel(data, fileType.mimeType, args.region, {
            skipResize: args.full_resolution === true,
          });
          if (!outcome.ok) {
            return { isError: true, output: `Cannot read region from "${args.path}": ${outcome.error}` };
          }
          const base64 = Buffer.from(outcome.data).toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${outcome.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: 'crop',
            width: outcome.width,
            height: outcome.height,
            byteLength: outcome.finalByteLength,
            mimeType: outcome.mimeType,
            region: outcome.region,
            resized: outcome.resized,
          };
          dimensions ??= { width: outcome.originalWidth, height: outcome.originalHeight };
        } else if (args.full_resolution === true) {
          if (data.length > IMAGE_BYTE_BUDGET) {
            return {
              isError: true,
              output:
                `"${args.path}" is ${String(data.length)} bytes (${formatByteSize(data.length)}), ` +
                `over the ${String(IMAGE_BYTE_BUDGET)}-byte (${formatByteSize(IMAGE_BYTE_BUDGET)}) ` +
                'per-image limit, so full_resolution cannot be honored. ' +
                'Use region to view a crop at full fidelity instead.',
            };
          }
          const base64 = data.toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${fileType.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: 'full',
            width: dimensions?.width ?? 0,
            height: dimensions?.height ?? 0,
            byteLength: data.length,
            mimeType: fileType.mimeType,
          };
        } else {
          const compressed = await compressImageForModel(data, fileType.mimeType);
          const base64 = Buffer.from(compressed.data).toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${compressed.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: compressed.changed ? 'downsampled' : 'untouched',
            width: compressed.width,
            height: compressed.height,
            byteLength: compressed.finalByteLength,
            mimeType: compressed.mimeType,
          };
        }
      } else if (this.videoUploader !== undefined) {
        mediaPart = await this.videoUploader({
          data,
          mimeType: fileType.mimeType,
          filename: safePath.split(/[\\/]/).at(-1),
        });
      } else {
        const base64 = data.toString('base64');
        mediaPart = {
          type: 'video_url',
          videoUrl: { url: `data:${fileType.mimeType};base64,${base64}` },
        };
      }

      const tag = fileType.kind === 'image' ? 'image' : 'video';
      const openText = `<${tag} path="${safePath}">`;
      const closeText = `</${tag}>`;

      const systemText = buildSystemSummary({
        kind: fileType.kind,
        mimeType: fileType.mimeType,
        byteSize: stat.size,
        dimensions,
        delivery,
      });

      const output: ContentPart[] = [
        { type: 'text', text: systemText },
        { type: 'text', text: openText },
        mediaPart,
        { type: 'text', text: closeText },
      ];

      return { output, isError: false };
    } catch (error) {
      return {
        isError: true,
        output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
