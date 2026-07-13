/**
 * `/api/v1` prompt routes — v1-compatible prompt surface backed directly by
 * the Agent-scoped `prompt` scheduler. This edge applies protocol conversion,
 * request overrides, and metadata updates while preserving the paths and wire
 * shapes from `packages/server/src/routes/prompts.ts`.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  IBootstrapService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAuthSummaryService,
  IEventService,
  IFileService,
  ISessionMetadata,
  promptMetadataTextFromContentParts,
  type ContentPart,
  type PromptHandle,
  type PromptQueueSnapshot,
  ISessionContext,
  ISessionLifecycleService,
  ITelemetryService,
  applyPromptMetadataUpdate,
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  compressBase64ForModel,
  compressImageForModel,
  decodeBase64Prefix,
  isError2,
  Error2,
  isModelAcceptedImageMime,
  normalizeImageMime,
  persistOriginalImage,
  resolveEffectiveImageMime,
  sessionMediaOriginalsDir,
  unsupportedImageMimeFromUrl,
  type GetResult,
  type ImageCompressionTelemetry,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  type PromptSubmission,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

interface PromptRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const validationDetailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const authProviderDetailsSchema = z.object({ provider_id: z.string() });
const authModelDetailsSchema = z.object({ model_id: z.string(), provider_id: z.string() }).partial();
const VIDEO_EXT_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/mpeg': '.mpeg',
};

async function resolveSession(core: Scope, sessionId: string): Promise<ISessionScopeHandle> {
  // `resume` (not `get`) so a persisted-but-cold session — created by a previous
  // process, by v1, or closed in this one — is loaded from disk instead of
  // being reported as `session.not_found`. Mirrors the snapshot route. Returns
  // `undefined` only when the session is unknown or its workspace is gone.
  const session = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
  if (session === undefined) {
    throw new Error2('session.not_found', `session ${sessionId} does not exist`);
  }
  return session;
}

async function resolvePrompt(core: Scope, sessionId: string, agentId?: string) {
  return resolvePromptFromSession(await resolveSession(core, sessionId), agentId);
}

async function resolvePromptFromSession(session: ISessionScopeHandle, agentId?: string) {
  // A prompt may target a forked side-channel agent (e.g. `/btw`) via
  // `body.agent_id`. Default to `main` when absent; only `main` is
  // auto-created — any other id must already exist (forked beforehand), or it
  // is reported as `agent.not_found`.
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).getHandle(agentId);
  if (agent === undefined) {
    throw new Error2('agent.not_found', `agent ${agentId} does not exist`);
  }
  return {
    prompt: agent.accessor.get(IAgentPromptService),
    auth: agent.accessor.get(IAuthSummaryService),
    profile: agent.accessor.get(IAgentProfileService),
    permissionMode: agent.accessor.get(IAgentPermissionModeService),
  };
}

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = projectPromptList((await resolvePrompt(core, session_id)).prompt.list());
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PromptRouteHost['get']>[2]);

  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: { detailsSchema: authModelDetailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const resolvedBody = await resolvePromptMediaFiles(
          req.body,
          core.accessor.get(IFileService),
          core.accessor.get(IBootstrapService).cacheDir,
          {
            telemetry: core.accessor.get(ITelemetryService).withContext({ sessionId: session_id }),
            resolveOriginalsDir: async () => {
              const session = await core.accessor.get(ISessionLifecycleService).resume(session_id);
              if (session === undefined) return undefined;
              return sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir);
            },
          },
        );
        const resolved = await resolvePrompt(core, session_id, resolvedBody.agent_id);
        await resolved.auth.ensureReady();
        if (resolvedBody.model !== undefined) await resolved.profile.setModel(resolvedBody.model);
        if (resolvedBody.thinking !== undefined) resolved.profile.setThinking(resolvedBody.thinking);
        if (resolvedBody.permission_mode !== undefined) resolved.permissionMode.setMode(resolvedBody.permission_mode);
        const parts = contentToCoreParts(resolvedBody.content);
        const session = await resolveSession(core, session_id);
        await applyPromptMetadataUpdate({
          metadata: session.accessor.get(ISessionMetadata),
          eventService: core.accessor.get(IEventService),
          sessionId: session_id,
        }, promptMetadataTextFromContentParts(parts));
        const handle = await resolved.prompt.enqueue({ message: {
          role: 'user',
          content: parts,
          toolCalls: [],
          origin: { kind: 'user' },
        } });
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(submitRoute.path, submitRoute.options, submitRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const steerManyRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts::steer',
      body: promptSteerRequestSchema,
      params: sessionIdParamSchema,
      success: { data: promptSteerResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: 'Steer queued prompts into the active turn',
      tags: ['prompts'],
      operationId: 'steerPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const resolved = await resolvePrompt(core, session_id);
        await resolved.prompt.steer(req.body.prompt_ids);
        reply.send(okEnvelope({ steered: true, prompt_ids: [...req.body.prompt_ids] }, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(steerManyRoute.path, steerManyRoute.options, steerManyRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: z.union([promptAbortResponseSchema, promptSteerResultSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Abort a running prompt or steer a queued prompt',
      tags: ['prompts'],
      operationId: 'promptAction',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as { session_id: string; tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort', 'steer'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const resolved = await resolvePrompt(core, session_id);
        if (parsed.action === 'abort') {
          resolved.prompt.abort(parsed.id);
          reply.send(okEnvelope({ aborted: true }, req.id));
        } else {
          await resolved.prompt.steer([parsed.id]);
          reply.send(okEnvelope({ steered: true, prompt_ids: [parsed.id] }, req.id));
        }
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

function projectPromptList(snapshot: PromptQueueSnapshot) {
  return {
    active: snapshot.active === undefined ? null : projectPromptSnapshot(snapshot.active),
    queued: snapshot.pending.map(projectPromptSnapshot),
  };
}

function projectPromptHandle(handle: PromptHandle) {
  return projectPromptSnapshot(handle);
}

function projectPromptSnapshot(prompt: PromptQueueSnapshot['pending'][number]) {
  const status = prompt.state === 'running' || prompt.state === 'steered'
    ? 'running'
    : prompt.state === 'blocked' ? 'blocked' : 'queued';
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: corePartsToProtocol(prompt.message.content),
    created_at: prompt.createdAt,
  };
}

function corePartsToProtocol(content: readonly ContentPart[]): PromptSubmission['content'] {
  const parts: PromptSubmission['content'] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      parts.push(match === null
        ? { type: 'image', source: { kind: 'url', url: part.imageUrl.url } }
        : { type: 'image', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    } else if (part.type === 'video_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      parts.push(match === null
        ? { type: 'video', source: { kind: 'url', url: part.videoUrl.url } }
        : { type: 'video', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    }
  }
  return parts;
}

function contentToCoreParts(content: PromptSubmission['content']): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image' && part.source.kind === 'url') parts.push({ type: 'image_url', imageUrl: { url: part.source.url } });
    else if (part.type === 'image' && part.source.kind === 'base64') parts.push({ type: 'image_url', imageUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
    else if (part.type === 'video' && part.source.kind === 'url') parts.push({ type: 'video_url', videoUrl: { url: part.source.url } });
    else if (part.type === 'video' && part.source.kind === 'base64') parts.push({ type: 'video_url', videoUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
  }
  return parts;
}

interface ResolvePromptMediaOptions {
  /**
   * Lazily resolve the session's media-originals dir for persisting the
   * pre-compression bytes of inline base64 images. Only invoked when an image
   * was actually compressed; a failure or undefined result falls back to the
   * shared temp-dir cache.
   */
  readonly resolveOriginalsDir?: () => Promise<string | undefined>;
  /** Report an `image_compress` event per compressed prompt image. */
  readonly telemetry?: ITelemetryService;
}

