import {
  agentContextOf,
  Error2,
  ErrorCodes,
  getOrRestoreAgent,
  IAgentLoopService,
  IAgentProfileService,
  ISessionTokenCountingService,
  resumeSessionById,
  type IAgentScopeHandle,
  type PromptOrigin,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { ContentPart, Message } from '@moonshot-ai/core/llm/message';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute, type GetRouteHost } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  contextItemDetailSchema,
  contextItemsResponseSchema,
  contextSummarySchema,
  type ContextGroup,
  type ContextItemDetail,
  type ContextItemPart,
  type ContextItemSegment,
  type ContextItemSummary,
  type ContextSummary,
} from '../protocol/rest-context';
import { userMessageOriginOf } from '../services/conversation/conversationItems';
import { readLegacyStatus } from '../services/legacyStatus/legacyStatus';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { sendMappedError, sessionConflictErrors } from './sessionErrors';
import { selectContextItems } from './contextItems';

const sessionParamsSchema = z.object({
  session_id: z.string().min(1),
});

const itemParamsSchema = z.object({
  session_id: z.string().min(1),
  item_id: z.string().min(1),
});

const summaryQuerySchema = z.object({
  agent_id: z.string().min(1).regex(/^[^/\\]+$/).optional(),
});

const itemsQuerySchema = z.object({
  agent_id: z.string().min(1).regex(/^[^/\\]+$/).optional(),
  role: z.union([z.string(), z.array(z.string())]).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const DEFAULT_ITEMS_LIMIT = 100;
const PREVIEW_MAX_CHARS = 240;
const MEDIA_PAYLOAD_MIN_CHARS = 512;

interface MessageOutline {
  readonly role: string;
  readonly name: string | undefined;
  readonly tokens: number;
  readonly count: number;
  readonly hasMedia: boolean;
  readonly preview: string;
}

function previewOf(chunks: readonly string[]): string {
  return chunks
    .map((chunk) => chunk.slice(0, PREVIEW_MAX_CHARS))
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_MAX_CHARS);
}

function isMediaPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function partPreview(part: ContentPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'think') return part.think;
  return `[${part.type}]`;
}

interface MessageIdentity {
  readonly role: string;
  readonly name: string | undefined;
}

function reminderNameOf(origin: PromptOrigin | undefined): string | undefined {
  if (origin === undefined) return undefined;
  if (origin.kind === 'injection') return origin.variant;
  if (origin.kind === 'system_trigger') return origin.name;
  if (origin.kind === 'hook_result') return origin.event;
  return origin.kind;
}

function userMessageIdentity(message: Message): MessageIdentity {
  const origin = message.attributes?.origin as PromptOrigin | undefined;
  if (origin?.kind === 'compaction_summary') return { role: 'compaction', name: undefined };
  const presented = userMessageOriginOf(origin);
  switch (presented.kind) {
    case 'user':
      return { role: 'user', name: undefined };
    case 'plugin_command':
      return { role: 'user', name: `/${presented.command}` };
    case 'skill':
      return { role: 'skill', name: presented.name };
    case 'cron':
    case 'goal':
    case 'hook':
    case 'retry':
    case 'system':
      return { role: 'reminder', name: reminderNameOf(origin) };
  }
}

function messageIdentity(message: Message, toolNames: ReadonlyMap<string, string>): MessageIdentity {
  if (message.role === 'user') return userMessageIdentity(message);
  if (message.role === 'tool') {
    return { role: 'tool', name: toolNames.get(message.toolCallId) ?? message.toolCallId };
  }
  const declared = message.role === 'system' ? (message.tools ?? []) : [];
  if (declared.length > 0) return { role: 'definition', name: declared.map((tool) => tool.name).join(', ') };
  const calls = message.role === 'assistant' ? message.toolCalls : [];
  return { role: message.role, name: calls.map((call) => call.name).join(', ') || undefined };
}

