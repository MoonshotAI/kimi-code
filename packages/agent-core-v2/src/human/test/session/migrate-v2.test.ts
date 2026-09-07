import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createActor, waitFor } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, extractText } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';
import { createAgentMachine } from '#/agent/machine';
import { createTurnMachine } from '#/agent/turn';
import { createSessionMachine, type AgentActorRef } from '#/session/machine';
import { undoAgentTurns } from '#/session/undo';
import { loadSessionState, persistSession } from '#/persist/session';
import { openSessionStore } from '#/persist/open';
import { migrateV2Session } from '#/persist/v2/migrate';

const MAIN = 'main';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type SessionActor = ReturnType<typeof createTestSession>;

function createEchoRequester(): LlmRequester {
  return {
    generate: (_config, { messages }, { onEvent }) => {
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      onEvent?.({ type: 'llm.delta', part: { type: 'text', text: `echo:${text}` } });
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

function createTestSession() {
  const session = createActor(
    createSessionMachine({
      agent: createAgentMachine({
        tools: [],
        turnActor: createTurnMachine(createLlmMachine({ requester: createEchoRequester() })),
      }),
    }),
    { input: { request: { model } } },
  );
  session.start();
  return session;
}

function agentRef(session: SessionActor, agentId: string): AgentActorRef {
  const entry = session.getSnapshot().context.agents[agentId];
  expect(entry).toBeDefined();
  return (entry as { ref: AgentActorRef }).ref;
}

function submit(session: SessionActor, agentId: string, text: string): void {
  session.send({
    type: 'agent.send',
    agentId,
    event: { type: 'input.submit', message: createUserMessage(text) },
  });
}

interface V2AgentFixture {
  records: Record<string, unknown>[];
  blobs?: Record<string, string>;
  header?: string | null;
}

interface V2SessionFixture {
  meta?: Record<string, unknown>;
  agents: Record<string, V2AgentFixture>;
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeV2SessionDir(fixture: V2SessionFixture): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'v3-migrate-v2-'));
  dirs.push(dir);
  const meta = fixture.meta ?? {
    id: 'session_test',
    version: 2,
    cwd: '/work',
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    archived: false,
    agents: {},
    custom: {},
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  for (const [agentId, agent] of Object.entries(fixture.agents)) {
    const agentDir = join(dir, 'agents', agentId);
    await mkdir(agentDir, { recursive: true });
    const header =
      agent.header === null
        ? []
        : [agent.header ?? JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1700000000000 })];
    const lines = [...header, ...agent.records.map((record) => JSON.stringify(record))];
    await writeFile(join(agentDir, 'wire.jsonl'), `${lines.join('\n')}\n`);
    if (agent.blobs !== undefined) {
      const blobsDir = join(agentDir, 'blobs');
      await mkdir(blobsDir, { recursive: true });
      for (const [hash, content] of Object.entries(agent.blobs)) {
        await writeFile(join(blobsDir, hash), content);
      }
    }
  }
  return dir;
}

function appendUser(text: string, agentId = MAIN, origin?: unknown): Record<string, unknown> {
  return {
    type: 'context.append_message',
    agentId,
    time: 1,
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: origin ?? { kind: 'user' } },
  };
}

function turnPrompt(agentId = MAIN): Record<string, unknown> {
  return { type: 'turn.prompt', agentId, time: 1, input: [{ type: 'text', text: 'x' }], origin: { kind: 'user' } };
}

function stepBegin(uuid: string, agentId = MAIN): Record<string, unknown> {
  return { type: 'context.append_loop_event', agentId, time: 1, event: { type: 'step.begin', uuid, turnId: '0' } };
}

function contentPart(stepUuid: string, text: string, agentId = MAIN): Record<string, unknown> {
  return { type: 'context.append_loop_event', agentId, time: 1, event: { type: 'content.part', stepUuid, part: { type: 'text', text } } };
}

function toolCall(stepUuid: string, toolCallId: string, name: string, args: unknown, agentId = MAIN): Record<string, unknown> {
  return { type: 'context.append_loop_event', agentId, time: 1, event: { type: 'tool.call', stepUuid, toolCallId, name, args } };
}

function toolResult(toolCallId: string, output: unknown, agentId = MAIN): Record<string, unknown> {
  return { type: 'context.append_loop_event', agentId, time: 1, event: { type: 'tool.result', toolCallId, result: { output } } };
}

