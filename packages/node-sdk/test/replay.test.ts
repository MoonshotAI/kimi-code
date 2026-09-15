import { describe, expect, it } from 'vitest';

import { limitAgentReplayByTurns, type AgentReplayRecord } from '#/replay';

function userTurn(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function cronTurn(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'cron_job', jobId: 'job-1', cron: '*/15 * * * *', recurring: true, coalescedCount: 1, stale: false },
    },
  };
}

function cronMissedTurn(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'cron_missed', count: 3 },
    },
  };
}

function injection(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'reminder' },
    },
  };
}

function assistant(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
  };
}

function replayBytes(records: readonly AgentReplayRecord[]): number {
  return records.reduce((sum, record) => sum + JSON.stringify(record).length, 0);
}

describe('limitAgentReplayByTurns', () => {
  it('keeps only the last N user turns', () => {
    const records: AgentReplayRecord[] = [];
    for (let turn = 0; turn < 20; turn++) {
      records.push(userTurn(`prompt ${turn}`, turn * 10));
      records.push(assistant(`answer ${turn}`, turn * 10 + 1));
    }
    const limited = limitAgentReplayByTurns(records, 5);
    expect(limited[0]).toMatchObject({ message: { origin: { kind: 'user' } } });
    expect(JSON.stringify(limited)).toContain('prompt 15');
    expect(JSON.stringify(limited)).not.toContain('prompt 14');
  });

  it('bounds replay volume when cron turns dominate the history', () => {
    const records: AgentReplayRecord[] = [];
    let time = 0;
    for (let turn = 0; turn < 30; turn++) {
      records.push(userTurn(`manual prompt ${turn}`, time++));
      records.push(assistant('manual answer', time++));
      for (let cron = 0; cron < 200; cron++) {
        records.push(cronTurn(`cron fire ${turn}:${cron} ${'x'.repeat(500)}`, time++));
        records.push(assistant(`cron report ${'y'.repeat(2000)}`, time++));
      }
    }
    const total = replayBytes(records);
    const limited = limitAgentReplayByTurns(records, 10);
    expect(limited.length).toBeLessThan(records.length / 10);
    expect(replayBytes(limited)).toBeLessThan(total / 10);
    expect(JSON.stringify(limited.at(-2))).toContain('cron fire 29:199');
  });

  it('treats cron_missed deliveries as turn boundaries', () => {
    const records: AgentReplayRecord[] = [];
    for (let turn = 0; turn < 20; turn++) {
      records.push(cronMissedTurn(`missed ${turn}`, turn * 2));
      records.push(assistant('report', turn * 2 + 1));
    }
    const limited = limitAgentReplayByTurns(records, 5);
    expect(JSON.stringify(limited)).toContain('missed 15');
    expect(JSON.stringify(limited)).not.toContain('missed 14');
  });

  it('does not let injection bursts shrink the window', () => {
    const records: AgentReplayRecord[] = [];
    for (let turn = 0; turn < 8; turn++) {
      records.push(userTurn(`prompt ${turn}`, turn * 100));
      records.push(assistant(`answer ${turn}`, turn * 100 + 1));
      for (let i = 0; i < 50; i++) {
        records.push(injection(`reminder ${turn}:${i}`, turn * 100 + 2 + i));
      }
    }
    const limited = limitAgentReplayByTurns(records, 5);
    expect(JSON.stringify(limited)).toContain('prompt 3');
    expect(JSON.stringify(limited)).not.toContain('prompt 2');
  });
});
