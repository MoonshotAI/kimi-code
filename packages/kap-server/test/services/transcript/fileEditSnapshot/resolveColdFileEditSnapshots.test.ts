import { describe, expect, it } from 'vitest';

import type { IBlobStore } from '@moonshot-ai/agent-core-v2';
import type { AgentTranscriptSnapshot, ToolCallFrame, TranscriptTurn } from '@moonshot-ai/transcript';

import type { ContextRecord } from '../../../../src/services/transcript/wireRecords';
import { resolveColdFileEditSnapshots } from '../../../../src/services/transcript/fileEditSnapshot/resolveColdFileEditSnapshots';

const SCOPE = 'sessions/workspace-1/session-1/agents/main';

function fakeBlobStore(seed: Readonly<Record<string, string>> = {}): IBlobStore {
  const data = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(seed)) {
    data.set(`${SCOPE}:${key}`, Buffer.from(value, 'utf8'));
  }
  return {
    _serviceBrand: undefined,
    put: async (scope, key, value) => {
      data.set(`${scope}:${key}`, value);
    },
    putStream: async () => {},
    get: async (scope, key) => data.get(`${scope}:${key}`),
    getStream: () => (async function* () {})(),
    has: async (scope, key) => data.has(`${scope}:${key}`),
    delete: async (scope, key) => {
      data.delete(`${scope}:${key}`);
    },
    list: async () => [],
  };
}

function toolFrame(toolCallId: string): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: `t0.0.f0-${toolCallId}`,
    toolCallId,
    name: 'Edit',
    state: 'done',
  };
}

function turnWith(frames: ToolCallFrame[]): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: 't0',
    ordinal: 0,
    state: 'completed',
    origin: { kind: 'user' },
    steps: [
      {
        kind: 'step',
        stepId: 't0.0',
        turnId: 't0',
        ordinal: 0,
        state: 'completed',
        frames,
      },
    ],
  };
}

function snapshotWith(frames: ToolCallFrame[]): AgentTranscriptSnapshot {
  return {
    items: [turnWith(frames)],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
  };
}

function recordedFor(
  toolCallId: string,
  overrides: Partial<ContextRecord> = {},
): ContextRecord {
  return {
    type: 'file.edit_snapshot.recorded',
    toolCallId,
    path: '/tmp/a.ts',
    ...overrides,
  };
}

describe('resolveColdFileEditSnapshots', () => {
  it('returns the same snapshot unchanged when there are no recorded snapshots', async () => {
    const snapshot = snapshotWith([toolFrame('call_1')]);
    const result = await resolveColdFileEditSnapshots(snapshot, [], fakeBlobStore(), SCOPE);
    expect(result).toBe(snapshot);
  });

  it('resolves blob refs back to text and patches the matching tool frame', async () => {
    const blobs = fakeBlobStore({ 'file-edit/before-hash': 'old content', 'file-edit/after-hash': 'new content' });
    const snapshot = snapshotWith([toolFrame('call_1')]);
    const records: ContextRecord[] = [
      recordedFor('call_1', {
        before: { key: 'file-edit/before-hash', bytes: 12 },
        after: { key: 'file-edit/after-hash', bytes: 11 },
      }),
    ];

    const result = await resolveColdFileEditSnapshots(snapshot, records, blobs, SCOPE);

    const turn = result.items[0] as TranscriptTurn;
    const frame = turn.steps[0]!.frames[0] as ToolCallFrame;
    expect(frame.edit).toEqual({
      path: '/tmp/a.ts',
      before: 'old content',
      after: 'new content',
    });
  });

  it('resolves a null before (new file) without attempting a blob read', async () => {
    const blobs = fakeBlobStore({ 'file-edit/after-hash': 'brand new file' });
    const snapshot = snapshotWith([toolFrame('call_1')]);
    const records: ContextRecord[] = [
      recordedFor('call_1', {
        before: null,
        after: { key: 'file-edit/after-hash', bytes: 14 },
      }),
    ];

    const result = await resolveColdFileEditSnapshots(snapshot, records, blobs, SCOPE);

    const frame = (result.items[0] as TranscriptTurn).steps[0]!.frames[0] as ToolCallFrame;
    expect(frame.edit).toEqual({
      path: '/tmp/a.ts',
      before: null,
      after: 'brand new file',
    });
  });

  it('patches a truncated record without reading any blobs', async () => {
    const snapshot = snapshotWith([toolFrame('call_1')]);
    const records: ContextRecord[] = [recordedFor('call_1', { truncated: true })];

    const result = await resolveColdFileEditSnapshots(snapshot, records, fakeBlobStore(), SCOPE);

    const frame = (result.items[0] as TranscriptTurn).steps[0]!.frames[0] as ToolCallFrame;
    expect(frame.edit).toEqual({ path: '/tmp/a.ts', truncated: true });
  });

  it('ignores a recorded snapshot for a toolCallId with no matching frame', async () => {
    const snapshot = snapshotWith([toolFrame('call_1')]);
    const records: ContextRecord[] = [
      recordedFor('call_unknown', {
        before: null,
        after: { key: 'file-edit/after-hash', bytes: 1 },
      }),
    ];

    const result = await resolveColdFileEditSnapshots(
      snapshot,
      records,
      fakeBlobStore({ 'file-edit/after-hash': 'x' }),
      SCOPE,
    );

    const frame = (result.items[0] as TranscriptTurn).steps[0]!.frames[0] as ToolCallFrame;
    expect(frame.edit).toBeUndefined();
  });

  it('leaves the frame unpatched when the after blob is missing from the store', async () => {
    const snapshot = snapshotWith([toolFrame('call_1')]);
    const records: ContextRecord[] = [
      recordedFor('call_1', {
        before: null,
        after: { key: 'file-edit/missing', bytes: 1 },
      }),
    ];

    const result = await resolveColdFileEditSnapshots(snapshot, records, fakeBlobStore(), SCOPE);

    expect(result).toBe(snapshot);
  });

  it('only patches frames for tool calls with a recorded snapshot, leaving siblings untouched', async () => {
    const blobs = fakeBlobStore({ 'file-edit/after-hash': 'patched' });
    const snapshot = snapshotWith([toolFrame('call_1'), toolFrame('call_2')]);
    const records: ContextRecord[] = [
      recordedFor('call_1', { before: null, after: { key: 'file-edit/after-hash', bytes: 7 } }),
    ];

    const result = await resolveColdFileEditSnapshots(snapshot, records, blobs, SCOPE);

    const frames = (result.items[0] as TranscriptTurn).steps[0]!.frames as ToolCallFrame[];
    expect(frames[0]!.edit).toEqual({ path: '/tmp/a.ts', before: null, after: 'patched' });
    expect(frames[1]!.edit).toBeUndefined();
  });
});