async function resolvePromptMediaFiles(
  body: PromptSubmission,
  store: IFileService,
  cacheDir: string,
  options: ResolvePromptMediaOptions = {},
): Promise<PromptSubmission> {
  let changed = false;
  let originalsDir: string | undefined;
  let originalsDirResolved = false;
  const resolveOriginalsDir = async (): Promise<string | undefined> => {
    if (!originalsDirResolved) {
      originalsDirResolved = true;
      originalsDir = await options.resolveOriginalsDir?.().catch(() => undefined);
    }
    return originalsDir;
  };
  const telemetryFor = (source: string): ImageCompressionTelemetry | undefined =>
    options.telemetry === undefined ? undefined : { client: options.telemetry, source };
  const content: PromptSubmission['content'] = [];
  for (const part of body.content) {
    // Inline base64 image: compress the payload in place. This mirrors the v1
    // server path for REST clients that submit an image without uploading it.
    if (part.type === 'image' && part.source.kind === 'base64') {
      // Formats the provider cannot accept must never enter the session
      // history — one unsupported image_url makes every later request fail.
      // The bytes are authoritative: an image labeled image/png that is
      // actually AVIF is gated on the sniffed format, not the label. Drop
      // the image; a notice stands in so the model knows what happened.
      const effectiveMime = resolveEffectiveImageMime(
        part.source.media_type,
        decodeBase64Prefix(part.source.data),
      );
      if (!isModelAcceptedImageMime(effectiveMime)) {
        content.push({ type: 'text', text: buildUnsupportedImageNotice(effectiveMime) });
        changed = true;
        continue;
      }
      const canonicalMime = normalizeImageMime(effectiveMime);
      const compressed = await compressBase64ForModel(part.source.data, canonicalMime, {
        telemetry: telemetryFor('prompt_inline'),
      });
      if (compressed.changed) {
        const dir = await resolveOriginalsDir();
        const originalPath = await persistOriginalImage(
          Buffer.from(part.source.data, 'base64'),
          part.source.media_type,
          { dir },
        );
        content.push({
          type: 'text',
          text: buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: part.source.media_type,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          }),
        });
        content.push({
          type: 'image',
          source: { kind: 'base64', media_type: compressed.mimeType, data: compressed.base64 },
        });
        changed = true;
      } else {
        content.push(part);
      }
      continue;
    }

    // Remote image URL: no bytes to sniff, so reject when its path extension
    // names a format providers reject (e.g. a link ending in `.avif`) — the
    // notice keeps the URL so the model can still fetch and convert the
    // image. Extensionless / unknown URLs pass through to the provider and
    // the 400 recovery. Image+URL parts that pass are re-emitted unchanged.
    if (part.type === 'image' && part.source.kind === 'url') {
      const extMime = unsupportedImageMimeFromUrl(part.source.url);
      if (extMime !== null) {
        content.push({ type: 'text', text: buildUnsupportedImageNotice(extMime, part.source.url) });
        changed = true;
        continue;
      }
      content.push(part);
      continue;
    }

    if ((part.type !== 'image' && part.type !== 'video') || part.source.kind !== 'file') {
      content.push(part);
      continue;
    }

    const file = await store.get(part.source.file_id);
    assertMediaFile(file, part.type);
    if (part.type === 'image') {
      const data = await readFileOrStream(file);
      let mediaType = file.meta.media_type;
      let bytes: Uint8Array = data;
      // Same format gate as the inline path above, and again the bytes are
      // authoritative: an upload whose Content-Type lies (AVIF bytes sent
      // as image/png) becomes a notice instead of an image part.
      mediaType = resolveEffectiveImageMime(mediaType, data);
      if (!isModelAcceptedImageMime(mediaType)) {
        content.push({ type: 'text', text: buildUnsupportedImageNotice(mediaType, file.meta.name) });
        changed = true;
        continue;
      }
      // Forward the canonical MIME (image/jpg → image/jpeg, case/whitespace)
      // — strict provider whitelists reject the raw alias.
      mediaType = normalizeImageMime(mediaType);
      const compressed = await compressImageForModel(data, mediaType, {
        telemetry: telemetryFor('prompt_file'),
      });
      if (compressed.changed) {
        const dir = await resolveOriginalsDir();
        const originalPath = await persistOriginalImage(data, mediaType, { dir });
        content.push({
          type: 'text',
          text: buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: mediaType,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          }),
        });
      }
      bytes = compressed.data;
      mediaType = compressed.mimeType;
      content.push({
        type: 'image',
        source: {
          kind: 'base64',
          media_type: mediaType,
          data: Buffer.from(bytes).toString('base64'),
        },
      });
      changed = true;
      continue;
    }

    const cachePath = await materializeVideoToCache(file, cacheDir);
    content.push({ type: 'text', text: `<video path="${escapeAttribute(cachePath)}"></video>` });
    changed = true;
  }
  return changed ? { ...body, content } : body;
}

