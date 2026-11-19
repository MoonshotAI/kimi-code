import {
  Error2,
  ErrorCodes,
  getOrRestoreAgent,
  IAgentLoopService,
  IAgentProfileService,
  resumeSessionById,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Message } from '@moonshot-ai/core/llm/message';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  contextItemDetailSchema,
  contextItemsResponseSchema,
  contextSummarySchema,
  type ContextGroup,
  type ContextItemDetail,
  type ContextItemPart,
  type ContextItemSummary,
  type ContextSummary,
} from '../protocol/rest-context';
import { readLegacyStatus } from '../services/legacyStatus/legacyStatus';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { sendMappedError, sessionConflictErrors } from './sessionErrors';
import { selectContextItems } from './contextItems';

interface ContextRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

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
const MEDIA_TYPES = new Set([
  'image',
  'image_url',
  'input_image',
  'audio',
  'audio_url',
  'input_audio',
  'video',
  'video_url',
  'document',
  'file',
  'input_file',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function contextMessageRole(message: unknown): string {
  const data = asRecord(message);
  const role = typeof data['role'] === 'string' ? data['role'] : 'unknown';
  return role === 'system' && asArray(data['tools']).length > 0 ? 'definition' : role;
}

function contextItemIndex(itemId: string, prefix: string): number | undefined {
  const suffix = itemId.slice(prefix.length);
  return /^(0|[1-9]\d*)$/.test(suffix) ? Number(suffix) : undefined;
}

function isMediaPart(value: Record<string, unknown>): boolean {
  return (
    MEDIA_TYPES.has(String(value['type'])) ||
    value['inlineData'] !== undefined ||
    value['fileData'] !== undefined
  );
}

function estimateValueChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) {
    let sum = 2;
    for (const item of value) sum += estimateValueChars(item) + 2;
    return sum;
  }
  const obj = asRecord(value);
  let sum = 2;
  for (const [k, v] of Object.entries(obj)) {
    sum += k.length + 4 + estimateValueChars(v);
  }
  return sum;
}

function measureMessage(
  message: Message,
  includePreview: boolean,
): { chars: number; hasMedia: boolean; preview: string } {
  const data = asRecord(message);
  const content = data['content'];
  const toolCalls = asArray(data['toolCalls']);
  const messageTools = asArray(data['tools']);
  let chars = 0;
  let hasMedia = false;
  let preview = '';

  const appendPreview = (chunk: string): void => {
    if (!includePreview || preview.length >= PREVIEW_MAX_CHARS || !chunk) return;
    const needed = PREVIEW_MAX_CHARS - preview.length + 32;
    const slice = chunk.slice(0, needed).replaceAll(/\s+/g, ' ').trim();
    if (!slice) return;
    preview = preview ? `${preview} ${slice}` : slice;
    if (preview.length > PREVIEW_MAX_CHARS) {
      preview = preview.slice(0, PREVIEW_MAX_CHARS);
    }
  };

  if (typeof content === 'string') {
    chars += content.length;
    appendPreview(content);
  } else {
    for (const part of asArray(content)) {
      const item = asRecord(part);
      if (isMediaPart(item)) {
        hasMedia = true;
      }
      if (typeof item['text'] === 'string') {
        chars += item['text'].length;
        appendPreview(item['text']);
      } else if (typeof item['think'] === 'string') {
        chars += item['think'].length;
        appendPreview(item['think']);
      } else {
        chars += estimateValueChars(part);
        if (typeof item['type'] === 'string') {
          appendPreview(`[${item['type']}]`);
        }
      }
    }
  }

  for (const tool of toolCalls) {
    const call = asRecord(tool);
    if (typeof call['name'] === 'string') chars += call['name'].length + 12;
    if (typeof call['arguments'] === 'string') chars += call['arguments'].length;
    else if (call['arguments'] !== undefined) chars += estimateValueChars(call['arguments']);
  }

  for (const tool of messageTools) {
    chars += estimateValueChars(tool);
    const desc = asRecord(tool)['description'];
    if (typeof desc === 'string') {
      appendPreview(desc);
    }
  }

  return { chars, hasMedia, preview };
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
  const legacyStatus = readLegacyStatus(agent);
  const loopData = loop.data();
  const profileData = profile.data();
  const request = loop.previewRequestContent();
  const modelAlias = loopData.modelAlias || profileData.modelAlias || legacyStatus?.model || undefined;
  return {
    systemPrompt: request.systemPrompt || profile.getSystemPrompt(),
    tools: request.tools.filter((tool) => tool.deferred !== true),
    messages: request.messages,
    modelAlias,
    tokens: {
      used: legacyStatus?.contextTokens ?? 0,
      max: legacyStatus?.maxContextTokens,
    },
  };
}

