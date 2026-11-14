import {
  Error2,
  ErrorCodes,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentToolSelectService,
  resumeSessionById,
  type ContextMessage,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
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
  role: z.string().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const DEFAULT_ITEMS_LIMIT = 100;
const PREVIEW_MAX_CHARS = 240;
const MEDIA_TYPES = new Set([
  'image',
  'image_url',
  'input_image',
  'audio',
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
  message: ContextMessage,
  includePreview: boolean,
): { chars: number; hasMedia: boolean; preview: string } {
  const data = asRecord(message);
  const content = data['content'];
  const toolCalls = asArray(data['toolCalls']);
  let chars = 0;
  let hasMedia = false;
  let preview = '';

  const appendPreview = (chunk: string): void => {
    if (!includePreview || preview.length >= PREVIEW_MAX_CHARS || !chunk) return;
    const needed = PREVIEW_MAX_CHARS - preview.length + 32;
    const slice = chunk.slice(0, needed).replace(/\s+/g, ' ').trim();
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
  const agent = session.accessor.get(IAgentLifecycleService).handleOf(resolvedAgentId);
  if (agent === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `Agent not found: ${resolvedAgentId}`);
  }
  return { agent, resolvedAgentId };
}

function readAgentContextSources(agent: IAgentScopeHandle) {
  const profile = agent.accessor.get(IAgentProfileService);
  const toolSelect = agent.accessor.get(IAgentToolSelectService);
  const contextMemory = agent.accessor.get(IAgentContextMemoryService);
  const legacyStatus = readLegacyStatus(agent);
  const systemPrompt = profile.getSystemPrompt();
  const tools = toolSelect.defaultTools().filter((t) => t.deferred !== true);
  const messages = contextMemory.get();
  const modelAlias = profile.data().modelAlias || legacyStatus?.model || undefined;
  return {
    systemPrompt,
    tools,
    messages,
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

  const addGroup = (role: string, chars: number): void => {
    totalChars += chars;
    const existing = groupMap.get(role) ?? { role, count: 0, chars: 0 };
    existing.count += 1;
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
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const { chars } = measureMessage(message, false);
    addGroup(role, chars);
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

function sanitizeMediaValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 512 && (value.startsWith('data:') || !/\s/.test(value.slice(0, 256)))) {
      return `[encoded media · ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeMediaValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeMediaValue(v);
    }
    return out;
  }
  return value;
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
        const filterRole = req.query.role ? req.query.role.trim() : '';
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
            preview: desc.slice(0, PREVIEW_MAX_CHARS).replace(/\s+/g, ' ').trim(),
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
            preview: sources.systemPrompt.slice(0, PREVIEW_MAX_CHARS).replace(/\s+/g, ' ').trim(),
            chars: sources.systemPrompt.length,
            has_media: false,
          });
        }

        const toolNames = new Map<string, string>();
        sources.messages.forEach((message, index) => {
          const data = asRecord(message);
          const calls = asArray(data['toolCalls']);
          for (const tool of calls) {
            const call = asRecord(tool);
            if (typeof call['id'] === 'string' && typeof call['name'] === 'string') {
              toolNames.set(call['id'], call['name']);
            }
          }
          const callNames = calls
            .map((tool) => asRecord(tool)['name'])
            .filter((name): name is string => typeof name === 'string');
          const role = typeof data['role'] === 'string' ? data['role'] : 'unknown';
          const name =
            typeof data['toolCallId'] === 'string'
              ? (toolNames.get(data['toolCallId']) ?? data['toolCallId'])
              : callNames.join(', ') || undefined;
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

        const candidateItems =
          filterRole === 'definition'
            ? toolItems
            : filterRole
              ? allNonToolItems.filter((item) => item.role === filterRole)
              : allNonToolItems;

        const pagedItems = candidateItems.slice(offset, offset + limit);
        reply.send(
          okEnvelope(
            {
              summary,
              tools: !filterRole || filterRole === 'definition' ? toolItems : [],
              items: pagedItems,
              total: candidateItems.length,
              has_more: offset + pagedItems.length < candidateItems.length,
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
            parts: [{ kind: 'text', text: sources.systemPrompt }],
            raw: sources.systemPrompt,
          };
        } else if (item_id.startsWith('tool-')) {
          const index = Number.parseInt(item_id.slice('tool-'.length), 10);
          const tool = Number.isFinite(index) ? sources.tools[index] : undefined;
          if (tool !== undefined) {
            const data = asRecord(tool);
            detail = {
              id: item_id,
              role: 'definition',
              name: typeof data['name'] === 'string' ? data['name'] : undefined,
              sequence: undefined,
              chars: estimateValueChars(tool),
              has_media: false,
              parts: [{ kind: 'data', data: tool }],
              raw: tool,
            };
          }
        } else if (item_id.startsWith('message-')) {
          const index = Number.parseInt(item_id.slice('message-'.length), 10);
          const message = Number.isFinite(index) ? sources.messages[index] : undefined;
          if (message !== undefined) {
            const data = asRecord(message);
            const calls = asArray(data['toolCalls']);
            const callNames = calls
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
            }

            const measured = measureMessage(message, false);
            const parts: ContextItemPart[] = [
              ...inspectContentParts(data['content'] ?? []),
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
              role: typeof data['role'] === 'string' ? data['role'] : 'unknown',
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
