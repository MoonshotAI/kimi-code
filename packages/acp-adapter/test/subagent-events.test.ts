import { describe, expect, it } from 'vitest';

import type {
  SubagentCompletedEvent,
  SubagentSpawnedEvent,
  SubagentSuspendedEvent,
} from '@moonshot-ai/kimi-code-sdk';

import {
  acpSubagentToolCallId,
  assistantDeltaToSessionUpdate,
  subagentLifecycleToSessionUpdate,
  subagentSpawnedToSessionUpdate,
  withSubagentMeta,
} from '../src/events-map';

interface SubagentMetaCarrier {
  _meta?: { kimiCode?: { subagent?: Record<string, unknown>; subagentId?: string } };
}

describe('subagent ACP frames', () => {
  it('maps spawned to a tool_call create with the lifecycle meta', () => {
    const event: SubagentSpawnedEvent = {
      type: 'subagent.spawned',
      subagentId: 'agent-3',
      subagentName: 'explore',
      parentToolCallId: 'call_1',
      description: 'look around',
      swarmIndex: 0,
      runInBackground: false,
    };
    const note = subagentSpawnedToSessionUpdate('sess', event);
    expect(note.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'subagent:agent-3',
      status: 'pending',
    });
    const meta = (note.update as SubagentMetaCarrier)._meta?.kimiCode?.subagent;
    expect(meta).toMatchObject({
      event: 'spawned',
      subagentId: 'agent-3',
      subagentName: 'explore',
      parentToolCallId: 'call_1',
    });
  });

  it('maps completed to a terminal update with the summary payload', () => {
    const event: SubagentCompletedEvent = {
      type: 'subagent.completed',
      subagentId: 'agent-3',
      resultSummary: 'done',
      contextTokens: 1234,
    };
    const note = subagentLifecycleToSessionUpdate('sess', event);
    expect(note.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'subagent:agent-3',
      status: 'completed',
    });
    const meta = (note.update as SubagentMetaCarrier)._meta?.kimiCode?.subagent;
    expect(meta).toMatchObject({ event: 'completed', resultSummary: 'done', contextTokens: 1234 });
  });

  it('keeps suspended in_progress and carries the reason', () => {
    const event: SubagentSuspendedEvent = {
      type: 'subagent.suspended',
      subagentId: 'agent-3',
      reason: 'awaiting approval',
    };
    const note = subagentLifecycleToSessionUpdate('sess', event);
    expect(note.update).toMatchObject({ status: 'in_progress' });
    const meta = (note.update as SubagentMetaCarrier)._meta?.kimiCode?.subagent;
    expect(meta).toMatchObject({ event: 'suspended', reason: 'awaiting approval' });
  });

  it('strips absent optional fields from the meta (no nulls on the wire)', () => {
    const event: SubagentSpawnedEvent = {
      type: 'subagent.spawned',
      subagentId: 'agent-4',
      subagentName: 'coder',
      parentToolCallId: 'call_9',
      runInBackground: true,
    };
    const note = subagentSpawnedToSessionUpdate('sess', event);
    const meta = (note.update as SubagentMetaCarrier)._meta?.kimiCode?.subagent ?? {};
    expect(meta).not.toHaveProperty('description');
    expect(meta).not.toHaveProperty('swarmIndex');
  });

  it('tags subagent stream frames and leaves main-agent frames untouched', () => {
    const base = assistantDeltaToSessionUpdate('sess', {
      type: 'assistant.delta',
      delta: 'hi',
    } as Parameters<typeof assistantDeltaToSessionUpdate>[1]);

    const main = withSubagentMeta(base, { agentId: 'main' });
    expect((main.update as SubagentMetaCarrier)._meta).toBeUndefined();

    const sub = withSubagentMeta(base, { agentId: 'agent-3' });
    expect((sub.update as SubagentMetaCarrier)._meta?.kimiCode?.subagentId).toBe('agent-3');
  });

  it('keeps subagent card ids out of the tool-call id space', () => {
    expect(acpSubagentToolCallId('agent-3')).toBe('subagent:agent-3');
  });
});