async function materializeVideoToCache(file: GetResult, cacheDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const ext = extname(file.meta.name) || (VIDEO_EXT_BY_MIME[file.meta.media_type.toLowerCase()] ?? '.bin');
  const target = join(cacheDir, `${file.meta.id}${ext}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

async function readFileOrStream(file: GetResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream()) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

function assertMediaFile(file: GetResult, expected: 'image' | 'video'): void {
  const prefix = expected === 'video' ? 'video/' : 'image/';
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new Error2(
    'validation.failed',
    `file ${file.meta.id} is ${file.meta.media_type}, not ${expected === 'video' ? 'a video' : 'an image'}`,
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'file.not_found':
        reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'prompt.not_found':
        reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.busy':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'prompt.already_completed':
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
      case 'auth.provisioning_required':
        reply.send({
          code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: null,
        });
        return;
      case 'auth.token_missing': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_MISSING,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.token_unauthorized': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.model_not_resolved':
        reply.send({
          code: ErrorCode.AUTH_MODEL_NOT_RESOLVED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: authModelDetails(err),
        });
        return;
    }
  }
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function authProviderDetails(err: Error2): { provider_id: string } | undefined {
  const providerId = err.details?.['provider_id'];
  if (typeof providerId !== 'string') return undefined;
  return { provider_id: providerId };
}

function authModelDetails(err: Error2): { model_id?: string; provider_id?: string } | null {
  const details: { model_id?: string; provider_id?: string } = {};
  const modelId = err.details?.['model_id'];
  const providerId = err.details?.['provider_id'];
  if (typeof modelId === 'string') details.model_id = modelId;
  if (typeof providerId === 'string') details.provider_id = providerId;
  return Object.keys(details).length === 0 ? null : details;
}
