import { createHash } from 'node:crypto';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IFileService } from '#/app/file/fileService';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { Message } from '#/llm-adapter/contract/message';
import { ImageUploadUnsupportedError } from '#/llm-adapter/contract/errors';
import type { ContentPart } from '#human/llm/message';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';
import { runWithCredentialRecovery } from '#/llm-adapter/model/credential-recovery';
import { IBlobStore } from '#/persistence/interface/blobStore';

import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { isDataUrl, isModelAcceptedImageMime, normalizeImageMime } from './image-format-policy';
import {
  buildMediaPathTag,
  type DaemonFileRef,
  daemonFileRefFromPart,
  matchSingleMediaPathTag,
  parseDaemonFileUrl,
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

interface MediaBudgetEntry {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly key: string;
  readonly fileId?: string;
  readonly kind: 'image' | 'video';
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

  async resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]> {
    let changed = false;
    const out: Message[] = [];
    const budgetEntries: MediaBudgetEntry[] = [];
    for (const message of messages) {
      const content: ContentPart[] = [];
      let messageChanged = false;
      let sawVideoRef = false;
      for (const part of message.content) {
        const daemonPart = daemonFileRefFromPart(part);
        if (daemonPart === undefined) {
          const entry = inlineMediaBudgetEntry(part, out.length, content.length);
          if (entry !== undefined) budgetEntries.push(entry);
          content.push(part);
          continue;
        }
        messageChanged = true;
        sawVideoRef ||= daemonPart.kind === 'video';
        const resolved =
          daemonPart.kind === 'video'
            ? await this.resolveVideoPart(daemonPart.ref, requester, signal)
            : await this.resolveImagePart(daemonPart.ref, requester, signal);
        budgetEntries.push({
          messageIndex: out.length,
          partIndex: content.length,
          key: daemonPart.ref.fileId,
          fileId: daemonPart.ref.fileId,
          kind: daemonPart.kind,
          bytes: inlinePartBytes(resolved),
        });
        content.push(resolved);
      }
      out.push(
        messageChanged
          ? {
              ...message,
              content:
                content.length > 0
                  ? content
                  : [unavailableMediaText(sawVideoRef ? 'video' : 'image')],
            }
          : message,
      );
      changed ||= messageChanged;
    }
    changed = (await this.applyMediaBudget(out, budgetEntries)) || changed;
    return changed ? out : messages;
  }

  async displayPaths(messages: readonly Message[]): Promise<ReadonlyMap<string, string>> {
    const paths = new Map<string, string>();
    for (const message of messages) {
      for (const part of message.content) {
        if (part.type !== 'image_url' && part.type !== 'video_url') continue;
        const url = part.type === 'image_url' ? part.imageUrl.url : part.videoUrl.url;
        const ref = parseDaemonFileUrl(url);
        if (ref === undefined || paths.has(url)) continue;
        const path = await this.displayPath(ref);
        if (path !== undefined) paths.set(url, path);
      }
    }
    return paths;
  }

  private async applyMediaBudget(
    out: Message[],
    entries: readonly MediaBudgetEntry[],
  ): Promise<boolean> {
    if (entries.length === 0) return false;
    let changed = false;
    const dropped = this.budgetDropped;
    const pending = new Map<string, number>();
    for (const entry of entries) {
      if (dropped.has(entry.key)) {
        await this.replaceWithMediaTag(out, entry);
        changed = true;
        continue;
      }
      pending.set(entry.key, (pending.get(entry.key) ?? 0) + entry.bytes);
    }
    let total = 0;
    for (const bytes of pending.values()) total += bytes;
    if (total <= REQUEST_MEDIA_BUDGET_BYTES) return changed;

    const droppedNow = new Set<string>();
    for (const [key, bytes] of pending) {
      if (total <= REQUEST_MEDIA_BUDGET_LOW_BYTES) break;
      if (bytes === 0) continue;
      dropped.add(key);
      droppedNow.add(key);
      total -= bytes;
    }
    for (const entry of entries) {
      if (droppedNow.has(entry.key)) await this.replaceWithMediaTag(out, entry);
    }
    const hasUntrackedInlineMedia = entries.some(
      (entry) => droppedNow.has(entry.key) && entry.fileId === undefined,
    );
    try {
      void this.dispatcher.dispatch(
        new WarningIssued({
          agentId: this.scopeContext.agentId,
          code: 'media-budget-exceeded',
          message:
            `Conversation media exceeded the ${String(REQUEST_MEDIA_BUDGET_BYTES / (1024 * 1024))} MB ` +
            `per-request budget; ${String(droppedNow.size)} older media item(s) were omitted` +
            (hasUntrackedInlineMedia ? '.' : ' and remain available at their saved paths.'),
        }),
      );
    } catch {
    }
    return true;
  }

  private async replaceWithMediaTag(out: Message[], entry: MediaBudgetEntry): Promise<void> {
    const message = out[entry.messageIndex]!;
    const content = [...message.content];
    if (entry.fileId === undefined) {
      content[entry.partIndex] = budgetOmittedMedia(entry.kind);
    } else {
      const path = await this.displayPath({ fileId: entry.fileId });
      content[entry.partIndex] = entry.kind === 'video' ? videoTag(path) : degradedImage(path);
    }
    out[entry.messageIndex] = { ...message, content };
  }

  private displayPath(ref: DaemonFileRef): Promise<string | undefined> {
    return this.mediaStore.resolveDisplayPath(ref.fileId);
  }

  private async resolveImagePart(
    ref: DaemonFileRef,
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    if (!model.capabilities.image_in) {
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'unsupported',
        model: model.name,
      });
      return degradedImage(await this.displayPath(ref));
    }
    const providerKey = model.providerType ?? model.protocol;
    const uploader = this.imageUploadUnsupported.has(providerKey)
      ? undefined
      : requester.uploadImage?.bind(requester);
    const inlineKey = `image\0${ref.fileId}`;
    if (uploader === undefined) {
      const memoed = this.memoedImage(inlineKey, model.providerType);
      if (memoed !== undefined) return memoed;
      return this.resolveImageUncached(ref, requester, inlineKey, undefined, signal);
    }
    const cacheKey = `image\0${ref.fileId}\0${providerKey}\0${model.protocol}\0${model.baseUrl ?? ''}\0${await accountHashFor(model)}`;
    const memoed = this.resolved.get(cacheKey);
    if (memoed !== undefined) return memoed;
    const cachedLlmFileId = await this.readCachedUpload(IMAGE_CACHE_SCOPE, cacheKey);
    if (cachedLlmFileId !== undefined) {
      const part: ContentPart = {
        type: 'image_url',
        imageUrl: { url: `ms://${cachedLlmFileId}`, id: cachedLlmFileId },
      };
      this.resolved.set(cacheKey, part);
      return part;
    }
    return this.resolveImageUncached(ref, requester, inlineKey, { uploader, cacheKey }, signal);
  }

  private async resolveImageUncached(
    ref: DaemonFileRef,
    requester: ModelRequester,
    inlineKey: string,
    upload: { readonly uploader: ImageUploader; readonly cacheKey: string } | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    const path = await this.displayPath(ref);

    let source: { readonly bytes: Buffer; readonly filename: string };
    try {
      source = await this.readMedia(ref, signal);
    } catch {
      signal?.throwIfAborted();
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'read_failed',
        model: model.name,
      });
      return degradedImage(path);
    }

    const fileType = detectFileType(
      source.filename,
      source.bytes.subarray(0, MEDIA_SNIFF_BYTES),
      'media',
    );
    const mimeType = normalizeImageMime(fileType.mimeType);
    if (fileType.kind !== 'image' || !isModelAcceptedImageMime(mimeType, model.providerType)) {
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'invalid',
        model: model.name,
      });
      return degradedImage(path);
    }

    if (upload !== undefined) {
      const uploaded = await this.uploadImagePart(requester, source, mimeType, upload, signal);
      if (uploaded !== undefined) return uploaded;
    }

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
    requester: ModelRequester,
    source: { readonly bytes: Buffer; readonly filename: string },
    mimeType: string,
    upload: { readonly uploader: ImageUploader; readonly cacheKey: string },
    signal: AbortSignal | undefined,
  ): Promise<ContentPart | undefined> {
    const model = requester.model;
    try {
      const uploaded = await runWithCredentialRecovery(
        model.credentialProvider,
        () =>
          upload.uploader(
            { data: source.bytes, mimeType, filename: source.filename },
            { signal },
          ),
        signal,
      );
      const llmFileId = uploaded.imageUrl.id ?? msFileIdFromUrl(uploaded.imageUrl.url);
      if (llmFileId !== undefined) {
        await this.writeCachedUpload(IMAGE_CACHE_SCOPE, upload.cacheKey, llmFileId);
      }
      this.resolved.set(upload.cacheKey, uploaded);
      return uploaded;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isMediaUploadAuthError(error)) throw error;
      if (error instanceof ImageUploadUnsupportedError) {
        this.imageUploadUnsupported.add(model.providerType ?? model.protocol);
      }
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'image',
        reason: 'upload_failed',
        model: model.name,
      });
      return undefined;
    }
  }

  private memoedImage(cacheKey: string, providerType: string | undefined): ContentPart | undefined {
    const entry = this.imageMemo.get(cacheKey);
    if (entry === undefined) return undefined;
    if (!isModelAcceptedImageMime(entry.mimeType, providerType)) return undefined;
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
    requester: ModelRequester,
    signal: AbortSignal | undefined,
  ): Promise<ContentPart> {
    const model = requester.model;
    if (!model.capabilities.video_in) return videoTag(await this.displayPath(ref));
    const providerKey = model.providerType ?? model.protocol;
    const cacheKey =
      requester.uploadVideo === undefined
        ? `${ref.fileId}\0${providerKey}`
        : `${ref.fileId}\0${providerKey}\0${model.protocol}\0${model.baseUrl ?? ''}\0${await accountHashFor(model)}`;

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
    const cachedLlmFileId = await this.readCachedUpload(VIDEO_CACHE_SCOPE, cacheKey);
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
      const uploaded = await runWithCredentialRecovery(
        requester.model.credentialProvider,
        () => uploader({ data: bytes, mimeType, filename }, { signal }),
        signal,
      );
      const llmFileId = uploaded.videoUrl.id ?? msFileIdFromUrl(uploaded.videoUrl.url);
      if (llmFileId !== undefined) await this.writeCachedUpload(VIDEO_CACHE_SCOPE, cacheKey, llmFileId);
      return { part: uploaded, memoize: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isMediaUploadAuthError(error)) throw error;
      this.telemetry.track2('media_resolve_fallback', {
        kind: 'video',
        reason: 'upload_failed',
        model: model.name,
      });
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

type ImageUploader = NonNullable<ModelRequester['uploadImage']>;

async function accountHashFor(model: Model): Promise<string> {
  let identity: string | undefined;
  const authorization = model.headers['Authorization'];
  if (authorization !== undefined) {
    identity = `authorization\0${authorization.trim()}`;
  } else {
    try {
      const apiKey = (await model.credentialProvider?.resolve())?.apiKey;
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

function inlineMediaBudgetEntry(
  part: ContentPart,
  messageIndex: number,
  partIndex: number,
): MediaBudgetEntry | undefined {
  if (part.type !== 'image_url' && part.type !== 'video_url') return undefined;
  const url = part.type === 'image_url' ? part.imageUrl.url : part.videoUrl.url;
  if (!isDataUrl(url)) return undefined;
  const kind = part.type === 'image_url' ? 'image' : 'video';
  const hash = createHash('sha256').update(kind).update('\0').update(url).digest('hex');
  return { messageIndex, partIndex, key: `inline\0${hash}`, kind, bytes: url.length };
}

function inlinePartBytes(part: ContentPart): number {
  if (part.type === 'image_url') {
    return isDataUrl(part.imageUrl.url) ? part.imageUrl.url.length : 0;
  }
  if (part.type === 'video_url') {
    return isDataUrl(part.videoUrl.url) ? part.videoUrl.url.length : 0;
  }
  return 0;
}

function budgetOmittedMedia(kind: 'image' | 'video'): ContentPart {
  return { type: 'text', text: `[${kind} omitted: dropped to fit the request media budget]` };
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
