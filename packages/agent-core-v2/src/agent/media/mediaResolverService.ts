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
 * `<video path>` text tag (the model then opens the session-materialized copy
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
 * The path offered to the model in any degrade form — a persisted claimed
 * tag refreshed in place, or a synthesized tag — is resolved through the
 * session media store (`ISessionMediaStore`): the session-canonical copy
 * wins when it exists, the reference's persisted snapshot path is the
 * fallback, so a fork or a home relocation never hands the model a dead
 * path. A reference claimed by a persisted tag leaves only that refreshed
 * tag behind (video degrades included — a claimed reference never produces
 * a second tag), and a memoized video tag has its path refreshed on every
 * hit for the same reason.
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
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { isModelAcceptedImageMime, normalizeImageMime } from './image-format-policy';
import {
  buildMediaPathTag,
  claimingRefIndex,
  type DaemonFileRef,
  daemonFileRefFromPart,
  type MediaPathTagPairing,
  matchSingleMediaPathTag,
  pairMediaPathTagRefs,
} from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';
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
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
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
        if (part.type === 'text' && pairing.claimedTagIndices.has(index)) {
          content.push(await this.refreshClaimedTag(message.content, pairing, index));
          continue;
        }
        const daemonPart = daemonFileRefFromPart(part);
        if (daemonPart === undefined) {
          content.push(part);
          continue;
        }
        const claimed = pairing.claimedPathByRefIndex.has(index);
        const resolved =
          daemonPart.kind === 'video'
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal, claimed)
            : await this.resolveImagePart(daemonPart.ref, requester, signal, claimed);
        if (resolved !== undefined) content.push(resolved);
      }
      out.push({ ...message, content: content.length > 0 ? content : [unavailableImageText()] });
      changed = true;
    }
    return changed ? out : messages;
  }

  private displayPath(ref: DaemonFileRef): Promise<string | undefined> {
    return this.mediaStore.resolveDisplayPath(ref.fileId, ref.path);
  }

  private async refreshClaimedTag(
    parts: readonly ContentPart[],
    pairing: MediaPathTagPairing,
    tagIndex: number,
  ): Promise<ContentPart> {
    const part = parts[tagIndex]!;
    if (part.type !== 'text') return part;
    const tag = matchSingleMediaPathTag(part.text);
    const refIndex = tag === undefined ? undefined : claimingRefIndex(pairing, tagIndex);
    const daemonPart = refIndex === undefined ? undefined : daemonFileRefFromPart(parts[refIndex]!);
    if (tag === undefined || daemonPart === undefined) return part;
    const path = await this.displayPath(daemonPart.ref);
    if (path === undefined || path === tag.path) return part;
    return { type: 'text', text: buildMediaPathTag(tag.kind, path) };
  }

  // -------------------------------------------------------------------------
  // Image strategy — inline-only; no provider upload, no memoization.
  // -------------------------------------------------------------------------

  private async resolveImagePart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
    hasAdjacentPathTag: boolean,
  ): Promise<ContentPart | undefined> {
    const path = await this.displayPath(ref);
    if (!requester.model.capabilities.image_in) return degradedImage(hasAdjacentPathTag, path);

    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      return degradedImage(hasAdjacentPathTag, path);
    }

    const fileType = detectFileType(
      source.filename,
      source.bytes.subarray(0, MEDIA_SNIFF_BYTES),
      'media',
    );
    if (fileType.kind !== 'image') return degradedImage(hasAdjacentPathTag, path);
    if (!isModelAcceptedImageMime(fileType.mimeType)) return degradedImage(hasAdjacentPathTag, path);

    return {
      type: 'image_url',
      imageUrl: {
        url: `data:${normalizeImageMime(fileType.mimeType)};base64,${source.bytes.toString('base64')}`,
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
    claimed: boolean,
  ): Promise<ContentPart | undefined> {
    const model = requester.model;
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey = `${ref.fileId}\0${providerKey}`;

    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return this.memoedOutcome(ref, memoed, claimed);

    const { part, memoize } = await this.resolveVideoUncached(ref, requester, cacheKey, signal);
    if (part.type === 'text' && claimed) return undefined;
    if (memoize) this.resolved.set(cacheKey, part);
    return part;
  }

  private async memoedOutcome(
    ref: DaemonFileRef,
    memoed: ContentPart,
    claimed: boolean,
  ): Promise<ContentPart | undefined> {
    if (memoed.type !== 'text') return memoed;
    if (claimed) return undefined;
    const tag = matchSingleMediaPathTag(memoed.text);
    if (tag === undefined) return memoed;
    const path = await this.displayPath(ref);
    if (path === undefined || path === tag.path) return memoed;
    return { type: 'text', text: buildMediaPathTag(tag.kind, path) };
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
    const tagPath = await this.displayPath(ref);

    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      return { part: videoTag(tagPath), memoize: true };
    }

    const { bytes, filename } = source;
    const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind !== 'video') return { part: videoTag(tagPath), memoize: true };
    const mimeType = fileType.mimeType;

    const model = requester.model;
    if (!model.capabilities.video_in) return { part: videoTag(tagPath), memoize: true };
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
        part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(tagPath),
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
          part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(tagPath),
          memoize: true,
        };
      }
      return { part: videoTag(tagPath), memoize: false };
    }
  }

  private async readMedia(
    ref: DaemonFileRef,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly bytes: Buffer; readonly filename: string }> {
    try {
      signal?.throwIfAborted();
      const file = await this.files.get(ref.fileId);
      const bytes = await readStream(file.stream(), signal);
      return { bytes, filename: file.meta.name };
    } catch {
      signal?.throwIfAborted();
      const canonical = await this.mediaStore.read(ref.fileId, ref.path);
      if (canonical === undefined) throw new Error(`media ${ref.fileId} is unavailable`);
      return { bytes: Buffer.from(canonical.data), filename: canonical.name };
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

function degradedImage(hasAdjacentPathTag: boolean, path: string | undefined): ContentPart | undefined {
  if (path === undefined) return unavailableImageText();
  if (hasAdjacentPathTag) return undefined;
  return { type: 'text', text: buildMediaPathTag('image', path) };
}

function unavailableImageText(): ContentPart {
  return { type: 'text', text: IMAGE_UNAVAILABLE_TEXT };
}

function videoTag(path: string | undefined): ContentPart {
  if (path === undefined) {
    return { type: 'text', text: VIDEO_UNAVAILABLE_TEXT };
  }
  return { type: 'text', text: buildMediaPathTag('video', path) };
}

function msFileIdFromUrl(url: string): string | undefined {
  if (!url.startsWith('ms://')) return undefined;
  const id = url.slice('ms://'.length);
  return id.length > 0 ? id : undefined;
}

function blobKey(cacheKey: string): string {
  return createHash('sha256').update(cacheKey).digest('hex');
}

async function readStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
  const onAbort = (): void => {
    const reason = signal?.reason instanceof Error ? signal.reason : undefined;
    (stream as NodeJS.ReadableStream & { destroy?(error?: Error): void }).destroy?.(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      chunks.push(Buffer.from(chunk as string | Uint8Array));
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaResolverService,
  AgentMediaResolverService,
  ScopeActivation.OnScopeCreated,
  'media',
);
