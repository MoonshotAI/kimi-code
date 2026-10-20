import { describe, expect, it } from 'vitest';

import { createFeature, useSession, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import {
  INTERACTION_TAG_AGENT_ID,
  InteractionRef,
  interaction,
  isInteractionCancellation,
  type InteractionEvent,
  type Interactions,
} from '#/features/interaction/index';
import { createHarness, harnessInternals, memoryHarnessSpace, type Harness } from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function echoRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest: GenerateRest) => {
      const messages = rest.content?.messages ?? [];
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      return textOutcome(`echo:${text}`);
    },
  };
  return self;
}

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

type InteractionRefs = Map<string, Readonly<ShallowRef<Interactions | undefined>>>;

function captureInteractions(): { feature: Feature; refs: InteractionRefs } {
  const refs: InteractionRefs = new Map();
  const feature = createFeature('interaction-capture', {
    session: () => {
      refs.set(useSession().id, useInject(InteractionRef));
    },
  });
  return { feature, refs };
}

function interactionsOf(refs: InteractionRefs, sessionId: string): Interactions {
  const interactions = refs.get(sessionId)?.value;
  if (interactions === undefined) throw new Error(`no interactions captured for session '${sessionId}'`);
  return interactions;
}

async function start(sessionIds: readonly string[]): Promise<{ harness: Harness; refs: InteractionRefs }> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const { feature, refs } = captureInteractions();
  await harness.app.features.add(interaction);
  await harness.app.features.add(feature);
  for (const sessionId of sessionIds) await harness.app.create({ sessionId });
  return { harness, refs };
}

function liveSession(harness: Harness, sessionId: string) {
  const session = harness.app.sessions.get(sessionId);
  if (session === undefined) throw new Error(`session '${sessionId}' is not live`);
  return session;
}

