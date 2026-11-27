import { describe, expect, it } from 'vitest';

import { foldWireRecords } from '#/agent/replayBuilder/fold';
import { restoreLoopJournal } from '#/agent/loop/journal';
import {
  sliceMainRecordsAtTurn,
  sliceMainRecordsForRunningFork,
  sliceRecordsBeforePendingWork,
} from '#/project/sessionLifecycle/internal/forkTurnSlice';
import { normalizeLegacyTurnSteerRecords } from '#/wire/human';
import type { WireRecord } from '#/wire/record';
import { parseTree, restorableChain } from '#/wire/tree/index';

function userTurnRecord(text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      origin: { kind: 'user' },
    },
    time,
  };
}

describe('sliceMainRecordsAtTurn', () => {
  it('derives a fork last prompt from readable client metadata while retaining the original message', () => {
    const record: WireRecord = { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<browser_ref>serialized</browser_ref>' }], origin: { kind: 'user', clientMetadata: [{ display_text: 'Save button · Rename it' }] } }, time: 2 };
    const slice = sliceMainRecordsAtTurn([{ type: 'metadata', protocol_version: '1.5', created_at: 1 }, record, { type: 'turn.ended', turnId: 0, reason: 'blocked', time: 3 }, userTurnRecord('next', 4)], 'example-source', 0);
    expect(slice.lastPrompt).toBe('Save button · Rename it');
    expect(slice.lastTurnReason).toBe('failed');
    expect(slice.records).toContainEqual(record);
  });

  it('keeps completed records before queued input and an active turn in a truncated fork slice', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      {
        type: 'cron.add',
        task: { id: 'aa11bb22', cron: '0 9 * * *', prompt: 'legacy', createdAt: 2 },
        time: 2,
      },
      { type: 'turn.prompt', turnId: 2, input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' }, time: 2.5 },
      userTurnRecord('hello', 3),
      { type: 'cron.cursor', id: 'aa11bb22', lastFiredAt: 4, time: 4 },
      { type: 'turn.cancel', turnId: 3, target: 'queued', time: 4.5 },
      { type: 'turn.prompt', turnId: 4, input: [{ type: 'text', text: 'retracted turn' }], origin: { kind: 'user' }, time: 4.55 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'orphan prompt' }], origin: { kind: 'user' }, time: 4.56 },
      { type: 'turn.steer', input: [{ type: 'text', text: 'orphan steer' }], origin: { kind: 'user' }, time: 4.57 },
      { type: 'turn.prompt', turnId: 5, input: [{ type: 'text', text: 'second turn' }], origin: { kind: 'user' }, time: 4.6 },
      userTurnRecord('second turn', 5),
      { type: 'cron.add', task: { id: 'bb22cc33', cron: '0 10 * * *', prompt: 'late', createdAt: 6 }, time: 6 },
    ];

    const slice = sliceMainRecordsAtTurn(records, 'ses_source', 2);

    const types = slice.records.map((record) => record.type);
    expect(types).toContain('cron.add');
    expect(types).toContain('cron.cursor');
    expect(
      slice.records.filter((record) => record.type === 'cron.add'),
    ).toHaveLength(1);
    expect(types).toContain('metadata');
    expect(types).toContain('context.append_message');
    expect(slice.records.filter((record) => record.type === 'turn.prompt' || record.type === 'turn.steer')).toHaveLength(1);
    expect(() => sliceMainRecordsAtTurn(records, 'ses_source', 4)).toThrowError(/not found/);
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 5).lastPrompt).toBe('second turn');

    const mixed: WireRecord[] = [
      userTurnRecord('legacy first', 1),
      { type: 'turn.prompt', turnId: 7, input: [{ type: 'text', text: 'persistent' }], origin: { kind: 'user' }, time: 2 },
      userTurnRecord('persistent', 3),
      { type: 'turn.ended', turnId: 7, reason: 'completed', time: 3.5 },
      userTurnRecord('legacy tail', 4),
    ];
    expect(sliceMainRecordsAtTurn(mixed, 'ses_source', 0).records).toEqual([mixed[0]]);
    expect(sliceMainRecordsAtTurn(mixed, 'ses_source', 7).records).toEqual(mixed.slice(0, 4));

    const queued = { type: 'agent.input.submitted', entry: { meta: { promptId: 'queued' } } };
    expect(sliceRecordsBeforePendingWork([...records, queued], undefined, ['queued'])).toEqual(records);
    expect(sliceRecordsBeforePendingWork([...records, { type: 'turn.prompt', turnId: 9 }], 9, [])).toEqual(records);

    const running = sliceMainRecordsForRunningFork([
      ...records,
      { type: 'turn.prompt', turnId: 9, input: [{ type: 'text', text: 'active turn' }], origin: { kind: 'user' }, time: 7 },
      userTurnRecord('active turn', 8),
      { type: 'context.append_loop_event', event: { type: 'llm.request' }, time: 9 },
    ], 'ses_source', 9, []);
    expect(running.lastPrompt).toBe('active turn');
    expect(running.lastTurnReason).toBe('cancelled');
    expect(running.cutoffTime).toBe(6);
    expect(running.records.slice(-3)).toMatchObject([
      { type: 'turn.prompt', turnId: 9 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'active turn' }] } },
      { type: 'turn.ended', turnId: 9, reason: 'cancelled' },
    ]);
    expect(running.records.some((record) => record.type === 'context.append_loop_event')).toBe(false);
  });

  it('preserves legacy steer turn ownership through undo fork and cold restore', () => {
    type IdMode = 'none' | 'prompts' | 'messages' | 'all-except-steer' | 'all';
    const scenarios = [
      { mode: 'none', duplicate: false, appendFirst: true },
      { mode: 'prompts', duplicate: false, appendFirst: true },
      { mode: 'messages', duplicate: false, appendFirst: true },
      { mode: 'all-except-steer', duplicate: false, appendFirst: true },
      { mode: 'all', duplicate: false, appendFirst: true },
      { mode: 'none', duplicate: true, appendFirst: true },
      { mode: 'none', duplicate: false, appendFirst: false },
      { mode: 'none', duplicate: true, appendFirst: false },
    ] as const satisfies readonly { mode: IdMode; duplicate: boolean; appendFirst: boolean }[];
    const content = (text: string) => [{ type: 'text', text }];
    const prompt = (text: string, turnId: number, promptId?: string): WireRecord => ({
      type: 'turn.prompt', turnId, input: content(text), origin: { kind: 'user' }, promptId,
    });
    const append = (text: string, id?: string): WireRecord => ({
      type: 'context.append_message',
      message: { role: 'user', id, content: content(text), origin: { kind: 'user' } },
    });
    const steer = (text: string, turnId: number, messageId?: string): WireRecord => ({
      type: 'turn.steer', turnId, input: content(text), origin: { kind: 'user' }, messageId,
    });
    const ended = (turnId: number): WireRecord => ({ type: 'turn.ended', turnId, reason: 'completed' });
    const promptText = (record: WireRecord): string | undefined =>
      (record['input'] as { text?: string }[])[0]?.text;
    const userTexts = (records: readonly WireRecord[]): string[] =>
      restoreLoopJournal(records).input.messages!.flatMap((message) =>
        message.role === 'user' ? [(message.content[0] as { text?: string }).text!] : [],
      );
    const replayUsers = (records: readonly WireRecord[]) => foldWireRecords(records).replay.flatMap((record) =>
      record.type === 'message' && record.message.role === 'user'
        ? [{ text: (record.message.content[0] as { text?: string }).text, turnId: record.turnId }]
        : [],
    );

    for (const scenario of scenarios) {
      const label = JSON.stringify(scenario);
      const promptIds = scenario.mode === 'prompts' || scenario.mode === 'all-except-steer' || scenario.mode === 'all';
      const messageIds = scenario.mode === 'messages' || scenario.mode === 'all-except-steer' || scenario.mode === 'all';
      const steerIds = scenario.mode === 'all';
      const id = (text: string) => `id-${text}`;
      const p = (text: string) => promptIds ? id(text) : undefined;
      const m = (text: string) => messageIds ? id(text) : undefined;
      const s = (text: string) => steerIds ? id(text) : undefined;
      const withdrawn = scenario.duplicate ? 'C1' : 'B';
      const followUps = (text: string): WireRecord[] => scenario.appendFirst
        ? [append(text, m(text)), steer(text, 2, s(text))]
        : [steer(text, 2, s(text)), append(text, m(text))];
      const raw: WireRecord[] = [
        prompt('A', 0, p('A')), append('A', m('A')), ended(0),
        prompt(withdrawn, 1, p(withdrawn)), append(withdrawn, m(withdrawn)), ended(1),
        {
          type: 'agent.switched',
          branch: 'undo-b',
          reason: 'undo',
          base: { branch: 'main', line: 3 },
          legacyUndoLine: 8,
        },
        { type: 'context.undo', count: 1 },
        { type: 'context.undone', turns: 1, fromTurnId: 1 },
        prompt('C', 2, p('C')), append('C', m('C')),
        ...followUps('C1'),
        ...followUps('C2'),
        ended(2),
      ].map((record, index) => ({ ...record, time: index + 1 }));
      const entries = raw.map((record, index) => ({ record, line: index + 1 }));
      const restorable = restorableChain(entries, parseTree(entries, entries.length)).map(({ record }) => record);
      const source = normalizeLegacyTurnSteerRecords(restorable);
      const fork = sliceMainRecordsAtTurn(source, 'session_source', 4).records;
      const cold = normalizeLegacyTurnSteerRecords(JSON.parse(JSON.stringify(fork)) as WireRecord[]);
      const expectedUsers = [
        { text: 'A', turnId: 0 },
        { text: 'C', turnId: 2 },
        { text: 'C1', turnId: 3 },
        { text: 'C2', turnId: 4 },
      ];

      expect(userTexts(source), label).toEqual(expectedUsers.map(({ text }) => text));
      expect(fork.filter((record) => record.type === 'turn.prompt').map((record) => ({
        text: promptText(record),
        turnId: record['turnId'],
      })), label).toEqual(expectedUsers);
      expect(replayUsers(fork), label).toEqual(expectedUsers);
      expect(userTexts(fork), label).toEqual(expectedUsers.map(({ text }) => text));
      expect(cold.filter((record) => record.type === 'turn.prompt').map((record) => ({
        text: promptText(record),
        turnId: record['turnId'],
      })), label).toEqual(expectedUsers);
      expect(replayUsers(cold), label).toEqual(expectedUsers);
      expect(userTexts(cold), label).toEqual(expectedUsers.map(({ text }) => text));

      for (const [turnId, expected] of [[2, expectedUsers.slice(0, 2)], [3, expectedUsers.slice(0, 3)]] as const) {
        const early = sliceMainRecordsAtTurn(source, 'session_source', turnId).records;
        const earlyCold = normalizeLegacyTurnSteerRecords(JSON.parse(JSON.stringify(early)) as WireRecord[]);
        expect(replayUsers(early), label).toEqual(expected);
        expect(userTexts(early), label).toEqual(expected.map(({ text }) => text));
        expect(replayUsers(earlyCold), label).toEqual(expected);
        expect(userTexts(earlyCold), label).toEqual(expected.map(({ text }) => text));
      }
    }

    const modernNotify: WireRecord[] = [
      append('same'),
      { ...prompt('same', 7), trigger: 'notify' },
      append('same'),
      ended(7),
    ];
    expect(replayUsers(modernNotify)).toEqual([
      { text: 'same', turnId: undefined },
      { text: 'same', turnId: 7 },
    ]);
    expect(sliceMainRecordsAtTurn(modernNotify, 'session_source', 7).records).toEqual(modernNotify);

    for (const trigger of ['normal', 'notify']) {
      const modernStrongId: WireRecord[] = [
        append('same', 'p7'),
        { ...prompt('same', 7, 'p7'), trigger },
        append('same', 'p7'),
        ended(7),
      ];
      expect(replayUsers(modernStrongId)).toEqual([
        { text: 'same', turnId: undefined },
        { text: 'same', turnId: 7 },
      ]);
      expect(sliceMainRecordsAtTurn(modernStrongId, 'session_source', 7).records).toEqual(modernStrongId);
    }

    const repeated = normalizeLegacyTurnSteerRecords([
      prompt('C', 2), append('C'),
      append('X'), steer('X', 2),
      append('X'), steer('X', 2),
      ended(2),
    ]);
    expect(replayUsers(sliceMainRecordsAtTurn(repeated, 'session_source', 4).records)).toEqual([
      { text: 'C', turnId: 2 },
      { text: 'X', turnId: 3 },
      { text: 'X', turnId: 4 },
    ]);

    const relaxed = normalizeLegacyTurnSteerRecords([
      prompt('C', 2), append('C'),
      append('C1 altered', 'id-C1'),
      { ...steer('C1', 2), promptIds: ['id-C1'] },
      ended(2),
    ]);
    expect(replayUsers(sliceMainRecordsAtTurn(relaxed, 'session_source', 3).records)).toEqual([
      { text: 'C', turnId: 2 },
      { text: 'C1 altered', turnId: 3 },
    ]);

    const injection: WireRecord = {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'reminder' }],
        origin: { kind: 'injection', ownerPromptId: 'prompt-C' },
      },
    };
    const withInjection = normalizeLegacyTurnSteerRecords([
      prompt('C', 2, 'prompt-C'), append('C', 'prompt-C'),
      injection,
      steer('S', 2),
      append('S'),
      ended(2),
    ]);
    expect(withInjection.indexOf(injection)).toBeLessThan(
      withInjection.findIndex((record) => record.type === 'turn.ended' && record['turnId'] === 2),
    );
    expect(sliceMainRecordsAtTurn(withInjection, 'session_source', 2).records).toContainEqual(injection);
  });
});
