import { createHash } from 'node:crypto';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable } from '#/_base/utils/abort';
import { defineState } from '#/state/state';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IFileService } from '#/app/file/fileService';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ImageUploadUnsupportedError } from '#/llm-adapter/contract/errors';
import {
  mediaOmissionOf,
  mediaPlaceholderText,
  type ContentPart,
  type MediaPlaceholderReason,
  type Message,
} from '@moonshot-ai/core/llm/message';
import { mediaFileIdOf, mediaUrlOf } from '@moonshot-ai/core/llm/protocol/kit/media';
import { MediaUploadFailedError } from '@moonshot-ai/core/llm/request';
import type { Model } from '#/provider-catalog/model/catalog';
import type { InitializedLlmRequester } from '@moonshot-ai/core/llm/requester';
import { runWithCredentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import {
  imageUploaderFor,
  mediaAcceptsMime,
  mediaAcceptsSource,
  mediaCredentialProvider,
  mediaSupportForRequest,
  supportsLlmUpload,
  uploadFailureCheckFor,
  videoUploaderFor,
  type ImageUploader,
  type MediaKindSupport,
  type MediaPosition,
} from '#/provider-catalog/model/media';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { isDataUrl, isModelAcceptedImageMime, normalizeImageMime } from './image-format-policy';
import {
  buildDaemonFileUrl,
  buildMediaOpenTag,
  buildMediaTag,
  type DaemonFileRef,
  daemonFileRefFromPart,
  matchSingleMediaPathTag,
  type MediaLabel,
  mediaNameOf,
} from './mediaRef';
import { ISessionMediaStore } from './sessionMediaStore';
import { IAgentMediaResolverService } from './mediaResolver';
import { createVideoUploader } from './registerMediaTools';
import {
  inlineVideoPart,
  inlineVideoSupportedForProtocol,
  isMediaUploadAuthError,
  isVideoUploadUnsupportedError,
} from './videoUpload';

const VIDEO_CACHE_SCOPE = 'video-upload-cache';
const IMAGE_CACHE_SCOPE = 'image-upload-cache';
const UPLOAD_STATUS_CHECK_CONCURRENCY = 4;
const UPLOAD_STATUS_CHECK_TIMEOUT_MS = 5_000;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIDEO_UNAVAILABLE_TEXT =
  '[video omitted: the uploaded file is no longer available]';
const IMAGE_UNAVAILABLE_TEXT =
  '[image omitted: the uploaded file is no longer available]';
const IMAGE_MEMO_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MEMO_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const REQUEST_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;
const REQUEST_MEDIA_BUDGET_LOW_BYTES = 10 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const mediaResolvedKey = defineState<Map<string, ContentPart>>(
  'media.resolved',
  () => new Map(),
);

export const mediaBudgetDroppedKey = defineState<Set<string>>(
  'media.budgetDropped',
  () => new Set(),
);

type ResolvedMediaKind = 'image' | 'video';

interface UploadCoords {
  readonly scope: string;
  readonly cacheKey: string;
}

function inlineOnlyUploadKey(coords: UploadCoords): string {
  return `${coords.scope}\0${coords.cacheKey}`;
}

function inlineOnlyUploadBlobKey(cacheKey: string): string {
  return blobKey(`inline-only\0${cacheKey}`);
}

interface MediaBudgetEntry {
  readonly messageIndex: number;
  readonly slotIndex: number;
  readonly key: string;
  readonly kind: ResolvedMediaKind;
  readonly label: MediaLabel;
  readonly bytes: number;
}

export class AgentMediaResolverService implements IAgentMediaResolverService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileService private readonly files: IFileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentEnvironmentBindingService private readonly environmentBinding: IAgentEnvironmentBindingService,
  ) {
    this.states.contributeState(mediaResolvedKey);
    this.states.contributeState(mediaBudgetDroppedKey);
  }

  private get resolved(): Map<string, ContentPart> {
    return this.states.get(mediaResolvedKey);
  }

  private get budgetDropped(): Set<string> {
    return this.states.get(mediaBudgetDroppedKey);
  }

  private readonly imageMemo = new Map<
    string,
    { part: ContentPart; bytes: number; mimeType: string }
  >();
  private imageMemoBytes = 0;
  private readonly imageUploadUnsupported = new Set<string>();
  private readonly uploadCoords = new WeakMap<ContentPart, UploadCoords>();
  private readonly inlineOnlyUploads = new Set<string>();

  async resolve(
    messages: readonly Message[],
    model: Model,
    request: InitializedLlmRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]> {
    const includeLocalPaths = this.environmentBinding.current.environmentId === LOCAL_ENVIRONMENT_ID;
    const described = new Map<string, MediaLabel>();
    const describeMedia = async (fileId: string): Promise<MediaLabel> => {
      const cached = described.get(fileId);
      if (cached !== undefined) return cached;
      const file = await this.mediaStore.open(fileId);
      const details = {
        name: file?.name,
        path: includeLocalPaths
          ? (file === undefined ? await this.mediaStore.resolveDisplayPath(fileId) : file.path)
          : undefined,
      };
      described.set(fileId, details);
      return details;
    };
    const slots: ContentPart[][][] = [];
    const changedMessages = new Set<number>();
    const budgetEntries: MediaBudgetEntry[] = [];
    for (const [messageIndex, message] of messages.entries()) {
      const messageSlots: ContentPart[][] = [];
      slots.push(messageSlots);
      const user = message.role === 'user';
      const position: MediaPosition = message.role === 'tool' ? 'tool_result' : 'content';
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type !== 'image_url' && part.type !== 'video_url') {
          messageSlots.push([part]);
          continue;
        }
        const kind: ResolvedMediaKind = part.type === 'image_url' ? 'image' : 'video';
        const daemonRef = daemonFileRefFromPart(part)?.ref;
        const explicitName = user ? mediaNameOf(part) : undefined;
        const needFile =
          daemonRef !== undefined && (includeLocalPaths || (user && explicitName === undefined));
        const file = needFile ? await describeMedia(daemonRef.fileId) : {};
        const label: MediaLabel = {
          name: user ? explicitName ?? file.name : undefined,
          path: includeLocalPaths ? file.path : undefined,
        };
        const previous = message.content[partIndex - 1];
        const omitted = mediaOmissionOf(part);
        if (omitted !== undefined) {
          messageSlots.push([omittedMediaText(kind, omitted, label)]);
          changedMessages.add(messageIndex);
          continue;
        }
        if (daemonRef === undefined) {
          const entry = inlineMediaBudgetEntry(part, kind, label, messageIndex, messageSlots.length);
          if (entry !== undefined) budgetEntries.push(entry);
          const labelled = user ? labelledMedia(part, kind, label, previous) : [part];
          if (labelled.length !== 1) changedMessages.add(messageIndex);
          messageSlots.push(labelled);
          continue;
        }
        const resolved =
          kind === 'video'
            ? await this.resolveVideoPart(daemonRef, model, request, position, label, signal)
            : await this.resolveImagePart(daemonRef, model, request, position, label, signal);
        budgetEntries.push({
          messageIndex,
          slotIndex: messageSlots.length,
          key: daemonRef.fileId,
          kind,
          label,
          bytes: inlinePartBytes(resolved),
        });
        messageSlots.push(user && resolved.type !== 'text' ? labelledMedia(resolved, kind, label, previous) : [resolved]);
        changedMessages.add(messageIndex);
      }
    }
    this.applyMediaBudget(slots, budgetEntries, changedMessages);
    if (changedMessages.size === 0) return messages;
    return messages.map((message, index) =>
      changedMessages.has(index) ? { ...message, content: slots[index]!.flat() } : message,
    );
  }

  async recoverFailedUploads(
    messages: readonly Message[],
    request: InitializedLlmRequester,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const checkUpload = uploadFailureCheckFor(request);
    if (checkUpload === undefined) return false;
    const uploads = new Map<string, Map<string, UploadCoords>>();
    for (const message of messages) {
      for (const part of message.content) {
        if (part.type !== 'image_url' && part.type !== 'video_url') continue;
        const coords = this.uploadCoords.get(part);
        const id = msFileIdFromUrl(mediaUrlOf(part));
        if (coords === undefined || id === undefined || !PROVIDER_ID_RE.test(id)) continue;
        const coordsByKey = uploads.get(id) ?? new Map<string, UploadCoords>();
        coordsByKey.set(inlineOnlyUploadKey(coords), coords);
        uploads.set(id, coordsByKey);
      }
    }
    if (uploads.size === 0) return false;

    const timeout = AbortSignal.timeout(UPLOAD_STATUS_CHECK_TIMEOUT_MS);
    const probeSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const pending = uploads.entries();
    let recovered = false;
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_STATUS_CHECK_CONCURRENCY, uploads.size) }, async () => {
        for (const [id, coordsByKey] of pending) {
          if (probeSignal.aborted) break;
          const failed = await abortable(checkUpload(id, probeSignal), probeSignal).catch(() => false);
          if (!failed) continue;
          for (const coords of coordsByKey.values()) await this.markUploadInlineOnly(coords);
          recovered = true;
        }
      }),
    );
    signal?.throwIfAborted();
    return recovered;
  }

  private async isUploadInlineOnly(coords: UploadCoords): Promise<boolean> {
    const key = inlineOnlyUploadKey(coords);
    if (this.inlineOnlyUploads.has(key)) return true;
    const inlineOnly = await this.blobs.has(coords.scope, inlineOnlyUploadBlobKey(coords.cacheKey)).catch(() => false);
    if (inlineOnly) this.inlineOnlyUploads.add(key);
    return inlineOnly;
  }

  private async markUploadInlineOnly(coords: UploadCoords): Promise<void> {
    this.inlineOnlyUploads.add(inlineOnlyUploadKey(coords));
    this.resolved.delete(coords.cacheKey);
    await this.blobs.put(coords.scope, inlineOnlyUploadBlobKey(coords.cacheKey), new Uint8Array([1]))
      .catch(() => undefined);
  }

  private trackUploadedMedia(coords: UploadCoords, part: ContentPart): ContentPart {
    this.resolved.set(coords.cacheKey, part);
    this.uploadCoords.set(part, coords);
    return part;
  }

  private applyMediaBudget(
    slots: ContentPart[][][],
    entries: readonly MediaBudgetEntry[],
    changedMessages: Set<number>,
  ): void {
    if (entries.length === 0) return;
    const omit = (entry: MediaBudgetEntry): void => {
      slots[entry.messageIndex]![entry.slotIndex] = [omittedMediaText(entry.kind, 'budget', entry.label)];
      changedMessages.add(entry.messageIndex);
    };
    const dropped = this.budgetDropped;
    const pending = new Map<string, number>();
    for (const entry of entries) {
      if (dropped.has(entry.key)) {
        omit(entry);
        continue;
      }
      pending.set(entry.key, (pending.get(entry.key) ?? 0) + entry.bytes);
    }
    let total = 0;
    for (const bytes of pending.values()) total += bytes;
    if (total <= REQUEST_MEDIA_BUDGET_BYTES) return;

    const droppedNow = new Set<string>();
    for (const [key, bytes] of pending) {
      if (total <= REQUEST_MEDIA_BUDGET_LOW_BYTES) break;
      if (bytes === 0) continue;
      dropped.add(key);
      droppedNow.add(key);
      total -= bytes;
    }
    for (const entry of entries) {
      if (droppedNow.has(entry.key)) omit(entry);
    }
    const hasNoSavedPath = entries.some(
      (entry) => droppedNow.has(entry.key) && entry.label.path === undefined,
    );
    try {
      void this.dispatcher.dispatch(
        new WarningIssued({
          agentId: this.scopeContext.agentId,
          code: 'media-budget-exceeded',
          message:
            `Conversation media exceeded the ${String(REQUEST_MEDIA_BUDGET_BYTES / (1024 * 1024))} MB ` +
            `per-request budget; ${String(droppedNow.size)} older media item(s) were omitted` +
            (hasNoSavedPath ? '.' : ' and remain available at their saved paths.'),
        }),
      );
    } catch {
    }
  }

  private async resolveImagePart(
    ref: DaemonFileRef,
    model: Model,
    request: InitializedLlmRequester,
    position: MediaPosition,
    label: MediaLabel,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const support = mediaSupportForRequest(request, 'image', position);
    if (model.spec.capability?.image_in !== true || support === undefined) {
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'unsupported',
        model: model.spec.name,
      });
      return model.spec.capability?.image_in === true ? degradedImage(label) : unsupportedMedia('image', label);
    }
    const providerKey = model.providerType ?? model.protocol;
    const uploadSupported = support.sources.includes('file') || support.sources.includes('url');
    const uploader =
      !uploadSupported || this.imageUploadUnsupported.has(providerKey)
        ? undefined
        : imageUploaderFor(model, request);
    const inlineKey = `image\0${ref.fileId}`;
    if (uploader === undefined) {
      const memoed = this.memoedImage(inlineKey, model.providerType, support);
      if (memoed !== undefined) return memoed;
      return this.resolveImageUncached(ref, label, model, request, inlineKey, undefined, support, signal);
    }
    const coords: UploadCoords = {
      scope: IMAGE_CACHE_SCOPE,
      cacheKey: `${inlineKey}\0${providerKey}\0${model.protocol}\0${model.endpoint.baseUrl ?? ''}\0${await accountHashFor(model)}`,
    };
    if (await this.isUploadInlineOnly(coords)) {
      const memoed = this.memoedImage(inlineKey, model.providerType, support);
      if (memoed !== undefined) return memoed;
      return this.resolveImageUncached(ref, label, model, request, inlineKey, undefined, support, signal);
    }
    const memoed = this.resolved.get(coords.cacheKey);
    if (memoed?.type === 'image_url' && mediaAcceptsSource(support, memoed)) {
      return this.trackUploadedMedia(coords, memoed);
    }
    const cachedLlmFileId = await this.readCachedUpload(coords.scope, coords.cacheKey);
    if (cachedLlmFileId !== undefined) {
      const part: ContentPart = {
        type: 'image_url',
        imageUrl: { url: `ms://${cachedLlmFileId}`, id: cachedLlmFileId },
      };
      if (mediaAcceptsSource(support, part)) {
        return this.trackUploadedMedia(coords, part);
      }
    }
    return this.resolveImageUncached(ref, label, model, request, inlineKey, { uploader, coords }, support, signal);
  }

  private async resolveImageUncached(
    ref: DaemonFileRef,
    label: MediaLabel,
    model: Model,
    request: InitializedLlmRequester,
    inlineKey: string,
    upload: { readonly uploader: ImageUploader; readonly coords: UploadCoords } | undefined,
    support: MediaKindSupport,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'read_failed',
        model: model.spec.name,
      });
      return degradedImage(label);
    }

    const fileType = detectFileType(
      source.filename,
      source.bytes.subarray(0, MEDIA_SNIFF_BYTES),
      'media',
    );
    const mimeType = normalizeImageMime(fileType.mimeType);
    if (
      fileType.kind !== 'image' ||
      !isModelAcceptedImageMime(mimeType, model.providerType) ||
      !mediaAcceptsMime(support, mimeType)
    ) {
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'invalid',
        model: model.spec.name,
      });
      return degradedImage(label);
    }

    if (upload !== undefined) {
      const uploaded = await this.uploadImagePart(model, request, source, mimeType, upload, support, signal);
      if (uploaded !== undefined) return uploaded;
    }
    if (!support.sources.includes('inline')) return degradedImage(label);

    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${source.bytes.toString('base64')}` },
    };
    if (source.bytes.length <= IMAGE_MEMO_MAX_BYTES) {
      this.memoizeImage(inlineKey, part, source.bytes.length, mimeType);
    }
    return part;
  }

  private async uploadImagePart(
    model: Model,
    request: InitializedLlmRequester,
    source: { readonly bytes: Buffer; readonly filename: string },
    mimeType: string,
    upload: { readonly uploader: ImageUploader; readonly coords: UploadCoords },
    support: MediaKindSupport,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart | undefined> {
    try {
      const uploaded = await runWithCredentialRecovery(
        mediaCredentialProvider(request),
        () =>
          upload.uploader(
            { data: source.bytes, mimeType, filename: source.filename },
            { signal },
          ),
        signal,
      );
      if (!mediaAcceptsSource(support, uploaded)) {
        this.telemetry.track2('media_resolve_fallback', {
          kind: 'image',
          reason: 'upload_failed',
          model: model.spec.name,
        });
        return undefined;
      }
      if (await this.isUploadInlineOnly(upload.coords)) return undefined;
      const llmFileId = mediaFileIdOf(uploaded) ?? msFileIdFromUrl(mediaUrlOf(uploaded));
      if (llmFileId !== undefined) {
        await this.writeCachedUpload(upload.coords.scope, upload.coords.cacheKey, llmFileId);
      }
      return this.trackUploadedMedia(upload.coords, uploaded);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isMediaUploadAuthError(error)) throw error;
      if (error instanceof ImageUploadUnsupportedError) {
        this.imageUploadUnsupported.add(model.providerType ?? model.protocol);
      } else if (error instanceof MediaUploadFailedError) {
        await this.markUploadInlineOnly(upload.coords);
      }
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'upload_failed',
        model: model.spec.name,
      });
      return undefined;
    }
  }

  private memoedImage(
    cacheKey: string,
    providerType: string | undefined,
    support: MediaKindSupport,
  ): ContentPart | undefined {
    const entry = this.imageMemo.get(cacheKey);
    if (entry === undefined) return undefined;
    if (!isModelAcceptedImageMime(entry.mimeType, providerType)) return undefined;
    if (!mediaAcceptsSource(support, entry.part)) return undefined;
    this.imageMemo.delete(cacheKey);
    this.imageMemo.set(cacheKey, entry);
    return entry.part;
  }

  private memoizeImage(
    cacheKey: string,
    part: ContentPart,
    bytes: number,
    mimeType: string,
  ): void {
    const previous = this.imageMemo.get(cacheKey);
    if (previous !== undefined) {
      this.imageMemo.delete(cacheKey);
      this.imageMemoBytes -= previous.bytes;
    }
    this.imageMemo.set(cacheKey, { part, bytes, mimeType });
    this.imageMemoBytes += bytes;
    for (const [key, entry] of this.imageMemo) {
      if (this.imageMemoBytes <= IMAGE_MEMO_MAX_TOTAL_BYTES) return;
      this.imageMemo.delete(key);
      this.imageMemoBytes -= entry.bytes;
    }
  }

  private async resolveVideoPart(
    ref: DaemonFileRef,
    model: Model,
    request: InitializedLlmRequester,
    position: MediaPosition,
    label: MediaLabel,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const support = mediaSupportForRequest(request, 'video', position);
    if (model.spec.capability?.video_in !== true || support === undefined) {
      return model.spec.capability?.video_in === true ? videoTag(label) : unsupportedMedia('video', label);
    }
    const providerKey = model.providerType ?? model.protocol;
    const uploadSupported = support.sources.includes('file') || support.sources.includes('url');
    const uploadable = uploadSupported && supportsLlmUpload(request, 'video');
    const coords: UploadCoords = {
      scope: VIDEO_CACHE_SCOPE,
      cacheKey: uploadable
        ? `${ref.fileId}\0${providerKey}\0${model.protocol}\0${model.endpoint.baseUrl ?? ''}\0${await accountHashFor(model)}`
        : `${ref.fileId}\0${providerKey}`,
    };
    const uploadCache = uploadable && !(await this.isUploadInlineOnly(coords));

    const memoed = this.resolved.get(coords.cacheKey);
    if (memoed !== undefined && (memoed.type === 'text' || mediaAcceptsSource(support, memoed))) {
      if (memoed.type === 'text') return videoTag(label);
      if (memoed.type !== 'video_url') return memoed;
      if (msFileIdFromUrl(memoed.videoUrl.url) === undefined) return memoed;
      if (uploadCache) return this.trackUploadedMedia(coords, memoed);
    }

    const { part, memoize } = await this.resolveVideoUncached(
      ref,
      label,
      model,
      request,
      coords,
      support,
      signal,
      uploadCache,
    );
    if (memoize) this.resolved.set(coords.cacheKey, part);
    return part;
  }

  private async resolveVideoUncached(
    ref: DaemonFileRef,
    label: MediaLabel,
    model: Model,
    request: InitializedLlmRequester,
    coords: UploadCoords,
    support: MediaKindSupport,
    signal: AbortSignal | undefined,
    uploadCache: boolean,
  ): Promise<{ part: ContentPart; memoize: boolean }> {
    if (uploadCache) {
      const cachedLlmFileId = await this.readCachedUpload(coords.scope, coords.cacheKey);
      if (cachedLlmFileId !== undefined) {
        const part: ContentPart = {
          type: 'video_url',
          videoUrl: { url: `ms://${cachedLlmFileId}`, id: cachedLlmFileId },
        };
        if (mediaAcceptsSource(support, part)) {
          return { part: this.trackUploadedMedia(coords, part), memoize: true };
        }
      }
    }
    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      return { part: videoTag(label), memoize: true };
    }

    const { bytes, filename } = source;
    const fileType = detectFileType(filename, bytes.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind !== 'video' || !mediaAcceptsMime(support, fileType.mimeType)) {
      return { part: videoTag(label), memoize: true };
    }
    const mimeType = fileType.mimeType;

    const inlineSupported =
      inlineVideoSupportedForProtocol(model.protocol) && support.sources.includes('inline');
    const uploader = uploadCache
      ? createVideoUploader(videoUploaderFor(model, request), {
          client: this.telemetry,
          props: {
            model: model.spec.name,
            provider_type: model.providerType ?? model.protocol,
            protocol: model.protocol,
          },
        })
      : undefined;
    if (uploader === undefined) {
      return {
        part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(label),
        memoize: true,
      };
    }

    try {
      const uploaded = await runWithCredentialRecovery(
        mediaCredentialProvider(request),
        () => uploader({ data: bytes, mimeType, filename }, { signal }),
        signal,
      );
      if (!mediaAcceptsSource(support, uploaded)) {
        this.telemetry.track2('media_resolve_fallback', {
          kind: 'video',
          reason: 'upload_failed',
          model: model.spec.name,
        });
        return {
          part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(label),
          memoize: true,
        };
      }
      const llmFileId = mediaFileIdOf(uploaded) ?? msFileIdFromUrl(mediaUrlOf(uploaded));
      if (llmFileId !== undefined) await this.writeCachedUpload(coords.scope, coords.cacheKey, llmFileId);
      return { part: this.trackUploadedMedia(coords, uploaded), memoize: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isMediaUploadAuthError(error)) throw error;
      if (error instanceof MediaUploadFailedError) await this.markUploadInlineOnly(coords);
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'video',
        reason: 'upload_failed',
        model: model.spec.name,
      });
      if (error instanceof MediaUploadFailedError || isVideoUploadUnsupportedError(error)) {
        return {
          part: inlineSupported ? inlineVideoPart(bytes, mimeType) : videoTag(label),
          memoize: true,
        };
      }
      return { part: videoTag(label), memoize: false };
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
      const stored = await this.mediaStore.get(buildDaemonFileUrl(ref.fileId), signal);
      if (stored !== undefined) {
        return { bytes: Buffer.from(stored.bytes), filename: stored.filename };
      }
      const canonical = await this.mediaStore.read(ref.fileId);
      if (canonical === undefined) throw new Error(`media ${ref.fileId} is unavailable`);
      return { bytes: Buffer.from(canonical.data), filename: canonical.name };
    }
  }

  private async readCachedUpload(scope: string, cacheKey: string): Promise<string | undefined> {
    const data = await this.blobs.get(scope, blobKey(cacheKey)).catch(() => undefined);
    if (data === undefined) return undefined;
    const llmFileId = textDecoder.decode(data);
    return PROVIDER_ID_RE.test(llmFileId) ? llmFileId : undefined;
  }

  private async writeCachedUpload(
    scope: string,
    cacheKey: string,
    llmFileId: string,
  ): Promise<void> {
    if (!PROVIDER_ID_RE.test(llmFileId)) return;
    await this.blobs.put(scope, blobKey(cacheKey), textEncoder.encode(llmFileId)).catch(
      () => undefined,
    );
  }
}