function stepEnd(uuid: string, extra: Record<string, unknown> = {}, agentId = MAIN): Record<string, unknown> {
  return { type: 'context.append_loop_event', agentId, time: 1, event: { type: 'step.end', uuid, ...extra } };
}

function assistantStep(uuid: string, text: string, agentId = MAIN): Record<string, unknown>[] {
  return [stepBegin(uuid, agentId), contentPart(uuid, text, agentId), stepEnd(uuid, { finishReason: 'end_turn' }, agentId)];
}

async function loadMigrated(dir: string): Promise<Awaited<ReturnType<typeof loadSessionState>>> {
  await migrateV2Session(dir);
  const opened = await openSessionStore(dir);
  return loadSessionState(opened.tree);
}

describe('migrateV2Session', () => {
  it('migrates a basic conversation with assistant meta, turn counter and session meta', async () => {
    const dir = await makeV2SessionDir({
      meta: {
        id: 'session_basic',
        version: 2,
        cwd: '/work',
        createdAt: 1700000000000,
        updatedAt: 1700000000001,
        archived: false,
        title: 'My Session',
        titleKind: 'custom',
        isCustomTitle: true,
        agents: {},
        custom: {},
      },
      agents: {
        [MAIN]: {
          records: [
            turnPrompt(),
            appendUser('hi'),
            { type: 'llm.request', agentId: MAIN, time: 1, kind: 'loop', provider: 'prov', model: 'mod', toolSelect: 'auto', systemPromptHash: 'h', toolsHash: 't', messageCount: 1 },
            stepBegin('s1'),
            contentPart('s1', 'hello '),
            contentPart('s1', 'world'),
            toolCall('s1', 'c1', 'bash', { cmd: 'ls' }),
            toolResult('c1', 'file.txt'),
            stepEnd('s1', {
              finishReason: 'tool_use',
              usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
              rawFinishReason: 'stop_raw',
              messageId: 'msg_v2_1',
            }),
            stepBegin('s2'),
            contentPart('s2', 'second'),
            stepEnd('s2', { finishReason: 'end_turn' }),
            { type: 'turn.ended', agentId: MAIN, time: 1, turnId: 0, reason: 'completed' },
          ],
        },
      },
    });
    const loaded = await loadMigrated(dir);
    expect(loaded.agents.map((agent) => agent.agentId)).toEqual([MAIN]);
    const agent = loaded.agents[0]!;
    expect(agent.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(agent.messages.map((entry) => extractText(entry.message))).toEqual([
      'hi',
      'hello world',
      'file.txt',
      'second',
    ]);
    expect(agent.messages[0]?.meta.source).toBe('input');
    const first = agent.messages[1];
    expect(first?.message.role).toBe('assistant');
    if (first?.message.role === 'assistant') {
      expect(first.message.content).toEqual([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ]);
      expect(first.message.toolCalls).toEqual([
        { type: 'function', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
      ]);
      expect(first.meta.usage).toEqual({ inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 });
      expect(first.meta.finish).toEqual({ finishReason: 'tool_calls', rawFinishReason: 'stop_raw' });
      expect(first.meta.messageId).toBe('msg_v2_1');
      expect(first.meta.model).toEqual({ provider: 'prov', model: 'mod' });
    }
    expect(agent.messages[2]?.meta.source).toBe('tool');
    const second = agent.messages[3];
    if (second?.message.role === 'assistant') {
      expect(second.meta.finish).toEqual({ finishReason: 'completed', rawFinishReason: null });
    }
    expect(agent.turnId).toBe(0);
    expect(loaded.meta).toMatchObject({
      id: 'session_basic',
      version: 2,
      cwd: '/work',
      title: 'My Session',
      titleKind: 'custom',
      archived: false,
    });
    expect(loaded.meta).not.toHaveProperty('isCustomTitle');
  });

  it('settles an interrupted tail and synthesizes missing tool results', async () => {
    const dir = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            turnPrompt(),
            appendUser('do'),
            stepBegin('s1'),
            contentPart('s1', 'working'),
            toolCall('s1', 'c1', 'bash', { cmd: 'x' }),
          ],
        },
      },
    });
    const loaded = await loadMigrated(dir);
    const agent = loaded.agents[0]!;
    expect(agent.messages.map((entry) => entry.message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(extractText(agent.messages[2]!.message)).toBe(
      'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
    );
    const assistant = agent.messages[1];
    if (assistant?.message.role === 'assistant') {
      expect(assistant.message.toolCalls.map((call) => call.id)).toEqual(['c1']);
    }
  });

  it('materializes undo and stops at a compaction boundary', async () => {
    const dir = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            turnPrompt(),
            appendUser('one'),
            ...assistantStep('s1', 'a1'),
            appendUser('two'),
            ...assistantStep('s2', 'a2'),
            { type: 'context.undo', agentId: MAIN, time: 1, count: 1 },
          ],
        },
      },
    });
    const loaded = await loadMigrated(dir);
    expect(loaded.agents[0]!.messages.map((entry) => extractText(entry.message))).toEqual(['one', 'a1']);

    const boundary = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            turnPrompt(),
            appendUser('old'),
            {
              type: 'context.apply_compaction',
              agentId: MAIN,
              time: 1,
              summary: 'SUM',
              compactedCount: 1,
              keptUserMessageCount: 1,
            },
            appendUser('new'),
            { type: 'context.undo', agentId: MAIN, time: 1, count: 2 },
          ],
        },
      },
    });
    const loadedBoundary = await loadMigrated(boundary);
    expect(loadedBoundary.agents[0]!.messages.map((entry) => extractText(entry.message))).toEqual([
      'old',
      'SUM',
      'new',
    ]);
  });

  it('materializes compaction in modern, elided and legacy shapes', async () => {
    const dir = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            appendUser('u1'),
            ...assistantStep('s1', 'a1'),
            appendUser('u2', MAIN, { kind: 'task', taskId: 't1', status: 'done', notificationId: 'n1' }),
            appendUser('u3'),
            {
              type: 'context.apply_compaction',
              agentId: MAIN,
              time: 1,
              summary: 'S',
              contextSummary: 'CTX',
              compactedCount: 3,
              keptUserMessageCount: 2,
            },
          ],
        },
      },
    });
    const loaded = await loadMigrated(dir);
    const agent = loaded.agents[0]!;
    expect(agent.messages.map((entry) => extractText(entry.message))).toEqual(['u1', 'u3', 'CTX']);
    expect(agent.messages.map((entry) => entry.meta.source)).toEqual(['input', 'input', 'compaction_summary']);

    const big = 'x'.repeat(90_000);
    const elided = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            appendUser(big),
            {
              type: 'context.apply_compaction',
              agentId: MAIN,
              time: 1,
              summary: 'BIG-SUM',
              compactedCount: 1,
              keptUserMessageCount: 2,
            },
          ],
        },
      },
    });
    const loadedElided = await loadMigrated(elided);
    const elidedMessages = loadedElided.agents[0]!.messages;
    expect(elidedMessages.map((entry) => entry.meta.source)).toEqual([
      'input',
      'injection',
      'input',
      'compaction_summary',
    ]);
    expect(extractText(elidedMessages[0]!.message)).toHaveLength(8_000);
    expect(extractText(elidedMessages[1]!.message)).toContain('roughly 2499 tokens');
    expect(extractText(elidedMessages[2]!.message)).toHaveLength(72_000);
    expect(extractText(elidedMessages[3]!.message)).toBe('BIG-SUM');

    const legacy = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            appendUser('u1'),
            appendUser('u2'),
            appendUser('u3'),
            { type: 'context.apply_compaction', agentId: MAIN, time: 1, summary: 'LEG', compactedCount: 2 },
          ],
        },
      },
    });
    const loadedLegacy = await loadMigrated(legacy);
    expect(loadedLegacy.agents[0]!.messages.map((entry) => extractText(entry.message))).toEqual(['LEG', 'u3']);
  });

  it('migrates multiple agents with todo state', async () => {
    const dir = await makeV2SessionDir({
      agents: {
        [MAIN]: { records: [turnPrompt(), appendUser('main-msg')] },
        'agent-1': {
          records: [
            turnPrompt('agent-1'),
            appendUser('sub', 'agent-1', { kind: 'task', taskId: 't1', status: 'done', notificationId: 'n1' }),
            {
              type: 'tools.update_store',
              agentId: 'agent-1',
              time: 1,
              key: 'todo',
              value: [
                { title: 'task a', status: 'in_progress' },
                { title: 'missing status' },
              ],
            },
          ],
        },
      },
    });
    const loaded = await loadMigrated(dir);
    expect(loaded.agents.map((agent) => agent.agentId)).toEqual(['agent-1', MAIN]);
    const sub = loaded.agents[0]!;
    expect(sub.messages[0]?.meta.source).toBe('task');
    expect(sub.states['todo']).toEqual({
      todos: [{ title: 'task a', status: 'in_progress' }],
      lastWriteTurn: 0,
    });
  });

  it('resolves blobrefs inline and substitutes missing media', async () => {
    const dir = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [
            {
              type: 'context.append_message',
              agentId: MAIN,
              time: 1,
              message: {
                role: 'user',
                content: [{ type: 'image_url', imageUrl: { url: 'blobref:image/png;hash1' } }],
                toolCalls: [],
              },
            },
            {
              type: 'context.append_message',
              agentId: MAIN,
              time: 1,
              message: {
                role: 'user',
                content: [{ type: 'image_url', imageUrl: { url: 'blobref:image/png;nohash' } }],
                toolCalls: [],
              },
            },
          ],
          blobs: { hash1: 'fakepng' },
        },
      },
    });
    const loaded = await loadMigrated(dir);
    const agent = loaded.agents[0]!;
    const first = agent.messages[0]?.message.content[0];
    expect(first).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${Buffer.from('fakepng').toString('base64')}` },
    });
    const second = agent.messages[1]?.message.content[0];
    expect(second).toEqual({ type: 'image_url', imageUrl: { url: '[media missing]' } });
  });

  it('handles legacy protocol versions and rejects newer ones', async () => {
    const headerless = await makeV2SessionDir({
      agents: { [MAIN]: { header: null, records: [appendUser('legacy')] } },
    });
    const loadedHeaderless = await loadMigrated(headerless);
    expect(loadedHeaderless.agents[0]!.messages.map((entry) => extractText(entry.message))).toEqual(['legacy']);

    const v10 = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          header: JSON.stringify({ type: 'metadata', protocol_version: '1.0', created_at: 1700000000000 }),
          records: [
            {
              type: 'context.append_message',
              agentId: MAIN,
              time: 1,
              message: {
                role: 'assistant',
                content: [],
                toolCalls: [{ type: 'function', id: 'c1', function: { name: 'bash', arguments: '{"a":1}' } }],
              },
            },
          ],
        },
      },
    });
    const loadedV10 = await loadMigrated(v10);
    const assistant = loadedV10.agents[0]!.messages[0];
    if (assistant?.message.role === 'assistant') {
      expect(assistant.message.toolCalls).toEqual([
        { type: 'function', id: 'c1', name: 'bash', arguments: '{"a":1}' },
      ]);
    }

    const newer = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          header: JSON.stringify({ type: 'metadata', protocol_version: '9.9', created_at: 1700000000000 }),
          records: [appendUser('future')],
        },
      },
    });
    await expect(migrateV2Session(newer)).rejects.toMatchObject({ code: 'unsupported-wire-version' });
  });

  it('openSessionStore migrates once, and the restored session continues and undoes', async () => {
    const dir = await makeV2SessionDir({
      agents: {
        [MAIN]: {
          records: [turnPrompt(), appendUser('first'), ...assistantStep('s1', 'first-reply')],
        },
      },
    });
    const first = await openSessionStore(dir);
    expect(first.migrated).toBe(true);

    const loaded = await loadSessionState(first.tree);
    const session = createTestSession();
    const persistence = persistSession(session, first.tree, {
      branches: new Map(loaded.agents.map((agent) => [agent.agentId, agent.branch])),
    });
    for (const agent of loaded.agents) {
      session.send({
        type: 'agent.create',
        agentId: agent.agentId,
        input: { history: agent.messages, turnId: agent.turnId, branchId: agent.branch },
      });
    }
    submit(session, MAIN, 'again');
    await waitFor(agentRef(session, MAIN), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });

    const undone = await undoAgentTurns(session, first.tree, MAIN, 1);
    expect(undone.messages.map((entry) => extractText(entry.message))).toEqual(['first', 'first-reply']);
    await persistence.flush();
    persistence.dispose();
    session.stop();

    const second = await openSessionStore(dir);
    expect(second.migrated).toBe(false);
    const reloaded = await loadSessionState(second.tree);
    expect(reloaded.agents.map((agent) => agent.agentId)).toEqual([MAIN]);
    expect(reloaded.agents[0]!.messages.map((entry) => extractText(entry.message))).toEqual([
      'first',
      'first-reply',
    ]);
    const names = await readdir(dir);
    expect(names.filter((name) => name.startsWith('.v3-migrate'))).toEqual([]);
    expect(names).toContain('state.json');
    expect(names).toContain('agents');
    expect(names).toContain('trees');
  });
});
