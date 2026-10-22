import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFeature, createApp, type App, useFeatureStore } from '#/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { nodeSessionSpace } from '@moonshot-ai/agent-core/session/backend/node';
import type { Projection } from '@moonshot-ai/agent-core/store/index';
import type { FeatureStore } from '#/app/index';

interface ProbeState {
  readonly values: readonly string[];
}

type ProbeEvent = { readonly type: 'probe.set'; readonly value: string };

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

function setRequester(harness: App, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.sessions.get(sessionId);
  const runtime = session !== undefined ? session.agentRuntime(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

describe('node session space with createApp', () => {
  it('runs a turn, restores it on reopen, and keeps feature events in the agent log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      let store: FeatureStore<ProbeState, ProbeEvent> | undefined;
      const probe = createFeature('probe', {
        agent: () => {
          store = useFeatureStore('agent', 'probe', probeProjection);
        },
      });
      const harness = createApp({ space: nodeSessionSpace(root) });
      harness.features.add(probe);
      const session = await harness.open('s1');
      const { agent } = await session.ensureAgent('main');
      setRequester(harness, 's1', 'main', echoRequester());
      const outcome = await agent.loop.runTurn(user('hello'));
      expect(outcome.type).toBe('done');
      await agent.flush();
      if (store === undefined) throw new Error('probe store was not captured');
      await store.dispatch([{ type: 'probe.set', value: 'a' }]);
      expect(store.state.value.values).toEqual(['a']);
      await harness.close();

      expect(await readdir(join(root, 's1', 'journal', 'agents'))).toContain('main.jsonl');
      const lines = await readFile(join(root, 's1', 'journal', 'agents', 'main.jsonl'), 'utf8');
      expect(lines).toContain('turn.started');
      expect(lines).toContain('probe.set');
      await expect(readdir(join(root, 's1', 'features'))).rejects.toThrow();

      const resumed = createApp({ space: nodeSessionSpace(root) });
      resumed.features.add(probe);
      const session2 = await resumed.open('s1');
      const { agent: agent2 } = await session2.ensureAgent('main');
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
