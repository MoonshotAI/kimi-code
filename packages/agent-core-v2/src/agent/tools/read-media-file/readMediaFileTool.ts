import { posix as posixPath, win32 as win32Path } from 'pathe';

import { detectTextEncoding, type UtfTextEncoding } from '#/_base/text/encoding';
import type { ContentPart } from '#human/llm/message';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { isTaskOutputFilePath } from '#/agent/task/persist';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { isDaemonFileUrl } from '#/agent/media/mediaRef';
import { attachmentFileSource, environmentFileSource, withAttachmentLocation, type FileReadSource } from '#/agent/tools/fileReadSource';

import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { acquireOrWhenReady, pinnedGeneration, type IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import {
  ToolAccesses,
  type AgentTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import {
  MEDIA_SNIFF_BYTES,
  detectFileType,
  sniffMediaFromMagic,
  sniffImageDimensions,
} from '#/agent/media/file-type';
import {
  MAX_IMAGE_DECODE_BYTES,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  isRecodableImage,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  type ImageCropRegion,
} from '#/agent/media/image-compress';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject, matchesPathRuleSubject } from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MEGABYTES,
  READ_MEDIA_FILE_TOOL_NAME,
  ReadMediaFileInputSchema,
  type ReadMediaFileInput,
} from './read-media-file';
import readMediaDescriptionHead from './read-media.md?raw';

function buildDescription(): string {
  return [
    renderPrompt(readMediaDescriptionHead, { MAX_MEDIA_MEGABYTES }),
    '- This tool supports image, video, and UTF-8/UTF-16 text files.',
  ].join('\n');
}