async function accountHashFor(model: Model): Promise<string> {
  let identity: string | undefined;
  const authorization = model.endpoint.headers?.['Authorization'];
  if (authorization !== undefined) {
    identity = `authorization\0${authorization.trim()}`;
  } else {
    try {
      const apiKey = (await model.endpoint.credentials?.resolve())?.apiKey;
      if (apiKey !== undefined && apiKey.length > 0) {
        identity = `api-key\0${stableJwtSubject(apiKey) ?? apiKey}`;
      }
    } catch {
      identity = undefined;
    }
  }
  if (identity === undefined) return 'no-key';
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function stableJwtSubject(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return undefined;
    const sub = (payload as { sub?: unknown }).sub;
    if (typeof sub === 'string' && sub.length > 0) return sub;
    const userId = (payload as { user_id?: unknown }).user_id;
    if (typeof userId === 'string' && userId.length > 0) return userId;
    return undefined;
  } catch {
    return undefined;
  }
}

function labelledMedia(
  part: ContentPart,
  kind: ResolvedMediaKind,
  label: MediaLabel,
  previous: ContentPart | undefined,
): ContentPart[] {
  if (label.name === undefined && label.path === undefined) return [part];
  const legacyTag = previous?.type === 'text' ? matchSingleMediaPathTag(previous.text) : undefined;
  if (legacyTag?.kind === kind && legacyTag.path === label.path) return [part];
  return [
    { type: 'text', text: buildMediaOpenTag(kind, label) },
    part,
    { type: 'text', text: `</${kind}>` },
  ];
}

