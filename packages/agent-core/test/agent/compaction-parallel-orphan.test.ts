import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import type { Message } from '@moonshot-ai/kosong';
import { AGENT_WIRE_PROTOCOL_VERSION, InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { testAgent } from './harness/agent';

/**
 * Regression test for `400 tool_call_id  is not found`.
 *
 * A single assistant step issues TWO parallel tool calls (A, B). A full
 * compaction is then recorded with `compactedCount` pointing BETWEEN the two
 * parallel results (after A's result, before B's). This is the persisted state
 * a compaction produces when its split index is computed against an in-flight
 * parallel tool batch (only A had landed) and later applied to the fully
 * materialized history (A and B both present) — e.g. on resume.
 *
 * `applyCompaction` does `[summary, ...history.slice(count)]`, so without a
 * guard the retained suffix starts with B's tool result whose owning assistant
 * tool_call is now inside the summary — an orphan the provider rejects on every
 * subsequent turn, permanently bricking the session. `applyCompaction` now
 * drops orphaned leading tool results, so the projected request stays valid.
 */

let seq = 0;
const uid = (p: string): string => `${p}-${String(seq++)}`;

function userMsg(text: string): AgentRecord {
  return {
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } },
  } as unknown as AgentRecord;
}

function loopEvent(event: Record<string, unknown>): AgentRecord {
  return { type: 'context.append_loop_event', event } as unknown as AgentRecord;
}

// An assistant step with N tool calls (all results delivered), e.g. parallel.
function* stepWithToolCalls(turnId: string, calls: { id: string; name: string }[]): Generator<AgentRecord> {
  const stepUuid = uid('step');
  yield loopEvent({ type: 'step.begin', uuid: stepUuid, turnId, step: 1 });
  yield loopEvent({
    type: 'content.part',
    uuid: uid('part'),
    turnId,
    step: 1,
    stepUuid,
    part: { type: 'text', text: 'working' },
  });
  for (const c of calls) {
    yield loopEvent({
      type: 'tool.call',
      uuid: c.id,
      turnId,
      step: 1,
      stepUuid,
      toolCallId: c.id,
      name: c.name,
      args: {},
    });
  }
  for (const c of calls) {
    yield loopEvent({
      type: 'tool.result',
      parentUuid: c.id,
      toolCallId: c.id,
      result: { output: `result for ${c.id}` },
    });
  }
  yield loopEvent({ type: 'step.end', uuid: stepUuid, turnId, step: 1 });
}

function buildRecords(): AgentRecord[] {
  const records: AgentRecord[] = [
    { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 } as unknown as AgentRecord,
    userMsg('please read these two files'),
  ];
  // history so far: [user@0]
  // Parallel batch -> assistant@1 [A,B], tool(A)@2, tool(B)@3
  records.push(...stepWithToolCalls('0', [
    { id: 'call_A', name: 'Read' },
    { id: 'call_B', name: 'Read' },
  ]));
  // A follow-up step so there is content after the parallel batch.
  // assistant@4 [C], tool(C)@5
  records.push(...stepWithToolCalls('0', [{ id: 'call_C', name: 'Grep' }]));

  // Compaction whose split index lands BETWEEN the two parallel results:
  // history.slice(3) keeps [tool(B), assistant(C), tool(C)] — tool(B) is orphaned.
  records.push({
    type: 'context.apply_compaction',
    summary: '## Summary\n\nEarlier work compacted.',
    compactedCount: 3,
    tokensBefore: 1000,
    tokensAfter: 20,
  } as unknown as AgentRecord);

  // The next user turn — this is the request that the API rejects.
  records.push(userMsg('now continue'));
  return records;
}

function findOrphanToolMessages(messages: readonly Message[]): { index: number; id: unknown }[] {
  const declared = new Set<string>();
  const orphans: { index: number; id: unknown }[] = [];
  messages.forEach((m, index) => {
    for (const tc of m.toolCalls) declared.add(tc.id);
    if (m.role === 'tool') {
      const id = m.toolCallId;
      if (typeof id !== 'string' || id.length === 0 || !declared.has(id)) orphans.push({ index, id });
    }
  });
  return orphans;
}

describe('compaction split inside a parallel tool batch orphans a tool result on resume', () => {
  it('projects an orphaned tool_call_id (reproduces the Kimi 400)', async () => {
    seq = 0;
    const ctx = testAgent({ persistence: new InMemoryAgentRecordPersistence(buildRecords()) });
    await ctx.agent.resume();

    const projected = ctx.agent.context.messages;

    // Before the fix this surfaced `[{ index: 1, id: 'call_B' }]`: the retained
    // suffix began with call_B's orphaned tool result, which the provider
    // rejects with `400 tool_call_id not found` on every subsequent turn.
    expect(findOrphanToolMessages(projected)).toEqual([]);
  });
});
