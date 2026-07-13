/**
 * ReadMediaFileTool — read image/video files as multi-modal content.
 *
 * Returns a 3-part wrap as `output`:
 * `[TextPart('<image|video path="…">'), ImageContent|VideoContent,
 *   TextPart('</image|video>')]`
 * plus a `note` side channel (rendered to the model, never to UIs), and
 * adapts its description and per-call behavior to the model's
 * `image_in` / `video_in` capability.
 *
 * The note — this tool wraps it in a `<system>` block as its own wording
 * choice — summarizes mime type, byte size and (for images) original pixel
 * dimensions, states exactly how the image was delivered (untouched,
 * downsampled, cropped, or native resolution) so compression is never
 * silent, guides the model to derive absolute coordinates from the original
 * size, and reminds it to re-read any media it generates or edits.
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

import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { ContentPart, VideoURLPart } from '#/app/llmProtocol/message';
import type { VideoUploadInput as ProviderVideoUploadInput } from '#/app/llmProtocol/request';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { z } from 'zod';

import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import {
  MEDIA_SNIFF_BYTES,
  detectFileType,
  sniffImageDimensions,
} from '#/agent/media/file-type';
import {
  IMAGE_BYTE_BUDGET,
  resolveReadImageByteBudget,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  type ImageCompressionTelemetry,
  type ImageCropRegion,
} from '#/agent/media/image-compress';
import {
  buildImageConversionGuidance,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
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

/**
 * How the image payload placed after the summary relates to the file on disk.
 * Reported verbatim so the model always knows when it is looking at a
 * degraded copy (and how to get the detail back) — silent downsampling reads
 * as "the image is just blurry" and quietly degrades the model's work.
 */
interface ImageDelivery {
  readonly kind: 'untouched' | 'downsampled' | 'crop' | 'full';
  /** Pixel size of the payload actually sent; 0 when unknown. */
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
  /** The crop actually applied (clamped), for kind 'crop'. */
  readonly region?: ImageCropRegion;
  /** For kind 'crop': the crop was additionally downscaled to fit budgets. */
  readonly resized?: boolean;
}

/**
 * Build the media summary returned as the tool result's `note` (model-only
 * side channel). The `<system>` wrapping is this tool's wording choice; the
 * note channel itself adds nothing.
 *
 * Carries mime type, byte size and (for images) the original pixel
 * dimensions, plus the delivery note above. When the dimensions are known it
 * also guides the model to derive absolute coordinates from that original
 * size (crops get offset-mapping guidance instead); it always reminds the
 * model to re-read any media it generates or edits.
 */
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

// ── Implementation ───────────────────────────────────────────────────

export class ReadMediaFileTool implements BuiltinTool<ReadMediaFileInput> {
  readonly name = 'ReadMediaFile' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMediaFileInputSchema);
  private readonly compressTelemetry: ImageCompressionTelemetry | undefined;
  constructor(
    private readonly fs: IHostFileSystem,
    private readonly env: IHostEnvironment,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly videoUploader?: VideoUploader,
    telemetry?: ITelemetryService,
  ) {
    this.description = buildDescription(capabilities);
    this.compressTelemetry =
      telemetry === undefined ? undefined : { client: telemetry, source: 'read_media' };
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
      // Formats outside the provider-accepted set (AVIF, HEIC, BMP, TIFF,
      // ICO, …) must never reach the model: once the image_url lands in the
      // history every subsequent request in the session is rejected. Refuse
      // with a conversion command for the execution environment instead —
      // the model can run it through Bash (under the normal permission flow)
      // and read the converted file. The accepted set and guidance live in
      // media/image-format-policy, the single source of truth every
      // ingestion point shares.
      if (fileType.kind === 'image' && !isModelAcceptedImageMime(fileType.mimeType)) {
        return {
          isError: true,
          output: buildImageConversionGuidance(args.path, fileType.mimeType, this.env.osKind),
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
      // The summary always reports the ORIGINAL pixel size and byte size: the
      // model derives relative coordinates and scales them by the original
      // dimensions, so it must see the pre-compression size even when the
      // image_url below carries a downsampled copy.
      let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
      let mediaPart: ContentPart;
      let delivery: ImageDelivery | undefined;
      if (fileType.kind === 'image') {
        if (args.region !== undefined) {
          // Explicit crop: read a rectangle of the original back, typically at
          // full fidelity, so a prior downsampled view can be zoomed into.
          const outcome = await cropImageForModel(data, fileType.mimeType, args.region, {
            skipResize: args.full_resolution === true,
            telemetry: this.compressTelemetry,
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
          // The decode is authoritative: it covers formats and nonconforming
          // EXIF the header sniff cannot read, and region coordinates live
          // in the decoded space, so the note must report it.
          dimensions = { width: outcome.originalWidth, height: outcome.originalHeight };
        } else if (args.full_resolution === true) {
          // Native resolution on request — but the provider's per-image byte
          // ceiling is a hard limit, so refuse explicitly rather than degrade.
          // Exact byte counts accompany the rounded sizes: a file a hair over
          // budget would otherwise read "is 3.8 MB, over the 3.8 MB limit".
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
          // Shrink oversized images so a large screenshot neither wastes context
          // tokens nor trips the provider's per-image byte ceiling. Model-read
          // images get the much tighter read budget: they accumulate in the
          // request body on every turn, and detail stays reachable through the
          // region readback (which ignores the budget). Best effort: on any
          // failure compressImageForModel returns the original bytes, so the
          // read still succeeds with the uncompressed image.
          const compressed = await compressImageForModel(data, fileType.mimeType, {
            byteBudget: resolveReadImageByteBudget(),
            telemetry: this.compressTelemetry,
          });
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
          if (compressed.changed) {
            // Same as the crop path: once a decode happened, its dimensions
            // are authoritative over the header sniff.
            dimensions = { width: compressed.originalWidth, height: compressed.originalHeight };
          }
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

      const note = buildMediaNote({
        kind: fileType.kind,
        mimeType: fileType.mimeType,
        byteSize: stat.size,
        dimensions,
        delivery,
      });

      const output: ContentPart[] = [
        { type: 'text', text: openText },
        mediaPart,
        { type: 'text', text: closeText },
      ];

      return { output, note, isError: false };
    } catch (error) {
      return {
        isError: true,
        output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
