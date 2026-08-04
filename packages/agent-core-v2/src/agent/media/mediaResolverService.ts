/**
 * `media` domain — `IAgentMediaResolverService` implementation.
 *
 * Resolves each `kimi-file://` daemon reference in the projected wire
 * messages to a provider-acceptable part right before the request leaves for
 * the wire, so the internal reference never reaches the provider. The
 * referenced bytes are read through the `file` domain (`IFileService`) and
 * the referenced kind is carried by the enclosing content part
 * (`image_url` / `video_url`), so the two kinds resolve through different
 * strategies:
 *
 * Video: uploads the bytes through the bound model's
 * `ModelRequester.uploadVideo` (wrapped for `video_upload` telemetry through
 * `createVideoUploader`) and persists the `(file, provider) → llmFileId`
 * mapping through the `blobStore` access-pattern store so the upload happens
 * once across a turn's steps, retries, and media-recovery reprojections.
 * Falls back to an inline base64 `video_url` (protocols that carry it) or a
 * `<video path>` text tag (the model then opens the edge-materialized copy
 * with `ReadMediaFile`); auth failures surface so they drive credential
 * refresh instead of masking a bad token, and an upload interrupted by the
 * step's aborted signal re-throws — shape-agnostic, since abort rejections
 * vary by provider — so cancellation ends the request instead of memoizing a
 * degraded fallback for the rest of the agent's lifetime. Resolution
 * outcomes are memoized per (file, provider) for step/retry stability —
 * except a transient upload failure, which degrades only the current request
 * to the tag form so a later step retries the upload instead of freezing the
 * fallback.
 *
 * Image: inlines the bytes as a base64 `data:` `image_url` part — kosong has
 * no image upload channel, so there is nothing to memoize or persist. The
 * bytes are sniffed (`detectFileType`) and gated against the provider-
 * accepted image formats (`isModelAcceptedImageMime`) as defense in depth —
 * the ingest edges already refuse unaccepted formats. A reference that
 * cannot be inlined (model without `image_in`, unreadable bytes, non-image
 * or unaccepted sniff) degrades through the reference's materialization
 * path: DROPPED silently only when the tag+ref pairing
 * (`pairMediaPathTagRefs`, shared with the read-model fold) claims this exact
 * reference — an adjacent standalone `<image path>` tag carrying the same
 * path already conveys it — otherwise the `<image path>` tag is SYNTHESIZED
 * from the reference path so a bare SDK-supplied reference still leaves the
 * model the path to re-open; a reference without a path swaps in an
 * unavailable placeholder text. A message left with no parts at all keeps
 * one placeholder so its content never goes empty.
 *
 * The plain-data state (`resolved`, the video memo) is registered into
 * `agentState` (`IAgentStateService`) and read/written through it. Bound at
 * Agent scope.
 */

import { createHash } from 'node:crypto';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFileService } from '#/app/file/fileService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart, Message } from '#/kosong/contract/message';
import {
  buildMediaPathTag,
  type DaemonFileRef,
  daemonFileRefFromPart,
  pairMediaPathTagRefs,
} from '#/kosong/contract/mediaRef';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { isModelAcceptedImageMime, normalizeImageMime } from './image-format-policy';
import { IAgentMediaResolverService } from './mediaResolver';
import { createVideoUploader } from './registerMediaTools';
import {
  inlineVideoPart,
  inlineVideoSupportedForProtocol,
  isVideoUploadAuthError,
  isVideoUploadUnsupportedError,
} from './videoUpload';

const CACHE_SCOPE = 'video-upload-cache';
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIDEO_UNAVAILABLE_TEXT =
  '[video omitted: the uploaded file is no longer available]';
const IMAGE_UNAVAILABLE_TEXT =
  '[image omitted: the uploaded file is no longer available]';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const mediaResolvedKey = defineState<Map<string, ContentPart>>(
  'media.resolved',
  () => new Map(),
);

