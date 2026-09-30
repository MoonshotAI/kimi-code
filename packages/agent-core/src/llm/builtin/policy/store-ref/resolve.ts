import { resolveEndpoint } from '#/llm/endpoint';
import { isMediaPart, mediaKeyOf, type ContentPart, type MediaPart, type Message } from '#/llm/message';
import type { MessageResolveContext, MessageResolver } from '#/llm/policy/resolver';
import type { LlmNoticeSink } from '#/llm/response';

import { accountOf } from './account';
import {
  UploadAuthError,
  materializePart,
  omittedText,
  type Materialized,
  type ResolveContext,
} from './materialize';
import type { StoreRefPorts } from './ports';
import { createSession, type StoreRefResolverOptions, type StoreRefSession } from './session';

interface BudgetEntry {
  readonly message: Message;
  readonly partIndex: number;
  readonly key: string;
  readonly bytes: number;
  readonly part: MediaPart;
}

const MB = 1024 * 1024;

function resolvedPart(part: MediaPart, materialized: Materialized): ContentPart {
  if (materialized.form === 'omit') return { type: 'text', text: materialized.text };
  return { ...part, source: materialized.source };
}

async function applyBudget(
  entries: readonly BudgetEntry[],
  ctx: ResolveContext,
  report: LlmNoticeSink,
): Promise<void> {
  const { budget, budgetDropped } = ctx.session;
  const pending = new Map<string, number>();
  for (const entry of entries) pending.set(entry.key, (pending.get(entry.key) ?? 0) + entry.bytes);
  let total = [...pending.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total <= budget.maxBytes) return;
  const droppedNow = new Set<string>();
  for (const [key, bytes] of pending) {
    if (total <= budget.lowBytes) break;
    droppedNow.add(key);
    budgetDropped.add(key);
    total -= bytes;
  }
  for (const entry of entries) {
    if (!droppedNow.has(entry.key)) continue;
    entry.message.content[entry.partIndex] = resolvedPart(
      entry.part,
      await omittedText(entry.part, 'budget', ctx),
    );
  }
  report({
    code: 'media-budget-exceeded',
    message: `Conversation media exceeded the ${String(budget.maxBytes / MB)} MB per-request budget; ${String(droppedNow.size)} older media item(s) were omitted.`,
    data: { dropped: droppedNow.size, budgetBytes: budget.maxBytes },
  });
}

async function resolveWith(
  messages: readonly Message[],
  ctx: ResolveContext,
  report: LlmNoticeSink,
): Promise<readonly Message[]> {
  let changed = false;
  const out: Message[] = [];
  const entries: BudgetEntry[] = [];
  for (const message of messages) {
    if (!message.content.some(isMediaPart)) {
      out.push(message);
      continue;
    }
    const position = message.role === 'tool' ? 'tool_result' : 'content';
    const resolved: Message = { ...message, content: [] };
    for (const part of message.content) {
      if (!isMediaPart(part)) {
        resolved.content.push(part);
        continue;
      }
      const key = mediaKeyOf(part);
      const materialized =
        part.omitted === undefined && ctx.session.budgetDropped.has(key)
          ? await omittedText(part, 'budget', ctx)
          : await materializePart(part, position, ctx);
      if (materialized.form === 'media' && materialized.source.kind === 'inline') {
        const bytes = materialized.source.data.length;
        entries.push({ message: resolved, partIndex: resolved.content.length, key, bytes, part });
      }
      resolved.content.push(resolvedPart(part, materialized));
    }
    changed = true;
    out.push(resolved);
  }
  await applyBudget(entries, ctx, report);
  return changed ? out : messages;
}

async function resolveMessages(
  messages: readonly Message[],
  input: MessageResolveContext,
  ports: StoreRefPorts,
  session: StoreRefSession,
): Promise<readonly Message[]> {
  const contextOf = async (): Promise<ResolveContext> => {
    const endpoint = await resolveEndpoint(input.endpoint);
    return {
      ...ports,
      model: input.model,
      endpoint,
      account: await accountOf(input.model, endpoint),
      media: input.media,
      signal: input.signal,
      session,
      files: input.endpoint?.files,
    };
  };
  try {
    return await resolveWith(messages, await contextOf(), input.report);
  } catch (error) {
    if (!(error instanceof UploadAuthError)) throw error;
    const credentials = input.endpoint?.credentials;
    if (credentials?.canRecover?.(error) !== true) throw error;
    credentials.invalidate?.();
    return resolveWith(messages, await contextOf(), input.report);
  }
}

export function createStoreRefResolver(
  ports: StoreRefPorts,
  options?: StoreRefResolverOptions,
): MessageResolver {
  const session = createSession(options);
  return {
    id: 'store-ref',
    resolve: (messages, ctx) => resolveMessages(messages, ctx, ports, session),
  };
}
