import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  useAgentTools,
  type AgentHandle,
  type FeatureSpec,
  type AgentLlmRequester,
  type LlmOutcome,
  type Message,
  type SessionStores,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

import {
  AGENTS_MD_DISCOVERY_REMIND_KEY,
  createAgentsMdReminder,
} from '#/features/agentsMdReminder/index';
import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import { createProfiles } from '#/features/profiles/index';
import {
  AGENT_NOT_FOUND,
  createSessionInit,
  SESSION_INIT_FAILED,
  SESSION_INIT_REMIND_KEY,
  SessionInitError,
  SessionInitRef,
} from '#/features/sessionInit/index';

import { testModel, textOutcome } from '../fake-llm';

const AGENTS_MD = 'latest project instructions';
const INIT_SUMMARY = 'Explored and wrote AGENTS.md';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmReply = { text: string } | { toolCall: { name: string; arguments: string } };
type LlmScript = (call: LlmCall) => LlmReply | 'hang' | 'throw';

function isInitCall(call: LlmCall): boolean {
  return call.messages.some(
    (message) => message.role === 'user' && extractText(message).includes('Task requirements:'),
  );
}

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const requester: AgentLlmRequester = {
    with: () => requester,
    request: () => {
      throw new Error('fake requester cannot build wire requests');
    },
    generate: (rest, { signal, onEvent }) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      if (out === 'hang') {
        return new Promise<LlmOutcome>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if (out === 'throw') return Promise.reject(new Error('coder exploded'));
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      const outcome =
        'toolCall' in out
          ? textOutcome('', [
              { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
            ])
          : textOutcome(out.text);
      onEvent?.({ type: 'llm.ended', outcome });
      return Promise.resolve(outcome);
    },
  };
  return { calls, requester };
}

function defaultScript(workDir: string): LlmScript {
  return (call) => {
    const last = call.messages.at(-1);
    if (last !== undefined && last.role === 'tool') return { text: 'done' };
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    if (text.includes('Task requirements:')) return { text: INIT_SUMMARY };
    if (text === 'read') {
      return {
        toolCall: { name: 'Read', arguments: JSON.stringify({ path: join(workDir, 'index.ts') }) },
      };
    }
    return { text: `echo:${text}` };
  };
}

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }] }),
      });
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

function posixHost(homeDir: string): OsHost {
  const node = createNodeOsHost();
  return {
    process: node.process,
    fs: node.fs,
    environment: {
      ready: Promise.resolve(),
      osKind: 'Darwin',
      osArch: 'arm64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir,
    },
  };
}

const tmpDirs: string[] = [];

interface StartOptions {
  readonly script?: LlmScript;
  readonly withLlm?: boolean;
  readonly withMain?: boolean;
  readonly withHost?: boolean;
  readonly withAgentsMd?: boolean;
}