function outlineMessages(
  messages: readonly Message[],
  estimator: Pick<ISessionTokenCountingService, 'estimateMessage' | 'estimateTools'>,
): MessageOutline[] {
  const toolNames = new Map<string, string>();
  return messages.map((message) => {
    const declared = message.role === 'system' ? (message.tools ?? []) : [];
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) toolNames.set(call.id, call.name);
    }
    return {
      ...messageIdentity(message, toolNames),
      tokens: estimator.estimateMessage(message) + estimator.estimateTools(declared),
      count: Math.max(1, declared.length),
      hasMedia: message.content.some(isMediaPart),
      preview: previewOf([...message.content.map(partPreview), ...declared.map((tool) => tool.description)]),
    };
  });
}

function redactMediaPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MEDIA_PAYLOAD_MIN_CHARS ? `[encoded media · ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.map(redactMediaPayload);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactMediaPayload(entry)]),
    );
  }
  return value;
}

function parseToolArguments(args: string | null): unknown {
  if (args === null) return null;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function contentItemPart(part: ContentPart): ContextItemPart {
  if (part.type === 'text') return { kind: 'text', text: part.text };
  if (part.type === 'think') return { kind: 'think', text: part.think };
  return { kind: 'media', name: part.type, data: redactMediaPayload(part) };
}

function messageParts(message: Message): ContextItemPart[] {
  const parts = message.content.map(contentItemPart);
  if (message.role === 'system') {
    for (const tool of message.tools ?? []) parts.push({ kind: 'definition', name: tool.name, data: tool });
  }
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) {
      parts.push({ kind: 'function', name: call.name, data: parseToolArguments(call.arguments) });
    }
  }
  return parts;
}

function redactMessageMedia(message: Message): unknown {
  return {
    ...message,
    content: message.content.map((part) => (isMediaPart(part) ? redactMediaPayload(part) : part)),
  };
}

type SegmentSource =
  | { readonly kind: 'message' }
  | { readonly kind: 'content'; readonly index: number }
  | { readonly kind: 'call'; readonly index: number };

interface MessageSegment {
  readonly id: string;
  readonly role: string;
  readonly segment: ContextItemSegment | undefined;
  readonly name: string | undefined;
  readonly tokens: number;
  readonly hasMedia: boolean;
  readonly preview: string;
  readonly source: SegmentSource;
}

function assistantSegments(
  message: Extract<Message, { role: 'assistant' }>,
  index: number,
  estimator: Pick<ISessionTokenCountingService, 'estimateMessage'>,
): MessageSegment[] {
  const bare: Extract<Message, { role: 'assistant' }> = { role: 'assistant', content: [], toolCalls: [] };
  const overhead = estimator.estimateMessage(bare);
  const segments = [
    ...message.content.map((part, partIndex): MessageSegment => ({
      id: `message-${index}-part-${partIndex}`,
      role: 'assistant',
      segment: part.type === 'think' ? 'thinking' : 'reply',
      name: undefined,
      tokens: estimator.estimateMessage({ ...bare, content: [part] }) - overhead,
      hasMedia: isMediaPart(part),
      preview: previewOf([partPreview(part)]),
      source: { kind: 'content', index: partIndex },
    })),
    ...message.toolCalls.map((call, callIndex): MessageSegment => ({
      id: `message-${index}-call-${callIndex}`,
      role: 'assistant',
      segment: 'tool_call',
      name: call.name,
      tokens: estimator.estimateMessage({ ...bare, toolCalls: [call] }) - overhead,
      hasMedia: false,
      preview: previewOf([call.arguments ?? '']),
      source: { kind: 'call', index: callIndex },
    })),
  ];
  const [first, ...rest] = segments;
  return first === undefined ? [] : [{ ...first, tokens: first.tokens + overhead }, ...rest];
}

function messageSegments(
  message: Message,
  index: number,
  outline: MessageOutline,
  estimator: Pick<ISessionTokenCountingService, 'estimateMessage'>,
): MessageSegment[] {
  const split = message.role === 'assistant' ? assistantSegments(message, index, estimator) : [];
  if (split.length > 0) return split;
  return [{
    id: `message-${index}`,
    role: outline.role,
    segment: undefined,
    name: outline.name,
    tokens: outline.tokens,
    hasMedia: outline.hasMedia,
    preview: outline.preview,
    source: { kind: 'message' },
  }];
}

function segmentContent(message: Message, source: SegmentSource): { parts: ContextItemPart[]; raw: unknown } {
  if (source.kind === 'content') {
    const part = message.content[source.index]!;
    return { parts: [contentItemPart(part)], raw: isMediaPart(part) ? redactMediaPayload(part) : part };
  }
  if (source.kind === 'call' && message.role === 'assistant') {
    const call = message.toolCalls[source.index]!;
    return { parts: [{ kind: 'function', name: call.name, data: parseToolArguments(call.arguments) }], raw: call };
  }
  return { parts: messageParts(message), raw: redactMessageMedia(message) };
}

function contextItemIndex(itemId: string, prefix: string): number | undefined {
  const suffix = itemId.slice(prefix.length);
  return /^(0|[1-9]\d*)$/.test(suffix) ? Number(suffix) : undefined;
}

async function resolveAgent(
  core: Scope,
  sessionId: string,
  agentId: string | undefined,
): Promise<{ agent: IAgentScopeHandle; resolvedAgentId: string }> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
  }
  const mainHandle = await ensureMainAgent(session);
  const resolvedAgentId = agentId ?? MAIN_AGENT_ID;
  if (resolvedAgentId === MAIN_AGENT_ID) {
    return { agent: mainHandle, resolvedAgentId };
  }
  const agent = await getOrRestoreAgent(session, resolvedAgentId);
  if (agent === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `Agent not found: ${resolvedAgentId}`);
  }
  return { agent, resolvedAgentId };
}

export function splitSystemPromptParts(systemPrompt: string): ContextItemPart[] {
  if (!systemPrompt) return [];
  const sections: ContextItemPart[] = [];
  let fence: string | undefined;
  let currentName: string | undefined;
  let currentLines: string[] = [];

  for (const line of systemPrompt.split('\n')) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      if (fence === undefined) {
        fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.slice(marker.length).trim() === ''
      ) {
        fence = undefined;
      }
    } else if (fence === undefined && /^# \S/.test(line)) {
      const text = currentLines.join('\n').trim();
      if (text.length > 0 || currentName !== undefined) {
        sections.push({ kind: 'text', name: currentName, text });
      }
      currentName = line.slice(2).trim();
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }

  const tail = currentLines.join('\n').trim();
  if (tail.length > 0 || currentName !== undefined) {
    sections.push({ kind: 'text', name: currentName, text: tail });
  }
  return sections.length > 0 ? sections : [{ kind: 'text', text: systemPrompt }];
}

function readAgentContextSources(agent: IAgentScopeHandle) {
  const loop = agent.accessor.get(IAgentLoopService);
  const profile = agent.accessor.get(IAgentProfileService);
  const tokenCounting = agent.accessor.get(ISessionTokenCountingService);
  const legacyStatus = readLegacyStatus(agent);
  const request = loop.previewRequestContent();
  const systemPrompt = request.systemPrompt || profile.getSystemPrompt();
  const tools = request.tools.filter((tool) => tool.deferred !== true);
  const outlines = outlineMessages(request.messages, tokenCounting);
  const segments = outlines.map((outline, index) =>
    messageSegments(request.messages[index]!, index, outline, tokenCounting),
  );
  const systemTokens = tokenCounting.estimateText(systemPrompt);
  const toolTokens = tools.map((tool) => tokenCounting.estimateTools([tool]));
  const estimatedTotal = [systemTokens, ...toolTokens, ...outlines.map((outline) => outline.tokens)]
    .reduce((sum, tokens) => sum + tokens, 0);
  const measuredTotal =
    tokenCounting.latestMeasured(agentContextOf(agent)) > 0 ? legacyStatus?.contextTokens : undefined;
  const used = measuredTotal ?? estimatedTotal;
  const scale = estimatedTotal > 0 ? used / estimatedTotal : 0;
  const allocate = (estimate: number): number => Math.round(estimate * scale);
  return {
    systemPrompt,
    tools,
    messages: request.messages,
    outlines: outlines.map((outline) => ({ ...outline, tokens: allocate(outline.tokens) })),
    segments: segments.map((list) => list.map((segment) => ({ ...segment, tokens: allocate(segment.tokens) }))),
    systemTokens: allocate(systemTokens),
    toolTokens: toolTokens.map(allocate),
    textTokens: (text: string): number => allocate(tokenCounting.estimateText(text)),
    modelAlias:
      loop.data().modelAlias || profile.data().modelAlias || legacyStatus?.model || undefined,
    tokens: { used, max: legacyStatus?.maxContextTokens },
  };
}

type ContextSources = ReturnType<typeof readAgentContextSources>;

function buildContextSummary(sessionId: string, agentId: string, sources: ContextSources): ContextSummary {
  const groups = new Map<string, ContextGroup>();
  const addGroup = (role: string, tokens: number, count: number): void => {
    const group = groups.get(role) ?? { role, count: 0, tokens: 0 };
    group.count += count;
    group.tokens += tokens;
    groups.set(role, group);
  };

  if (sources.systemPrompt.length > 0) addGroup('system', sources.systemTokens, 1);
  for (const tokens of sources.toolTokens) addGroup('definition', tokens, 1);
  for (const outline of sources.outlines) addGroup(outline.role, outline.tokens, outline.count);

  return {
    session_id: sessionId,
    agent_id: agentId,
    captured_at: Date.now(),
    model: sources.modelAlias,
    tokens: sources.tokens,
    groups: [...groups.values()],
  };
}

function listContextItems(sources: ContextSources): {
  toolItems: ContextItemSummary[];
  otherItems: ContextItemSummary[];
} {
  const toolItems = sources.tools.map((tool, index): ContextItemSummary => ({
    id: `tool-${index}`,
    role: 'definition',
    name: tool.name,
    sequence: undefined,
    preview: previewOf([tool.description]),
    tokens: sources.toolTokens[index] ?? 0,
    has_media: false,
  }));
  const systemItems: ContextItemSummary[] =
    sources.systemPrompt.length > 0
      ? [
          {
            id: 'system',
            role: 'system',
            name: undefined,
            sequence: undefined,
            preview: previewOf([sources.systemPrompt]),
            tokens: sources.systemTokens,
            has_media: false,
          },
        ]
      : [];
  const messageItems = sources.segments.flatMap((segments, index) =>
    segments.map((segment): ContextItemSummary => ({
      id: segment.id,
      role: segment.role,
      segment: segment.segment,
      name: segment.name,
      sequence: index + 1,
      preview: segment.preview,
      tokens: segment.tokens,
      has_media: segment.hasMedia,
    })),
  );
  return { toolItems, otherItems: [...systemItems, ...messageItems] };
}

function readContextItem(sources: ContextSources, itemId: string): ContextItemDetail | undefined {
  if (itemId === 'system') {
    return {
      id: 'system',
      role: 'system',
      name: undefined,
      sequence: undefined,
      tokens: sources.systemTokens,
      has_media: false,
      parts: splitSystemPromptParts(sources.systemPrompt).map((part) => ({
        ...part,
        tokens: sources.textTokens(part.text ?? ''),
      })),
      raw: sources.systemPrompt,
    };
  }
  if (itemId.startsWith('tool-')) {
    const index = contextItemIndex(itemId, 'tool-');
    const tool = index === undefined ? undefined : sources.tools[index];
    if (index === undefined || tool === undefined) return undefined;
    return {
      id: itemId,
      role: 'definition',
      name: tool.name,
      sequence: undefined,
      tokens: sources.toolTokens[index] ?? 0,
      has_media: false,
      parts: [{ kind: 'definition', name: tool.name, data: tool }],
      raw: tool,
    };
  }
  const messageId = /^message-(0|[1-9]\d*)(?:-(?:part|call)-(?:0|[1-9]\d*))?$/.exec(itemId);
  if (messageId !== null) {
    const index = Number(messageId[1]);
    const message = sources.messages[index];
    const segment = sources.segments[index]?.find((entry) => entry.id === itemId);
    if (message === undefined || segment === undefined) return undefined;
    return {
      id: itemId,
      role: segment.role,
      segment: segment.segment,
      name: segment.name,
      sequence: index + 1,
      tokens: segment.tokens,
      has_media: segment.hasMedia,
      ...segmentContent(message, segment.source),
    };
  }
  return undefined;
}

export function registerContextRoutes(app: GetRouteHost, core: Scope): void {
  const summaryRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/context/summary',
      params: sessionParamsSchema,
      querystring: summaryQuerySchema,
      success: { data: contextSummarySchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        ...sessionConflictErrors,
      },
      description: 'Get lightweight context composition summary for a session agent',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const { agent, resolvedAgentId } = await resolveAgent(core, session_id, req.query.agent_id);
        const sources = readAgentContextSources(agent);
        reply.send(okEnvelope(buildContextSummary(session_id, resolvedAgentId, sources), req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    summaryRoute.path,
    summaryRoute.options,
    summaryRoute.handler as Parameters<GetRouteHost['get']>[2],
  );

  const itemsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/context/items',
      params: sessionParamsSchema,
      querystring: itemsQuerySchema,
      success: { data: contextItemsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        ...sessionConflictErrors,
      },
      description: 'List context block outlines and composition summary for a session agent',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const { agent, resolvedAgentId } = await resolveAgent(core, session_id, req.query.agent_id);
        const sources = readAgentContextSources(agent);
        const requestedRoles = req.query.role === undefined
          ? []
          : Array.isArray(req.query.role)
            ? req.query.role
            : [req.query.role];
        const filterRoles = [
          ...new Set(requestedRoles.map((role) => role.trim()).filter((role) => role.length > 0)),
        ];
        const offset = req.query.offset ?? 0;
        const limit = req.query.limit ?? DEFAULT_ITEMS_LIMIT;
        const { toolItems, otherItems } = listContextItems(sources);
        const selection = selectContextItems(otherItems, toolItems, filterRoles);
        const pagedItems = selection.items.slice(offset, offset + limit);
        reply.send(
          okEnvelope(
            {
              summary: buildContextSummary(session_id, resolvedAgentId, sources),
              tools: selection.tools,
              items: pagedItems,
              total: selection.items.length,
              has_more: offset + pagedItems.length < selection.items.length,
            },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    itemsRoute.path,
    itemsRoute.options,
    itemsRoute.handler as Parameters<GetRouteHost['get']>[2],
  );

  const itemDetailRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/context/items/{item_id}',
      params: itemParamsSchema,
      querystring: summaryQuerySchema,
      success: { data: contextItemDetailSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.MESSAGE_NOT_FOUND]: {},
        ...sessionConflictErrors,
      },
      description: 'Get full parsed and raw content for a single context item',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id, item_id } = req.params;
        const { agent } = await resolveAgent(core, session_id, req.query.agent_id);
        const detail = readContextItem(readAgentContextSources(agent), item_id);
        if (detail === undefined) {
          reply.send({
            code: ErrorCode.MESSAGE_NOT_FOUND,
            msg: `Context item not found: ${item_id}`,
            data: null,
            request_id: req.id,
          });
          return;
        }
        reply.send(okEnvelope(detail, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    itemDetailRoute.path,
    itemDetailRoute.options,
    itemDetailRoute.handler as Parameters<GetRouteHost['get']>[2],
  );
}