function buildContextSummary(
  sessionId: string,
  agentId: string,
  sources: ReturnType<typeof readAgentContextSources>,
): ContextSummary {
  const groupMap = new Map<string, ContextGroup>();
  let totalChars = 0;

  const addGroup = (role: string, chars: number, count = 1): void => {
    totalChars += chars;
    const existing = groupMap.get(role) ?? { role, count: 0, chars: 0 };
    existing.count += count;
    existing.chars += chars;
    groupMap.set(role, existing);
  };

  if (sources.systemPrompt.length > 0) {
    addGroup('system', sources.systemPrompt.length);
  }
  for (const tool of sources.tools) {
    addGroup('definition', estimateValueChars(tool));
  }
  for (const message of sources.messages) {
    const role = contextMessageRole(message);
    const { chars } = measureMessage(message, false);
    addGroup(role, chars, role === 'definition' ? asArray(asRecord(message)['tools']).length : 1);
  }

  return {
    session_id: sessionId,
    agent_id: agentId,
    captured_at: Date.now(),
    model: sources.modelAlias,
    tokens: sources.tokens,
    total_chars: totalChars,
    groups: [...groupMap.values()],
  };
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

function sanitizeMediaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMediaValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (isMediaPart(record)) return redactMediaPayload(record);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, sanitizeMediaValue(entry)]),
  );
}

function inspectContentParts(part: unknown): ContextItemPart[] {
  if (typeof part === 'string') return [{ kind: 'text', text: part }];
  if (Array.isArray(part)) return part.flatMap(inspectContentParts);
  const value = asRecord(part);
  if (typeof value['text'] === 'string') {
    return [{ kind: value['thought'] === true ? 'think' : 'text', text: value['text'] }];
  }
  const thinking = value['thinking'] ?? value['think'];
  if (typeof thinking === 'string') return [{ kind: 'think', text: thinking }];
  if (
    ['function', 'function_call', 'tool_use'].includes(String(value['type'])) ||
    value['functionCall'] !== undefined
  ) {
    const call = asRecord(value['function'] ?? value['functionCall'] ?? value);
    let args = call['arguments'] ?? call['args'] ?? call['input'];
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = call['arguments'];
      }
    }
    return [
      {
        kind: 'function',
        name: typeof call['name'] === 'string' ? call['name'] : undefined,
        data: args,
      },
    ];
  }
  if (value['type'] === 'tool_result' || value['functionResponse'] !== undefined) {
    const result = asRecord(value['functionResponse'] ?? value);
    const content = result['response'] ?? result['content'];
    return [
      {
        kind: 'result',
        name: typeof result['name'] === 'string' ? result['name'] : undefined,
        id: typeof value['tool_use_id'] === 'string' ? value['tool_use_id'] : undefined,
        failed: value['is_error'] === true,
        data: sanitizeMediaValue(content),
        children: inspectContentParts(content),
      },
    ];
  }
  if (isMediaPart(value)) {
    return [
      {
        kind: 'media',
        name: typeof value['type'] === 'string' ? value['type'] : 'media',
        data: sanitizeMediaValue(part),
      },
    ];
  }
  return [
    {
      kind: 'data',
      name: typeof value['type'] === 'string' ? value['type'] : undefined,
      data: sanitizeMediaValue(part),
    },
  ];
}