async function startApp(options: StartOptions = {}) {
  const env = await testStores();
  const workDir = await mkdtemp(join(tmpdir(), 'session-init-work-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'session-init-home-'));
  tmpDirs.push(workDir, homeDir);
  if (options.withAgentsMd !== false) {
    await writeFile(join(workDir, 'AGENTS.md'), AGENTS_MD, 'utf-8');
  }
  const host = posixHost(homeDir);
  const { requester, calls } = createMockRequester(options.script ?? defaultScript(workDir));
  const spec = createSessionInit({
    workDir,
    host: options.withHost === false ? undefined : host,
  });
  const features: FeatureSpec[] = [
    createProfiles({ workDir, home: homeDir }),
    createAgentsMdReminder({ workDir, host }),
    spec,
    bindTestTools(),
  ];
  if (options.withLlm !== false) features.push(bindTestLlm(requester));
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main =
    options.withMain === false
      ? undefined
      : await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await env.stores.dispose();
  };
  return { app, env, main, session, spec, calls, workDir, homeDir, dispose };
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function reminderTexts(stores: SessionStores, key: string): string[] {
  return (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === key)
    .map((entry) => extractText(entry.message));
}

describe('sessionInit feature', () => {
  it('spawns a coder subagent, reloads AGENTS.md, seeds and reminds the main agent', async () => {
    const { env, main, session, calls, dispose } = await startApp();

    await session.resolve(SessionInitRef).generateAgentsMd();

    const agentId = Object.keys(env.stores.session.getState().roster.agents).find(
      (id) => env.stores.session.getState().roster.agents[id]?.source === 'session-init',
    );
    expect(agentId).toMatch(/^subagent-/);

    expect(calls[0]!.systemPrompt).toContain('You are now running as a subagent.');
    expect(session.get(agentId!)?.model?.spec.name).toBe('test-model');
    const childHistory = env.stores.get(agentId!)?.getState().history ?? [];
    expect(childHistory.some((entry) => extractText(entry.message) === INIT_SUMMARY)).toBe(true);

    const first = nextTurnDone(main!);
    main!.submit(createUserMessage('read'));
    await first;
    await env.stores.flush();

    const initReminders = reminderTexts(env.stores, SESSION_INIT_REMIND_KEY);
    expect(initReminders).toHaveLength(1);
    expect(initReminders[0]).toContain('The user just ran `/init` slash command.');
    expect(initReminders[0]).toContain('Latest AGENTS.md file content:');
    expect(initReminders[0]).toContain(AGENTS_MD);
    expect(reminderTexts(env.stores, AGENTS_MD_DISCOVERY_REMIND_KEY)).toEqual([]);
    await dispose();
  });

  it('rejects with AGENT_NOT_FOUND when the main agent does not exist', async () => {
    const { session, dispose } = await startApp({ withMain: false });

    const error = await session
      .resolve(SessionInitRef)
      .generateAgentsMd()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionInitError);
    expect((error as SessionInitError).code).toBe(AGENT_NOT_FOUND);
    expect((error as SessionInitError).message).toBe('Main agent was not found');
    await dispose();
  });

  it('rejects with SESSION_INIT_FAILED when the main agent has no model bound', async () => {
    const { session, dispose } = await startApp({ withLlm: false });

    const error = await session
      .resolve(SessionInitRef)
      .generateAgentsMd()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionInitError);
    expect((error as SessionInitError).code).toBe(SESSION_INIT_FAILED);
    expect((error as SessionInitError).message).toBe('Main agent has no model bound');
    await dispose();
  });

  it('wraps a subagent turn failure in SESSION_INIT_FAILED', async () => {
    const script: LlmScript = (call) => (isInitCall(call) ? 'throw' : { text: 'done' });
    const { session, dispose } = await startApp({ script });

    const error = await session
      .resolve(SessionInitRef)
      .generateAgentsMd()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionInitError);
    expect((error as SessionInitError).code).toBe(SESSION_INIT_FAILED);
    expect((error as SessionInitError).message).toContain('coder exploded');
    await dispose();
  });

  it('cancelInit aborts the in-flight run without wrapping the cancellation', async () => {
    const script: LlmScript = (call) => (isInitCall(call) ? 'hang' : { text: 'done' });
    const { session, calls, dispose } = await startApp({ script });
    const face = session.resolve(SessionInitRef);

    const pending = face.generateAgentsMd();
    await vi.waitFor(() => expect(calls.some(isInitCall)).toBe(true));
    face.cancelInit();

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(SessionInitError);
    await dispose();
  });

  it('cancelInit is a no-op when no init run is in flight', async () => {
    const { session, dispose } = await startApp();

    expect(() => session.resolve(SessionInitRef).cancelInit()).not.toThrow();
    await dispose();
  });

  it('exposes no facade when the host injects no os-host', async () => {
    const { session, dispose } = await startApp({ withHost: false });

    expect(session.resolve(SessionInitRef)).toBeUndefined();
    await dispose();
  });

  it('falls back to the empty-content reminder when no AGENTS.md exists after init', async () => {
    const { env, main, session, dispose } = await startApp({ withAgentsMd: false });

    await session.resolve(SessionInitRef).generateAgentsMd();
    const first = nextTurnDone(main!);
    main!.submit(createUserMessage('read'));
    await first;
    await env.stores.flush();

    const initReminders = reminderTexts(env.stores, SESSION_INIT_REMIND_KEY);
    expect(initReminders).toHaveLength(1);
    expect(initReminders[0]).toContain(
      'No AGENTS.md content was found after `/init` completed.',
    );
    await dispose();
  });
});
