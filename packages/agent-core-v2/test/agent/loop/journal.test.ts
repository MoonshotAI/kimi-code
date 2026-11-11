import { describe, expect, it } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';

import {
  dehydrateLoopJournalRecord,
  LoopJournal,
  restoreLoopJournal,
} from '#/agent/loop/journal';
import { createLoop } from '@moonshot-ai/core/loop/index';
import { successfulExecutor } from './core/executor';
import { usableOutputOf } from '@moonshot-ai/core/llm/policy/settle';
import { contextFromHistoryEntry } from '#/agent/loop/history';
import { createUserEntry, type UserEntry } from '@moonshot-ai/core/history/history';
import { createAssistantMessage, createUserMessage, type ToolCall } from '@moonshot-ai/core/llm/message';
import type { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { normalizeLegacyTurnSteerRecords } from '#/wire/human';
import { computeForkLine, parseTree, restorableChain } from '#/wire/tree/index';
import { fromPersistentWireRecord, toPersistentWireRecord } from '#/wire/wireService';
import { recordingWireLog, registerTestAgentWire, registerTestEventDispatcher, stubAgentWire } from '../../wire/stubs';

function prompt(id: string, text = id): UserEntry {
  return createUserEntry(createUserMessage(text), { source: 'input', promptId: id });
}

function assistant(text: string, toolCalls: ToolCall[] = []) {
  return { message: createAssistantMessage([{ type: 'text' as const, text }], toolCalls), meta: { source: 'llm' } };
}

function memoryWire(records: WireRecord[]): IWireService {
  return {
    ...stubAgentWire(),
    append: (record) => {
      records.push(record);
    },
    readHumanChain: () => records.map((record, index) => ({ record, line: index + 1 })),
    readLoopChain: () => records.map((record, index) => ({ record, line: index + 1 })),
  };
}

describe('loop journal restore', () => {
  it('restores public history and turn clock while ignoring agent records', () => {
    const snapshot = restoreLoopJournal([
      { type: 'agent.message.appended', message: prompt('ignored') },
      { type: 'profile.bind', agentId: 'main', thinkingEffort: 'off', systemPrompt: 'from-bind', disallowedTools: [] },
      { type: 'config.update', agentId: 'main', systemPrompt: 'from-update' },
      { type: 'context.append_message', message: contextFromHistoryEntry(prompt('old')) },
      { type: 'turn.prompt', input: [], trigger: 'normal', origin: { kind: 'user' }, turnId: 0 },
      { type: 'turn.cancel', turnId: 2, target: 'queued' },
      { type: 'turn.prompt', input: [], trigger: 'normal', origin: { kind: 'user' } },
      { type: 'agent.turn.started', turnId: 99, trigger: 'normal' },
    ]);

    expect(snapshot.input.messages!.map((entry) => entry.message)).toMatchObject([prompt('old').message]);
    expect(snapshot.input.nextTurnId).toBe(3);
    const promptBeforeMessage = restoreLoopJournal([
      { type: 'turn.prompt', input: [], trigger: 'normal', origin: { kind: 'user' }, promptId: 'old', turnId: 0 },
      { type: 'context.append_message', message: contextFromHistoryEntry(prompt('old')) },
      { type: 'turn.ended', turnId: 0, reason: 'completed' },
    ]);
    expect(promptBeforeMessage.input.messages!.map((entry) => entry.message)).toMatchObject([prompt('old').message]);
    expect(promptBeforeMessage.input.nextTurnId).toBe(1);
    expect(snapshot.input.profile?.systemPrompt).toBe('from-update');
    expect(snapshot.input.unfinished).toBeUndefined();
  });

  it('settles interrupted public step and tool records without inventing an unfinished resume', () => {
    const snapshot = restoreLoopJournal([
      { type: 'context.append_message', message: contextFromHistoryEntry(prompt('first')) },
      { type: 'turn.prompt', input: [], trigger: 'normal', origin: { kind: 'user' }, turnId: 2 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step', turnId: '2', step: 1 } },
      { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step', turnId: '2', step: 1, part: { type: 'text', text: 'working' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', stepUuid: 'step', turnId: '2', step: 1, toolCallId: 'bg', name: 'Bash', args: {} } },
      { type: 'agent.tool.async_ended', toolCallId: 'bg', entry: prompt('ignored') },
    ]);

    expect(snapshot.input.messages!.map((entry) => entry.message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(snapshot.input.messages![1]?.meta?.partial).toBeUndefined();
    expect(snapshot.input.messages![2]).toMatchObject({
      message: { role: 'tool', toolCallId: 'bg' },
      meta: { isError: true },
    });
    expect(snapshot.input.nextTurnId).toBe(3);
    expect(snapshot.input.unfinished).toBeUndefined();
    const loop = createLoop({ input: snapshot.input, executor: successfulExecutor(['Bash'], '') });
    expect(loop.state.status).toBe('idle');
    expect(loop.state.nextTurnId).toBe(3);
    const partial = usableOutputOf({
      role: 'assistant',
      content: [
        { type: 'think', think: 'before' },
        { type: 'think', think: 'signed', encrypted: 'sig' },
        { type: 'think', think: 'after' },
        { type: 'text', text: 'answer' },
        { type: 'text', text: ' ' },
      ],
      toolCalls: [],
    });
    expect(partial?.content).toEqual([
      { type: 'think', think: 'before' },
      { type: 'think', think: 'signed', encrypted: 'sig' },
      { type: 'text', text: 'answer' },
    ]);
    expect(usableOutputOf({
      role: 'assistant',
      content: [{ type: 'think', think: 'unsigned' }, { type: 'text', text: ' ' }],
      toolCalls: [],
    })).toBeNull();
  });

  it('writes one prompt per turn and converts legacy steers on read', () => {
    const records: WireRecord[] = [];
    const journal = new LoopJournal(memoryWire(records), 'main');
    const prior = prompt('prior');
    const first = prompt('p1');
    const second = prompt('p2');
    journal.append({ type: 'message.appended', turnId: 0, step: 0, source: 'remind', entry: prior });
    expect(records).toMatchObject([{ type: 'context.append_message' }]);
    journal.append({ type: 'prompt.submitted', entry: prompt('active') });
    journal.append({ type: 'turn.started', turnId: 0, trigger: 'normal', entry: prompt('active') });
    journal.append({ type: 'message.appended', turnId: 0, step: 0, source: 'normal', entry: prompt('active') });
    journal.append({ type: 'prompt.submitted', entry: first });
    journal.append({ type: 'prompt.submitted', entry: second });
    journal.append({ type: 'prompt.steered', promptIds: ['p1', 'p2'], entries: [first, second] });
    journal.append({ type: 'turn.ended', turnId: 0, outcome: { type: 'done' } });
    journal.append({ type: 'turn.started', turnId: 1, trigger: 'notify', promptOnly: true, entry: first });
    journal.append({ type: 'message.appended', turnId: 1, step: 0, source: 'notify', entry: first });
    journal.append({ type: 'turn.ended', turnId: 1, outcome: { type: 'done' } });
    journal.append({ type: 'turn.started', turnId: 2, trigger: 'notify', entry: second });
    journal.append({ type: 'message.appended', turnId: 2, step: 0, source: 'notify', entry: second });
    journal.append({ type: 'turn.ended', turnId: 2, outcome: { type: 'done' } });

    expect(records.filter((record) => record.type === 'turn.steer')).toHaveLength(0);
    expect(records.filter((record) => record.type === 'turn.prompt')).toMatchObject([
      { turnId: 0, promptId: 'active' },
      { turnId: 1, promptId: 'p1', trigger: 'notify' },
      { turnId: 2, promptId: 'p2', trigger: 'notify' },
    ]);
    expect(records.every((record) => !record.type.startsWith('agent.'))).toBe(true);
    expect(journal.snapshot().input.messages!.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'user']);
    expect(journal.snapshot().input.messages![0]?.message).toMatchObject(prior.message);

    const historical = normalizeLegacyTurnSteerRecords([
      { type: 'turn.prompt', turnId: 0, input: [], origin: { kind: 'user' } },
      { type: 'turn.steer', turnId: 0, input: [{ type: 'text', text: 'first' }], origin: { kind: 'user' }, messageId: 'p1' },
      { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 2 } },
      { type: 'turn.steer', turnId: 0, input: [{ type: 'text', text: 'second' }], origin: { kind: 'user' }, messageId: 'p2' },
      { type: 'turn.ended', turnId: 0, reason: 'completed' },
    ]);
    expect(historical.map((record) => record.type)).toEqual([
      'turn.prompt',
      'turn.ended',
      'turn.prompt',
      'context.append_loop_event',
      'turn.ended',
      'turn.prompt',
      'turn.ended',
    ]);
    expect(historical.filter((record) => record.type === 'turn.prompt')).toMatchObject([
      { turnId: 0 },
      { turnId: 1, promptId: 'p1', trigger: 'notify' },
      { turnId: 2, promptId: 'p2', trigger: 'notify' },
    ]);
    expect(historical[3]).toMatchObject({ event: { turnId: '1', step: 1 } });
    expect(historical.at(-1)).toMatchObject({ turnId: 2 });
  });

  it('round-trips public message media and rich metadata through persistent Wire encoding', () => {
    const entry = {
      message: {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'image', contentType: 'text/markdown', meta: { kind: 'skill' } },
          { type: 'image_url' as const, imageUrl: { url: 'kimi-file://image', id: 'image', name: 'image.png' } },
        ],
      },
      meta: { source: 'input', toolCallId: 'call-1' },
    };
    const record: WireRecord = {
      type: 'context.append_message',
      message: contextFromHistoryEntry(entry),
    };

    const persistent = toPersistentWireRecord(record);
    const restored = fromPersistentWireRecord(persistent);
    expect(restored).toEqual(record);

    const dehydrated = dehydrateLoopJournalRecord(record, async () => [{ type: 'text', text: 'offloaded' }]);
    return expect(dehydrated).resolves.toMatchObject({
      message: { content: [{ type: 'text', text: 'offloaded' }] },
    });
  });

  it('writes public records into the real Wire active chain and restores them after persistence', async () => {
    const persisted: WireRecord[] = [];
    const ix = new TestInstantiationService();
    try {
      const wire = registerTestAgentWire(ix, 'wire/loop-journal', { log: recordingWireLog(persisted), agentId: 'main' });
      const dispatcher = registerTestEventDispatcher(ix);
      const journal = new LoopJournal(wire, 'main', dispatcher);
      const entry: UserEntry = {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'media', contentType: 'text/markdown' },
            { type: 'image_url', imageUrl: { url: 'kimi-file://image', id: 'image' } },
          ],
        },
        meta: { source: 'input', promptId: 'media' },
      };
      const answer = assistant('answer', [
        {
          type: 'function',
          id: 'local_call',
          rawId: 'call_native',
          name: 'get_weather',
          arguments: '{}',
          extras: { thought_signature_b64: 'sig-tool' },
        },
      ]);
      journal.append({ type: 'turn.started', turnId: 0, trigger: 'normal' });
      journal.append({ type: 'message.appended', turnId: 0, step: 0, source: 'normal', entry });
      journal.append({ type: 'step.started', turnId: 0, step: 1 });
      journal.append({ type: 'message.appended', turnId: 0, step: 1, source: 'llm', entry: answer });
      journal.append({
        type: 'tool.started',
        turnId: 0,
        step: 1,
        toolCall: answer.message.toolCalls[0]!,
      });
      journal.append({
        type: 'step.ended',
        turnId: 0,
        step: 1,
        outcome: { type: 'done' },
        timing: {
          firstTokenLatencyMs: 100,
          streamDurationMs: 200,
          requestBuildMs: 30,
          serverFirstTokenMs: 70,
          serverDecodeMs: 150,
          clientConsumeMs: 50,
          clientBlockedMs: 20,
        },
      });
      await journal.settled();

      expect(persisted).toContainEqual({
        type: 'context.append_loop_event',
        agentId: 'main',
        time: expect.any(Number),
        event: expect.objectContaining({
          type: 'tool.call',
          toolCallId: 'local_call',
          rawId: 'call_native',
          extras: { thought_signature_b64: 'sig-tool' },
        }),
      });
      expect(persisted.some((record) => record.type === 'context.append_message')).toBe(true);
      expect(persisted.every((record) => !record.type.startsWith('agent.'))).toBe(true);
      expect(JSON.stringify(persisted)).toContain('text/markdown');
      expect(persisted).toContainEqual(expect.objectContaining({
        type: 'context.append_loop_event',
        event: expect.objectContaining({
          type: 'step.end',
          llmFirstTokenLatencyMs: 100,
          llmStreamDurationMs: 200,
          llmRequestBuildMs: 30,
          llmServerFirstTokenMs: 70,
          llmServerDecodeMs: 150,
          llmClientConsumeMs: 50,
          llmClientBlockedMs: 20,
        }),
      }));
      const restored = journal.snapshot().input.messages!;
      expect(restored.slice(0, 2).map((item) => item.message)).toMatchObject([
        entry.message,
        answer.message,
      ]);
      expect(restored[0]?.message.content[0]).not.toHaveProperty('meta');
      expect(restored.every((item) => item.meta?.llmTiming === undefined)).toBe(true);
    } finally {
      ix.dispose();
    }
  });

  it('cuts undo and fork at public turn boundaries and ignores queued agent records', () => {
    const records: WireRecord[] = [
      { type: 'turn.prompt', turnId: 0, input: [], trigger: 'normal', origin: { kind: 'user' } },
      { type: 'context.append_message', message: contextFromHistoryEntry(prompt('first')) },
      { type: 'turn.ended', turnId: 0, reason: 'completed' },
      { type: 'turn.prompt', turnId: 1, input: [], trigger: 'normal', origin: { kind: 'user' } },
      { type: 'agent.input.submitted', entry: prompt('after-undo') },
    ];
    const entries = records.map((record, index) => ({ record, line: index + 1 }));
    const forkLine = computeForkLine(entries, new Set(), 1);
    expect(forkLine).toBe(3);
    const switched: WireRecord = {
      type: 'agent.switched',
      branch: 'b1',
      reason: 'undo',
      base: { branch: 'main', line: forkLine },
    };
    const tree = parseTree([...entries, { record: switched, line: 6 }], 6);
    const active = restorableChain([...entries, { record: switched, line: 6 }], tree);
    const restored = restoreLoopJournal(active.map(({ record }) => record));

    expect(restored.input.messages!.map((entry) => entry.message)).toEqual([prompt('first').message]);
    expect(restored.input.nextTurnId).toBe(2);
    expect(restored.input.unfinished).toBeUndefined();

    const mixed = [
      { type: 'context.append_message', message: contextFromHistoryEntry(prompt('first')) },
      { type: 'context.append_message', message: contextFromHistoryEntry(prompt('second')) },
      { type: 'agent.turn.started', turnId: 2, trigger: 'normal' },
    ].map((record, index) => ({ record, line: index + 1 }));
    expect(() => computeForkLine(mixed, new Set(), 2)).toThrow('insufficient');
  });
});