describe('interaction feature', () => {
  it('emits interaction.requested with the full interaction on enqueue', async () => {
    const { harness, refs } = await start(['s1']);
    const events: InteractionEvent[] = [];
    harness.app.on(interaction, 'interaction.requested', (event) => events.push(event));
    harness.app.on(interaction, 'interaction.resolved', (event) => events.push(event));
    const interactions = interactionsOf(refs, 's1');
    const item = interactions.enqueue({
      kind: 'question',
      payload: { prompt: 'continue?' },
      tags: { [INTERACTION_TAG_AGENT_ID]: 'main' },
    });
    expect(item.id).toBe('main:interaction-0');
    expect(item.createdAt).toBeGreaterThan(0);
    expect(events).toHaveLength(1);
    const requested = events[0];
    if (requested?.type !== 'interaction.requested') throw new Error('expected interaction.requested');
    expect(requested.interaction).toEqual(item);
    expect(requested['sessionId']).toBe('s1');
    expect(interactions.respond(item.id, 'yes')).toBe(true);
    expect(events).toHaveLength(2);
    const resolved = events[1];
    if (resolved?.type !== 'interaction.resolved') throw new Error('expected interaction.resolved');
    expect(resolved.id).toBe(item.id);
    expect(resolved.response).toBe('yes');
    expect(resolved.interaction).toEqual(item);
    await harness.close();
  });

  it('resolves request promises through respond and keeps records queryable', async () => {
    const { harness, refs } = await start(['s1']);
    const interactions = interactionsOf(refs, 's1');
    const promise = interactions.request<{ command: string }, string>({
      kind: 'approval',
      payload: { command: 'rm -rf build' },
    });
    const pending = interactions.findAll({ resolved: false });
    const record = pending[0];
    if (record === undefined) throw new Error('expected a pending interaction');
    expect(record.kind).toBe('approval');
    expect(interactions.respond(record.id, 'approved')).toBe(true);
    await expect(promise).resolves.toBe('approved');
    expect(interactions.respond(record.id, 'again')).toBe(false);
    expect(interactions.respond('interaction-missing', 'x')).toBe(false);
    expect(interactions.findOne({ id: record.id })?.kind).toBe('approval');
    expect(interactions.findAll({ resolved: true })).toHaveLength(1);
    expect(interactions.findAll({ resolved: false })).toHaveLength(0);
    await harness.close();
  });

  it('keeps a pending interaction unresolved across turn boundaries', async () => {
    const { harness, refs } = await start(['s1']);
    const session = liveSession(harness, 's1');
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', echoRequester());
    const interactions = interactionsOf(refs, 's1');
    const promise = interactions.request<unknown, string>({
      kind: 'question',
      payload: { prompt: 'answer later' },
      tags: { [INTERACTION_TAG_AGENT_ID]: 'main' },
    });
    const outcome = await agent.loop.runTurn(user('hello'));
    expect(outcome.type).toBe('done');
    await agent.flush();
    const replies = agent.view
      .getState()
      .messages.filter((entry) => entry.message.role === 'assistant')
      .map((entry) => extractText(entry.message));
    expect(replies).toEqual(['echo:hello']);
    const stillPending = interactions.findAll({ resolved: false });
    const record = stillPending[0];
    if (record === undefined || stillPending.length !== 1) throw new Error('turn end cancelled the interaction');
    expect(interactions.respond(record.id, 'late-answer')).toBe(true);
    await expect(promise).resolves.toBe('late-answer');
    await harness.close();
  });

  it('cancels only the closed agent pending interactions with agent_closed', async () => {
    const { harness, refs } = await start(['s1']);
    const session = liveSession(harness, 's1');
    await harness.ensureAgent(session, 'main');
    await harness.ensureAgent(session, 'sub');
    const resolved: Array<{ id: string; response: unknown }> = [];
    harness.app.on(interaction, 'interaction.resolved', (event) => {
      resolved.push({ id: event.id, response: event.response });
    });
    const interactions = interactionsOf(refs, 's1');
    const mainPending = interactions.request<unknown, unknown>({
      kind: 'question',
      payload: {},
      tags: { [INTERACTION_TAG_AGENT_ID]: 'main' },
    });
    const subPending = interactions.request<unknown, unknown>({
      kind: 'question',
      payload: {},
      tags: { [INTERACTION_TAG_AGENT_ID]: 'sub' },
    });
    await session.close('main');
    const mainResponse = await mainPending;
    if (!isInteractionCancellation(mainResponse)) throw new Error('expected a cancellation');
    expect(mainResponse.reason).toBe('agent_closed');
    expect(interactions.findAll({ resolved: false })).toHaveLength(1);
    await session.close('sub');
    const subResponse = await subPending;
    if (!isInteractionCancellation(subResponse)) throw new Error('expected a cancellation');
    expect(subResponse.reason).toBe('agent_closed');
    expect(resolved).toHaveLength(2);
    expect(resolved.every((event) => isInteractionCancellation(event.response))).toBe(true);
    await harness.close();
  });

  it('keeps an independent registry per session', async () => {
    const { harness, refs } = await start(['s1', 's2']);
    const requested: Array<{ sessionId: unknown; id: string }> = [];
    harness.app.on(interaction, 'interaction.requested', (event) => {
      requested.push({ sessionId: event['sessionId'], id: event.interaction.id });
    });
    const first = interactionsOf(refs, 's1');
    const second = interactionsOf(refs, 's2');
    expect(first).not.toBe(second);
    const pending = first.request<unknown, unknown>({ kind: 'approval', payload: {} });
    expect(first.findAll()).toHaveLength(1);
    expect(second.findAll()).toHaveLength(0);
    expect(requested).toEqual([{ sessionId: 's1', id: 'interaction-0' }]);
    const other = second.request<unknown, string>({ kind: 'approval', payload: {} });
    await harness.app.close('s1');
    const response = await pending;
    if (!isInteractionCancellation(response)) throw new Error('expected a cancellation');
    expect(response.reason).toBe('agent_closed');
    expect(second.respond('interaction-0', 'ok')).toBe(true);
    await expect(other).resolves.toBe('ok');
    await harness.close();
  });
});