export function registerContextRoutes(app: ContextRouteHost, core: Scope): void {
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
        const summary = buildContextSummary(session_id, resolvedAgentId, sources);
        reply.send(okEnvelope(summary, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    summaryRoute.path,
    summaryRoute.options,
    summaryRoute.handler as Parameters<ContextRouteHost['get']>[2],
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
        const summary = buildContextSummary(session_id, resolvedAgentId, sources);
        const filterRoles = [
          ...new Set(
            (req.query.role === undefined
              ? []
              : Array.isArray(req.query.role)
                ? req.query.role
                : [req.query.role]
            )
              .map((role) => role.trim())
              .filter((role) => role.length > 0),
          ),
        ];
        const offset = req.query.offset ?? 0;
        const limit = req.query.limit ?? DEFAULT_ITEMS_LIMIT;

        const toolItems: ContextItemSummary[] = sources.tools.map((tool, index) => {
          const data = asRecord(tool);
          const desc = typeof data['description'] === 'string' ? data['description'] : '';
          return {
            id: `tool-${index}`,
            role: 'definition',
            name: typeof data['name'] === 'string' ? data['name'] : undefined,
            sequence: undefined,
            preview: desc.slice(0, PREVIEW_MAX_CHARS).replaceAll(/\s+/g, ' ').trim(),
            chars: estimateValueChars(tool),
            has_media: false,
          };
        });

        const allNonToolItems: ContextItemSummary[] = [];
        if (sources.systemPrompt.length > 0) {
          allNonToolItems.push({
            id: 'system',
            role: 'system',
            name: undefined,
            sequence: undefined,
            preview: sources.systemPrompt.slice(0, PREVIEW_MAX_CHARS).replaceAll(/\s+/g, ' ').trim(),
            chars: sources.systemPrompt.length,
            has_media: false,
          });
        }

        const toolNames = new Map<string, string>();
        sources.messages.forEach((message, index) => {
          const data = asRecord(message);
          const calls = asArray(data['toolCalls']);
          const messageTools = asArray(data['tools']);
          for (const tool of calls) {
            const call = asRecord(tool);
            if (typeof call['id'] === 'string' && typeof call['name'] === 'string') {
              toolNames.set(call['id'], call['name']);
            }
          }
          const callNames = calls
            .map((tool) => asRecord(tool)['name'])
            .filter((name): name is string => typeof name === 'string');
          const declaredToolNames = messageTools
            .map((tool) => asRecord(tool)['name'])
            .filter((name): name is string => typeof name === 'string');
          const role = contextMessageRole(message);
          const name =
            typeof data['toolCallId'] === 'string'
              ? (toolNames.get(data['toolCallId']) ?? data['toolCallId'])
              : callNames.join(', ') || declaredToolNames.join(', ') || undefined;
          const measured = measureMessage(message, true);
          allNonToolItems.push({
            id: `message-${index}`,
            role,
            name,
            sequence: index + 1,
            preview: measured.preview,
            chars: measured.chars,
            has_media: measured.hasMedia,
          });
        });

        const selection = selectContextItems(allNonToolItems, toolItems, filterRoles);
        const pagedItems = selection.items.slice(offset, offset + limit);
        reply.send(
          okEnvelope(
            {
              summary,
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
    itemsRoute.handler as Parameters<ContextRouteHost['get']>[2],
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
        const sources = readAgentContextSources(agent);

        let detail: ContextItemDetail | undefined;

        if (item_id === 'system') {
          detail = {
            id: 'system',
            role: 'system',
            name: undefined,
            sequence: undefined,
            chars: sources.systemPrompt.length,
            has_media: false,
            parts: splitSystemPromptParts(sources.systemPrompt),
            raw: sources.systemPrompt,
          };
        } else if (item_id.startsWith('tool-')) {
          const index = contextItemIndex(item_id, 'tool-');
          const tool = index === undefined ? undefined : sources.tools[index];
          if (tool !== undefined) {
            const data = asRecord(tool);
            detail = {
              id: item_id,
              role: 'definition',
              name: typeof data['name'] === 'string' ? data['name'] : undefined,
              sequence: undefined,
              chars: estimateValueChars(tool),
              has_media: false,
              parts: [{ kind: 'definition', name: typeof data['name'] === 'string' ? data['name'] : undefined, data: tool }],
              raw: tool,
            };
          }
        } else if (item_id.startsWith('message-')) {
          const index = contextItemIndex(item_id, 'message-');
          const message = index === undefined ? undefined : sources.messages[index];
          if (index !== undefined && message !== undefined) {
            const data = asRecord(message);
            const calls = asArray(data['toolCalls']);
            const messageTools = asArray(data['tools']);
            const callNames = calls
              .map((tool) => asRecord(tool)['name'])
              .filter((name): name is string => typeof name === 'string');
            const declaredToolNames = messageTools
              .map((tool) => asRecord(tool)['name'])
              .filter((name): name is string => typeof name === 'string');
            let resolvedToolName: string | undefined;
            if (typeof data['toolCallId'] === 'string') {
              const targetId = data['toolCallId'];
              for (let i = index - 1; i >= 0; i--) {
                const prevCalls = asArray(asRecord(sources.messages[i])['toolCalls']);
                const match = prevCalls.find((c) => asRecord(c)['id'] === targetId);
                if (match && typeof asRecord(match)['name'] === 'string') {
                  resolvedToolName = asRecord(match)['name'] as string;
                  break;
                }
              }
              resolvedToolName = resolvedToolName ?? targetId;
            } else if (callNames.length > 0) {
              resolvedToolName = callNames.join(', ');
            } else if (declaredToolNames.length > 0) {
              resolvedToolName = declaredToolNames.join(', ');
            }

            const measured = measureMessage(message, false);
            const parts: ContextItemPart[] = [
              ...inspectContentParts(data['content'] ?? []),
              ...messageTools.map((tool) => {
                const toolObj = asRecord(tool);
                return {
                  kind: 'definition',
                  name: typeof toolObj['name'] === 'string' ? toolObj['name'] : undefined,
                  data: sanitizeMediaValue(tool),
                };
              }),
              ...calls.map((tool) => {
                const call = asRecord(tool);
                let args = call['arguments'];
                if (typeof args === 'string') {
                  try {
                    args = JSON.parse(args);
                  } catch {
                    args = call['arguments'];
                  }
                }
                return {
                  kind: 'function',
                  name: typeof call['name'] === 'string' ? call['name'] : undefined,
                  data: args,
                };
              }),
            ];
            detail = {
              id: item_id,
              role: contextMessageRole(message),
              name: resolvedToolName,
              sequence: index + 1,
              chars: measured.chars,
              has_media: measured.hasMedia,
              parts,
              raw: sanitizeMediaValue(message),
            };
          }
        }

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
    itemDetailRoute.handler as Parameters<ContextRouteHost['get']>[2],
  );
}