export class AgentMediaResolverService implements IAgentMediaResolverService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileService private readonly files: IFileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    this.states.register(mediaResolvedKey);
  }

  private get resolved(): Map<string, ContentPart> {
    return this.states.get(mediaResolvedKey);
  }

  async resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]> {
    if (!messages.some(hasDaemonFileMediaPart)) return messages;

    let changed = false;
    const out: Message[] = [];
    for (const message of messages) {
      if (!hasDaemonFileMediaPart(message)) {
        out.push(message);
        continue;
      }
      const content: ContentPart[] = [];
      // The fold's own pairing decides which references a tag claims: an
      // image degrade may drop the part only when the pairing actually
      // claims THIS reference (an adjacent standalone `<image path>` tag
      // carrying the same path); a bare or unclaimed reference gets the tag
      // synthesized from its path.
      const pairing = pairMediaPathTagRefs(message.content);
      for (const [index, part] of message.content.entries()) {
        const daemonPart = daemonFileRefFromPart(part);
        if (daemonPart === undefined) {
          content.push(part);
          continue;
        }
        const resolved =
          daemonPart.kind === 'video'
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal)
            : await this.resolveImagePart(
                daemonPart.ref,
                requester,
                pairing.claimedPathByRefIndex.has(index),
              );
        if (resolved !== undefined) content.push(resolved);
      }
      out.push({ ...message, content: content.length > 0 ? content : [unavailableImageText()] });
      changed = true;
    }
    return changed ? out : messages;
  }

  // -------------------------------------------------------------------------
  // Image strategy — inline-only; no provider upload, no memoization.
  // -------------------------------------------------------------------------

  private async resolveImagePart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    hasAdjacentPathTag: boolean,
  ): Promise<ContentPart | undefined> {
    if (!requester.model.capabilities.image_in) return degradedImage(ref, hasAdjacentPathTag);

    let bytes: Buffer;
    let filename: string;
    try {
      const file = await this.files.get(ref.fileId);
      bytes = await readStream(file.stream());
      filename = file.meta.name;
    } catch {
      return degradedImage(ref, hasAdjacentPathTag);
    }

    const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind !== 'image') return degradedImage(ref, hasAdjacentPathTag);
    if (!isModelAcceptedImageMime(fileType.mimeType)) return degradedImage(ref, hasAdjacentPathTag);

    return {
      type: 'image_url',
      imageUrl: {
        url: `data:${normalizeImageMime(fileType.mimeType)};base64,${bytes.toString('base64')}`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Video strategy — upload once, memoize, degrade to inline or tag.
  // -------------------------------------------------------------------------

  private async resolveVideoPart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey = `${ref.fileId}\0${providerKey}`;

    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return memoed;

    const { part, memoize } = await this.resolveVideoUncached(ref, requester, cacheKey, signal);
    if (memoize) this.resolved.set(cacheKey, part);
    return part;
  }

  private async resolveVideoUncached(
    ref: DaemonFileRef,
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
      return { part: videoTag(ref), memoize: true };
    }

    const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind !== 'video') return { part: videoTag(ref), memoize: true };
    const mimeType = fileType.mimeType;

    const model = requester.model;
    if (!model.capabilities.video_in) return { part: videoTag(ref), memoize: true };
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
        part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(ref),
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
          part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(ref),
          memoize: true,
        };
      }
      return { part: videoTag(ref), memoize: false };
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

function hasDaemonFileMediaPart(message: Message): boolean {
  return message.content.some((part) => daemonFileRefFromPart(part) !== undefined);
}

/**
 * The degrade form of an unresolvable image reference: `undefined` (drop the
 * part) only when the fold's pairing claims this exact reference (an adjacent
 * standalone `<image path>` tag for the same path stays to convey it),
 * otherwise the tag synthesized from the reference path — so a bare reference
 * still leaves the model the path to re-open — or, when the reference carries
 * no path, the unavailable placeholder.
 */
function degradedImage(ref: DaemonFileRef, hasAdjacentPathTag: boolean): ContentPart | undefined {
  if (ref.path === undefined || ref.path.length === 0) return unavailableImageText();
  if (hasAdjacentPathTag) return undefined;
  return { type: 'text', text: buildMediaPathTag('image', ref.path) };
}

function unavailableImageText(): ContentPart {
  return { type: 'text', text: IMAGE_UNAVAILABLE_TEXT };
}

function videoTag(ref: DaemonFileRef): ContentPart {
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
  IAgentMediaResolverService,
  AgentMediaResolverService,
  ScopeActivation.OnScopeCreated,
  'media',
);