function withMediaTag(text: string, kind: ResolvedMediaKind, label: MediaLabel): ContentPart {
  const tag = buildMediaTag(kind, label);
  return { type: 'text', text: tag === undefined ? text : `${text}\n${tag}` };
}

function pathTagOr(fallback: string, kind: ResolvedMediaKind, label: MediaLabel): ContentPart {
  if (label.path === undefined) return withMediaTag(fallback, kind, label);
  return { type: 'text', text: `${buildMediaOpenTag(kind, label)}</${kind}>` };
}

function omittedMediaText(
  kind: ResolvedMediaKind,
  reason: MediaPlaceholderReason,
  label: MediaLabel,
): ContentPart {
  return pathTagOr(mediaPlaceholderText(kind, reason), kind, label);
}

function inlineMediaBudgetEntry(
  part: ContentPart,
  kind: ResolvedMediaKind,
  label: MediaLabel,
  messageIndex: number,
  slotIndex: number,
): MediaBudgetEntry | undefined {
  if (part.type !== 'image_url' && part.type !== 'video_url') return undefined;
  const url = mediaUrlOf(part);
  if (!isDataUrl(url)) return undefined;
  const hash = createHash('sha256').update(kind).update('\0').update(url).digest('hex');
  return { messageIndex, slotIndex, key: `inline\0${hash}`, kind, label, bytes: url.length };
}

function inlinePartBytes(part: ContentPart): number {
  if (part.type !== 'image_url' && part.type !== 'video_url') return 0;
  const url = mediaUrlOf(part);
  return isDataUrl(url) ? url.length : 0;
}

function unsupportedMedia(kind: ResolvedMediaKind, label: MediaLabel): ContentPart {
  const capability = `${kind} input`;
  return withMediaTag(
    `[${kind} omitted: the current model does not support ${capability}; ` +
      `use a model with ${capability} capability or convert the file to text]`,
    kind,
    label,
  );
}

function degradedImage(label: MediaLabel): ContentPart {
  return pathTagOr(IMAGE_UNAVAILABLE_TEXT, 'image', label);
}

function videoTag(label: MediaLabel): ContentPart {
  return pathTagOr(VIDEO_UNAVAILABLE_TEXT, 'video', label);
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
