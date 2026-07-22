/**
 * `media` domain (L4) — `IAgentVideoResolverService` implementation.
 *
 * Resolves each `kimi-file://` video reference in the projected wire messages
 * to a provider-acceptable part right before the request leaves for the wire.
 * Reads the uploaded bytes through the `file` domain (`IFileService`), uploads
 * them through the bound model's `ModelRequester.uploadVideo` (wrapped for
 * `video_upload` telemetry through `createVideoUploader`), and persists the
 * `(file, provider) → llmFileId` mapping through the `blobStore`
 * access-pattern store so the upload happens once across a turn's steps,
 * retries, and media-recovery reprojections. Falls back to an inline base64
 * `video_url` (protocols that carry it) or a `<video path>` text tag (the
 * model then opens the edge-materialized copy with `ReadMediaFile`); auth
 * failures surface so they drive credential refresh instead of masking a bad
 * token, and an upload interrupted by the step's aborted signal re-throws —
 * shape-agnostic, since abort rejections vary by provider — so cancellation
 * ends the request instead of memoizing a degraded fallback for the rest of
 * the agent's lifetime. Resolution outcomes are memoized per (file, provider)
 * for step/retry stability — except a transient upload failure, which
 * degrades only the current request to the tag form so a later step retries
 * the upload instead of freezing the fallback. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IFileService } from '#/app/file/fileService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { type KimiFileRef, isKimiFileUrl, parseKimiFileUrl } from './kimiFileUrl';
import { createVideoUploader } from './registerMediaTools';
import {
  inlineVideoPart,
  inlineVideoSupportedForProtocol,
  isVideoUploadAuthError,
  isVideoUploadUnsupportedError,
} from './videoUpload';
import { IAgentVideoResolverService } from './videoResolver';

const CACHE_SCOPE = 'video-upload-cache';
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIDEO_UNAVAILABLE_TEXT =
  '[video omitted: the uploaded file is no longer available]';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class AgentVideoResolverService implements IAgentVideoResolverService {
  declare readonly _serviceBrand: undefined;

  private readonly resolved = new Map<string, ContentPart>();

  constructor(
    @IFileService private readonly files: IFileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]> {
    if (!messages.some(hasKimiFileVideoPart)) return messages;

    let changed = false;
    const out: Message[] = [];
    for (const message of messages) {
      if (!hasKimiFileVideoPart(message)) {
        out.push(message);
        continue;
      }
      const content: ContentPart[] = [];
      for (const part of message.content) {
        const ref =
          part.type === 'video_url' ? parseKimiFileUrl(part.videoUrl.url) : undefined;
        content.push(ref === undefined ? part : await this.resolvePart(ref, requester, signal));
      }
      out.push({ ...message, content });
      changed = true;
    }
    return changed ? out : messages;
  }

  private async resolvePart(
    ref: KimiFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey = `${ref.fileId}\0${providerKey}`;

    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return memoed;

    const { part, memoize } = await this.resolveUncached(ref, requester, cacheKey, signal);
    if (memoize) this.resolved.set(cacheKey, part);
    return part;
  }

  private async resolveUncached(
    ref: KimiFileRef,
    requester: ModelRequester,
    cacheKey: string,
    signal: AbortSignal | undefined,
  ): Promise<{ part: ContentPart; memoize: boolean }> {
    const cachedLlmFileId = await this.readCachedUpload(cacheKey);
    if (cachedLlmFileId !== undefined) {
      return {
        part: { type: 'video_url', videoUrl: { url: `ms://${cachedLlmFileId}`, id: cachedLlmFileId } },
        memoize: true,
      };
    }

    let bytes: Buffer;
    let filename: string;
    try {
      const file = await this.files.get(ref.fileId);
      bytes = await readStream(file.stream());
      filename = file.meta.name;
    } catch {
      return { part: tag(ref), memoize: true };
    }

    const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind !== 'video') return { part: tag(ref), memoize: true };
    const mimeType = fileType.mimeType;

    const model = requester.model;
    if (!model.capabilities.video_in) return { part: tag(ref), memoize: true };
    const inlineSupported = inlineVideoSupportedForProtocol(model.protocol);

    const uploader = createVideoUploader(requester, {
      client: this.telemetry,
      props: {
        model: model.name,
        provider_type: model.providerType ?? model.protocol,
        protocol: model.protocol,
      },
    });
    if (uploader === undefined) {
      return {
        part: inlineSupported ? inlineVideoPart(bytes, mimeType) : tag(ref),
        memoize: true,
      };
    }

    try {
      const uploaded = await uploader({ data: bytes, mimeType, filename }, { signal });
      const llmFileId = uploaded.videoUrl.id ?? msFileIdFromUrl(uploaded.videoUrl.url);
      if (llmFileId !== undefined) await this.writeCachedUpload(cacheKey, llmFileId);
      return { part: uploaded, memoize: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isVideoUploadAuthError(error)) throw error;
      if (isVideoUploadUnsupportedError(error)) {
        return {
          part: inlineSupported ? inlineVideoPart(bytes, mimeType) : tag(ref),
          memoize: true,
        };
      }
      return { part: tag(ref), memoize: false };
    }
  }

  private async readCachedUpload(cacheKey: string): Promise<string | undefined> {
    const data = await this.blobs.get(CACHE_SCOPE, blobKey(cacheKey)).catch(() => undefined);
    if (data === undefined) return undefined;
    const llmFileId = textDecoder.decode(data);
    return PROVIDER_ID_RE.test(llmFileId) ? llmFileId : undefined;
  }

  private async writeCachedUpload(cacheKey: string, llmFileId: string): Promise<void> {
    if (!PROVIDER_ID_RE.test(llmFileId)) return;
    await this.blobs.put(CACHE_SCOPE, blobKey(cacheKey), textEncoder.encode(llmFileId)).catch(
      () => undefined,
    );
  }
}

function hasKimiFileVideoPart(message: Message): boolean {
  return message.content.some(
    (part) => part.type === 'video_url' && isKimiFileUrl(part.videoUrl.url),
  );
}

function tag(ref: KimiFileRef): ContentPart {
  if (ref.path === undefined || ref.path.length === 0) {
    return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
  }
  return { type: 'text', text: `<video path="${escapeAttribute(ref.path)}"></video>` };
}

function msFileIdFromUrl(url: string): string | undefined {
  if (!url.startsWith('ms://')) return undefined;
  const id = url.slice('ms://'.length);
  return id.length > 0 ? id : undefined;
}

function blobKey(cacheKey: string): string {
  return createHash('sha256').update(cacheKey).digest('hex');
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentVideoResolverService,
  AgentVideoResolverService,
  InstantiationType.Delayed,
  'media',
);
