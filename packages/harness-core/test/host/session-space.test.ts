import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { SessionSpaceError, type SessionContainer } from '@moonshot-ai/agent-core/session/index';
import { openWriter, type Log, type Projection, type Writer } from '@moonshot-ai/agent-core/store/index';

import { fsSessionSpace } from '#/host/session-space';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useFeatureStore,
  type FeatureStore,
  type Harness,
  type HarnessSessionSpace,
} from '#/runtime/index';

const bytes = new TextEncoder().encode('blob');

type MarkerEvent = { readonly type: 'marker'; readonly value: string };

async function markerLog(
  container: SessionContainer,
): Promise<{ writer: Writer; log: Log<MarkerEvent> }> {
  const writer = openWriter(container.journal);
  const log = await writer.open<MarkerEvent>('markers');
  return { writer, log };
}

function markerValues(log: Log<MarkerEvent>): string[] {
  return log.replica.entries().map((entry) => entry.event.value);
}

afterEach(() => {
  vi.useRealTimers();
});

async function exerciseSpace(space: HarnessSessionSpace): Promise<{ blobRef: string }> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const alpha = await space.create('alpha', { title: 'one', metadata: { workspaceId: 'ws' } });
  const alphaWriter = openWriter(alpha.journal);
  const alphaLog = await alphaWriter.open<MarkerEvent>('markers');
  await alphaLog.commit({ events: [{ type: 'marker', value: 'hello' }] });
  const { ref: blobRef } = await alpha.blobs.put({ bytes });
  expect(await space.list()).toEqual([
    {
      id: 'alpha',
      title: 'one',
      metadata: { workspaceId: 'ws' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await expect(space.create('alpha')).rejects.toMatchObject({ reason: 'already-exists' });
  await expect(space.open('missing')).rejects.toBeInstanceOf(SessionSpaceError);

  vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
  const copied = await space.copy('alpha', 'beta');
  const copiedWriter = openWriter(copied.journal);
  const copiedLog = await copiedWriter.open<MarkerEvent>('markers');
  expect(markerValues(copiedLog)).toEqual(['hello']);
  expect(await copied.blobs.has(blobRef)).toBe(true);
  await copiedWriter.close();

  await alphaLog.commit({ events: [{ type: 'marker', value: 'changed' }] });
  const beta = await space.open('beta');
  const betaWriter = openWriter(beta.journal);
  const betaLog = await betaWriter.open<MarkerEvent>('markers');
  expect(markerValues(betaLog)).toEqual(['hello']);
  await betaWriter.close();

  vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
  expect(await space.update('beta', { title: 'two' })).toEqual({
    id: 'beta',
    title: 'two',
    metadata: { workspaceId: 'ws' },
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  });
  vi.setSystemTime(new Date('2026-01-04T00:00:00.000Z'));
  expect(await space.update('beta', { metadata: { extra: 1 } })).toEqual({
    id: 'beta',
    title: 'two',
    metadata: { workspaceId: 'ws', extra: 1 },
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
  });

  await alphaWriter.close();
  await space.delete('alpha');
  expect(await space.get('alpha')).toBeUndefined();
  expect((await space.list()).map((record) => record.id)).toEqual(['beta']);
  return { blobRef };
}

describe('session space', () => {
  it('creates, copies, updates, and deletes sessions in memory', async () => {
    const { blobRef } = await exerciseSpace(memoryHarnessSpace());
    expect(blobRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists the same catalog and container bytes on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      const { blobRef } = await exerciseSpace(fsSessionSpace(root));
      const reopened = fsSessionSpace(root);
      expect(await reopened.get('beta')).toEqual({
        id: 'beta',
        title: 'two',
        metadata: { workspaceId: 'ws', extra: 1 },
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
      });
      const beta = await reopened.open('beta');
      const { writer, log } = await markerLog(beta);
      expect(markerValues(log)).toEqual(['hello']);
      await writer.close();
      expect((await beta.blobs.get(blobRef))?.bytes).toEqual(bytes);

      const featureWriter = openWriter(reopened.featureJournal('beta'));
      const featureLog = await featureWriter.open<MarkerEvent>('probe');
      await featureLog.commit({ events: [{ type: 'marker', value: 'feature' }] });
      await featureWriter.close();
      expect(await readdir(join(root, 'beta', 'features'))).toContain('probe.jsonl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads legacy records without timestamps and stamps updatedAt on update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      await mkdir(join(root, 'ses_legacy'), { recursive: true });
      await writeFile(
        join(root, 'ses_legacy', 'record.json'),
        JSON.stringify({ title: 'legacy', metadata: { workspaceId: 'ws' } }),
      );
      const space = fsSessionSpace(root);
      expect(await space.get('ses_legacy')).toEqual({
        id: 'ses_legacy',
        title: 'legacy',
        metadata: { workspaceId: 'ws' },
      });
      const updated = await space.update('ses_legacy', { title: 'renamed' });
      expect(updated.title).toBe('renamed');
      expect(updated.createdAt).toBeUndefined();
      expect(typeof updated.updatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(updated.updatedAt as string))).toBe(false);
      expect(await space.get('ses_legacy')).toEqual(updated);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface ProbeState {
  readonly values: readonly string[];
}

type ProbeEvent = { readonly type: 'probe.set'; readonly value: string; readonly turnId?: number };

const probeProjection: Projection<ProbeState, ProbeEvent> = {
  initial: () => ({ values: [] }),
  reduce: (state, entry) =>
    entry.event.type === 'probe.set' ? { values: [...state.values, entry.event.value] } : state,
};

function echoRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest) => {
      const messages = rest.content?.messages ?? [];
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      return { type: 'done', message: createAssistantMessage([{ type: 'text', text: `echo:${text}` }]) } as LlmOutcome;
    },
  };
  return self;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function userTexts(messages: readonly HistoryMessage[]): string[] {
  return messages.filter((entry) => entry.message.role === 'user').map((entry) => extractText(entry.message));
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

describe('fs session space with createHarness', () => {
  it('runs a turn, restores it on reopen, and lands feature stores under <id>/features/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      let store: FeatureStore<ProbeState, ProbeEvent> | undefined;
      const probe = createFeature('probe', {
        agent: () => {
          store = useFeatureStore('agent', 'probe', probeProjection);
        },
      });
      const harness = createHarness({ space: fsSessionSpace(root) });
      await harness.app.features.add(probe);
      const session = await harness.app.create({ sessionId: 's1' });
      const agent = await harness.ensureAgent(session, 'main');
      setRequester(harness, 's1', 'main', echoRequester());
      const outcome = await agent.loop.runTurn(user('hello'));
      expect(outcome.type).toBe('done');
      await agent.flush();
      if (store === undefined) throw new Error('probe store was not captured');
      await store.dispatch([{ type: 'probe.set', value: 'a' }]);
      expect(store.state.value.values).toEqual(['a']);
      await harness.close();

      expect(await readdir(join(root, 's1', 'journal', 'agents'))).toContain('main.jsonl');
      expect(await readdir(join(root, 's1', 'features', 'agents', 'main'))).toContain('probe.jsonl');

      const resumed = createHarness({ space: fsSessionSpace(root) });
      await resumed.app.features.add(probe);
      const session2 = await resumed.app.create({ sessionId: 's1' });
      const agent2 = await resumed.ensureAgent(session2, 'main');
      setRequester(resumed, 's1', 'main', echoRequester());
      await agent2.flush();
      if (store === undefined) throw new Error('probe store was not captured after resume');
      await store.ready;
      expect(userTexts(agent2.view.getState().messages)).toEqual(['hello']);
      expect(store.state.value.values).toEqual(['a']);
      await resumed.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
