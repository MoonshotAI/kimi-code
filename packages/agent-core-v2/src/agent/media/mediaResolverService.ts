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
 * fallback. The `video_in` capability gate runs before the memo lookup
 * (mirroring the image strategy), so a switch to a video-incapable model
 * degrades to the tag instead of replaying a memoized upload reference.
 *
 * Image: inlines the bytes as a base64 `data:` `image_url` part — kosong has
 * no image upload channel, so there is no provider reference to persist. The
 * inline part depends only on the immutable upload bytes, not on the
 * requester, so a successful inline is memoized per file id in a private
 * byte-budgeted LRU (per-entry cap plus a total budget; the least-recently
 * hit entries are evicted, and a miss simply re-reads the bytes) and reused
 * across steps, retries, and media-recovery reprojections instead of
 * re-reading and re-encoding the same bytes on every request; the degrade
 * forms are never memoized, so the display path is re-derived through the
 * session media store on every request. The bytes are sniffed
 * (`detectFileType`) and gated against the provider-accepted image formats
 * (`isModelAcceptedImageMime`) as defense in depth —
 * the ingest edges already refuse unaccepted formats. A reference that
 * cannot be inlined (model without `image_in`, unreadable bytes, non-image
 * or unaccepted sniff) degrades to the `<image path>` tag SYNTHESIZED from
 * the store-derived display path so the model keeps a path to re-open; when
 * no canonical copy exists it swaps in an unavailable placeholder text. A
 * message left with no parts at all keeps one placeholder so its content
 * never goes empty.
 *
 * The path offered to the model in any degrade form is derived at request
 * time from the session media store (`ISessionMediaStore`): the canonical
 * copy is located by file id, so a fork or a home relocation never hands the
 * model a dead path. A memoized video tag has its path refreshed on every
 * hit for the same reason.
 *
 * The plain-data state (`resolved`, the video memo) is registered into
 * `agentState` (`IAgentStateService`) and read/written through it. The image
 * memo stays a private field instead: a memoized inline part is a multi-MB
 * base64 string, and the state registry's snapshot/inspect path serializes
 * every registered state in full. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFileService } from '#/app/file/fileService';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { isModelAcceptedImageMime, normalizeImageMime } from './image-format-policy';
import {
  buildMediaPathTag,
  type DaemonFileRef,
  daemonFileRefFromPart,
  matchSingleMediaPathTag,
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
/**
 * A memoized inline image pins its base64 form in the resolver's memory;
 * skip the memo for outsized uploads so a rare huge paste is re-read from
 * disk per request instead of pinning memory. The total budget caps the
 * whole memo — at least eight full-size entries — and once it is exceeded
 * the least-recently hit entries are evicted.
 */
const IMAGE_MEMO_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MEMO_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

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
    this.states.contributeState(mediaResolvedKey);
  }

  private get resolved(): Map<string, ContentPart> {
    return this.states.get(mediaResolvedKey);
  }

  private readonly imageMemo = new Map<string, { part: ContentPart; bytes: number }>();
  private imageMemoBytes = 0;

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
      let sawVideoRef = false;
      for (const part of message.content) {
        const daemonPart = daemonFileRefFromPart(part);
        if (daemonPart === undefined) {
          content.push(part);
          continue;
        }
        sawVideoRef ||= daemonPart.kind === 'video';
        const resolved =
          daemonPart.kind === 'video'
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal)
            : await this.resolveImagePart(daemonPart.ref, requester, signal);
        content.push(resolved);
      }
      // A message whose parts were all dropped keeps one kind-matching
      // placeholder so its content never goes empty.
      out.push({
        ...message,
        content:
          content.length > 0
            ? content
            : [unavailableMediaText(sawVideoRef ? 'video' : 'image')],
      });
      changed = true;
    }
    return changed ? out : messages;
  }

  private displayPath(ref: DaemonFileRef): Promise<string | undefined> {
    return this.mediaStore.resolveDisplayPath(ref.fileId);
  }

  // -------------------------------------------------------------------------
  // Image strategy — inline-only; no provider upload; the inline part itself
  // is memoized per file id, degrade forms are not.
  // -------------------------------------------------------------------------

  private async resolveImagePart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    if (!requester.model.capabilities.image_in) {
      return degradedImage(await this.displayPath(ref));
    }
    // Memo hit: the inline part is requester-independent, so a previous
    // successful resolve is reused without touching the bytes again.
    const cacheKey = `image\0${ref.fileId}`;
    const memoed = this.memoedImage(cacheKey);
    if (memoed !== undefined) return memoed;
    const path = await this.displayPath(ref);

    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      return degradedImage(path);
    }

    const fileType = detectFileType(
      source.filename,
      source.bytes.subarray(0, MEDIA_SNIFF_BYTES),
      'media',
    );
    if (fileType.kind !== 'image') return degradedImage(path);
    if (!isModelAcceptedImageMime(fileType.mimeType)) return degradedImage(path);

    const part: ContentPart = {
      type: 'image_url',
      imageUrl: {
        url: `data:${normalizeImageMime(fileType.mimeType)};base64,${source.bytes.toString('base64')}`,
      },
    };
    if (source.bytes.length <= IMAGE_MEMO_MAX_BYTES) {
      this.memoizeImage(cacheKey, part, source.bytes.length);
    }
    return part;
  }

  private memoedImage(cacheKey: string): ContentPart | undefined {
    const entry = this.imageMemo.get(cacheKey);
    if (entry === undefined) return undefined;
    // A hit refreshes recency (a Map iterates in insertion order).
    this.imageMemo.delete(cacheKey);
    this.imageMemo.set(cacheKey, entry);
    return entry.part;
  }

  private memoizeImage(cacheKey: string, part: ContentPart, bytes: number): void {
    this.imageMemo.set(cacheKey, { part, bytes });
    this.imageMemoBytes += bytes;
    // Evict least-recently hit entries until the total budget holds again.
    for (const [key, entry] of this.imageMemo) {
      if (this.imageMemoBytes <= IMAGE_MEMO_MAX_TOTAL_BYTES) return;
      this.imageMemo.delete(key);
      this.imageMemoBytes -= entry.bytes;
    }
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
    // The capability gate runs before the memo lookup (mirroring the image
    // strategy): an `ms://` part memoized under a video-capable model must
    // not leak to a same-provider model that cannot accept video.
    if (!model.capabilities.video_in) return videoTag(await this.displayPath(ref));
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey = `${ref.fileId}\0${providerKey}`;

    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return this.memoedOutcome(ref, memoed);

    const { part, memoize } = await this.resolveVideoUncached(ref, requester, cacheKey, signal);
    if (memoize) this.resolved.set(cacheKey, part);
    return part;
  }

  private async memoedOutcome(ref: DaemonFileRef, memoed: ContentPart): Promise<ContentPart> {
    if (memoed.type !== 'text') return memoed;
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
      const canonical = await this.mediaStore.read(ref.fileId);
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

function degradedImage(path: string | undefined): ContentPart {
  if (path === undefined) return unavailableMediaText('image');
  return { type: 'text', text: buildMediaPathTag('image', path) };
}

function unavailableMediaText(kind: 'image' | 'video'): ContentPart {
  return { type: 'text', text: kind === 'video' ? VIDEO_UNAVAILABLE_TEXT : IMAGE_UNAVAILABLE_TEXT };
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