function encodingName(encoding: UtfTextEncoding): string {
  return encoding === 'utf-8' ? 'UTF-8' : encoding === 'utf-16le' ? 'UTF-16 LE' : 'UTF-16 BE';
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

export class ReadMediaFileTool implements AgentTool<ReadMediaFileInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = READ_MEDIA_FILE_TOOL_NAME;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMediaFileInputSchema);
  private readonly telemetry: ITelemetryService | undefined;
  constructor(
    private readonly environment: IAgentEnvironmentService,
    private readonly workspace: WorkspaceConfig,
    private readonly attachmentStore: ISessionMediaStore,
    telemetry?: ITelemetryService,
    @IAgentToolResultTruncationService private readonly resultTruncation?: IAgentToolResultTruncationService,
    @IHostFileSystem private readonly hostFs?: IHostFileSystem,
    @IHostEnvironment private readonly hostEnvironment?: IHostEnvironment,
    @ISessionContext private readonly session?: ISessionContext,
    @IAgentScopeContext private readonly agent?: IAgentScopeContext,
    @IAgentPlanService private readonly planService?: IAgentPlanService,
  ) {
    this.description = buildDescription();
    this.telemetry = telemetry;
  }

  async resolveExecution(args: ReadMediaFileInput): Promise<ToolExecution> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }
    if (isDaemonFileUrl(args.path)) {
      return this.attachmentExecution(args);
    }
    const planTarget = await this.planService?.resolveFile(args.path, 'read');
    if (planTarget !== undefined) {
      return {
        accesses: ToolAccesses.readFile(planTarget.path),
        description: `Reading: ${args.path}`,
        display: { kind: 'file_io', operation: 'read', path: planTarget.path },
        approvalRule: literalRulePattern(this.name, planTarget.path),
        execute: async ({ signal }) => {
          const current = await this.planService?.resolveFile(planTarget.path, 'read');
          if (current?.path !== planTarget.path) {
            return { isError: true, output: 'The active plan changed before execution. Retry the tool call.' };
          }
          return this.execution(args, environmentFileSource(planTarget.fs, planTarget.path), signal);
        },
      };
    }
    const local = this.localOutputSource(args.path);
    if (local !== undefined) {
      return {
        accesses: ToolAccesses.readFile(args.path),
        description: `Reading: ${args.path}`,
        display: { kind: 'file_io', operation: 'read', path: args.path },
        approvalRule: literalRulePattern(this.name, args.path),
        execute: ({ signal }) => this.execution(args, local, signal),
      };
    }
    const resolutionLease = await acquireOrWhenReady(this.environment, ['fs']);
    try {
      const inspected = resolutionLease.environment;
      const expectedGeneration = pinnedGeneration(inspected);
      const view = new EnvironmentWorkspaceView(inspected, {
        workDir: this.workspace.workspaceDir,
        additionalDirs: this.workspace.additionalDirs,
      });
      const env = view.host;
      const workspace = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
      const path = resolvePathAccessPath(args.path, {
        env,
        shellPathBridge: view.shellPathBridge,
        workspace,
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
            pathClass: env.pathClass,
            homeDir: env.homeDir,
          }),
        execute: async ({ signal }) => {
          const lease = await acquireOrWhenReady(this.environment, ['fs']);
          try {
            if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
              return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
            }
            return await this.execution(args, environmentFileSource(lease.environment.fs!, path), signal);
          } finally {
            lease.dispose();
          }
        },
      };
    } finally {
      resolutionLease.dispose();
    }
  }

  private localOutputSource(path: string): FileReadSource | undefined {
    if (this.hostFs === undefined || this.hostEnvironment === undefined || path.includes('\0')) return undefined;
    const environmentPath = this.hostEnvironment.pathClass === 'win32' ? win32Path : posixPath;
    if (!environmentPath.isAbsolute(path)) return undefined;
    const normalized = environmentPath.normalize(path);
    const taskOutput = this.session !== undefined && this.agent !== undefined && (
      isTaskOutputFilePath(normalized, environmentPath.join(this.session.sessionDir, 'agents', this.agent.agentId), environmentPath) ||
      (this.agent.agentId === 'main' && isTaskOutputFilePath(normalized, this.session.sessionDir, environmentPath))
    );
    if (!taskOutput && !this.resultTruncation?.isSpillFilePath(normalized)) return undefined;
    return environmentFileSource(this.hostFs, normalized);
  }

  private async attachmentExecution(args: ReadMediaFileInput): Promise<ToolExecution> {
    const source = await attachmentFileSource(args.path, this.attachmentStore);
    return {
      accesses: ToolAccesses.readFile(source.localPath ?? args.path),
      description: `Reading media: ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path: source.localPath ?? args.path },
      approvalRule: literalRulePattern(this.name, args.path),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.path),
      execute: async ({ signal }) => withAttachmentLocation(
        await this.execution(args, source, signal), source,
      ),
    };
  }

  private async execution(
    args: ReadMediaFileInput,
    source: FileReadSource,
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }

    try {
      signal?.throwIfAborted();
      const safePath = source.name;
      const header = await source.readBytes(MEDIA_SNIFF_BYTES);
      const fileType = sniffMediaFromMagic(header) ?? detectFileType(safePath, undefined, 'media');

      if (fileType.kind === 'text') {
        if (args.region !== undefined || args.full_resolution === true) {
          return { isError: true, output: 'region and full_resolution apply only to image files.' };
        }
        const stat = await source.stat();
        if (stat.size > 10 * 1024 * 1024) {
          return { isError: true, output: `"${args.path}" exceeds the 10 MiB text limit.` };
        }
        const detection = detectTextEncoding(header);
        if (detection.seemsBinary) {
          return { isError: true, output: `"${args.path}" is not a supported text or media file.` };
        }
        let text: string;
        let lossy = false;
        try {
          text = new TextDecoder(detection.encoding, { fatal: true }).decode(await source.readBytes());
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          text = new TextDecoder(detection.encoding).decode(await source.readBytes());
          lossy = true;
        }
        return {
          output: text,
          note: lossy ? `<system>Malformed ${encodingName(detection.encoding)} bytes were replaced during decoding.</system>` : undefined,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output: `"${args.path}" is not a supported text or media file.`,
        };
      }

      const stat = await source.stat();
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

      if (
        fileType.kind === 'image' &&
        stat.size > MAX_IMAGE_DECODE_BYTES &&
        (args.region !== undefined || args.full_resolution === true)
      ) {
        return {
          isError: true,
          output: buildImageDecodeLimitError(stat.size),
        };
      }

      const imageDeliveryLimits = {
        readByteBudget: resolveReadImageByteBudget(),
        maxEdge: resolveMaxImageEdgePx(),
      };
      if (
        fileType.kind === 'image' &&
        args.region === undefined &&
        args.full_resolution === true &&
        stat.size > imageDeliveryLimits.readByteBudget
      ) {
        return {
          isError: true,
          output: buildFullResolutionLimitError(args.path, stat.size, imageDeliveryLimits.readByteBudget),
        };
      }
      if (
        fileType.kind === 'image' &&
        args.region === undefined &&
        args.full_resolution !== true &&
        stat.size > MAX_IMAGE_DECODE_BYTES &&
        stat.size > imageDeliveryLimits.readByteBudget
      ) {
        return {
          isError: true,
          output: buildImageDeliveryLimitError({
            finalBytes: stat.size,
            ...imageDeliveryLimits,
          }),
        };
      }

      const data = Buffer.from(await source.readBytes());
      let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
      let mediaBytes: Uint8Array;
      let mediaMimeType: string;
      let delivery: ImageDelivery | undefined;
      if (fileType.kind === 'image') {
        if (args.region !== undefined) {
          const outcome = await cropImageForModel(data, fileType.mimeType, args.region, {
            skipResize: args.full_resolution === true,
            telemetry: this.telemetry,
            telemetrySource: 'read_media',
          });
          if (!outcome.ok) {
            return { isError: true, output: `Cannot read region from "${args.path}": ${outcome.error}` };
          }
          mediaBytes = outcome.data;
          mediaMimeType = outcome.mimeType;
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
        } else if (args.full_resolution === true) {
          if (data.length > imageDeliveryLimits.readByteBudget) {
            return {
              isError: true,
              output: buildFullResolutionLimitError(
                args.path,
                data.length,
                imageDeliveryLimits.readByteBudget,
              ),
            };
          }
          mediaBytes = data;
          mediaMimeType = fileType.mimeType;
          delivery = {
            kind: 'full',
            width: dimensions?.width ?? 0,
            height: dimensions?.height ?? 0,
            byteLength: data.length,
            mimeType: fileType.mimeType,
          };
        } else {
          const { readByteBudget, maxEdge } = imageDeliveryLimits;
          const inlineOnly = !isRecodableImage(data, fileType.mimeType);
          const compressed = await compressImageForModel(data, fileType.mimeType, {
            byteBudget: readByteBudget,
            maxEdge,
            telemetry: this.telemetry,
            telemetrySource: 'read_media',
          });
          if (
            !inlineOnly &&
            (compressed.finalByteLength > readByteBudget ||
              Math.max(compressed.width, compressed.height) > maxEdge)
          ) {
            return {
              isError: true,
              output: buildImageDeliveryLimitError({
                finalBytes: compressed.finalByteLength,
                readByteBudget,
                maxEdge,
              }),
            };
          }
          mediaBytes = compressed.data;
          mediaMimeType = compressed.mimeType;
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
      } else {
        mediaBytes = data;
        mediaMimeType = fileType.mimeType;
      }

      const reference = await this.attachmentStore.put({
        bytes: mediaBytes,
        mimeType: mediaMimeType,
        filename: safePath.split(/[\\/]/).at(-1) ?? safePath,
        signal,
      });
      const mediaPart: ContentPart =
        fileType.kind === 'image'
          ? { type: 'image_url', imageUrl: { url: reference } }
          : { type: 'video_url', videoUrl: { url: reference } };
      const tag = fileType.kind === 'image' ? 'image' : 'video';
      const tagPath = isDaemonFileUrl(args.path) ? args.path : safePath;
      const openText = `<${tag} path="${tagPath}">`;
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

      signal?.throwIfAborted();
      return { output, note, isError: false };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        isError: true,
        output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
