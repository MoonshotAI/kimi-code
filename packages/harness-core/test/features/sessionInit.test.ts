import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFeature, useAgent, type Feature } from '@moonshot-ai/agent-core/app/index';
import { useExpose, useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type Message,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import { mergeFields } from '@moonshot-ai/agent-core/llm/requester';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';

import {
  AgentsMdReminderRef,
  createAgentsMdReminder,
  type AgentsMdReminderFace,
} from '#/features/agentsMdReminder/index';
import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import {
  createStaticProfileCatalog,
  normalizeAgentProfile,
  ProfileCatalogRef,
} from '#/features/profiles/index';
import {
  AGENT_NOT_FOUND,
  DEFAULT_INIT_PROMPT,
  SESSION_INIT_BUSY,
  SESSION_INIT_FAILED,
  SESSION_INIT_REMIND_KEY,
  SessionInitRef,
  createSessionInit,
  type SessionInitFace,
} from '#/features/sessionInit/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  type Harness,
} from '#/runtime/index';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
}

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function createMockRequester(
  script: (call: LlmCall) => string,
): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const make = (acc: Readonly<Record<string, unknown>>): LoopLlmRequester => ({
    with: (part) => make(mergeFields(acc, part as Readonly<Record<string, unknown>>) ?? {}),
    request: (rest) =>
      mergeFields(acc, rest as Readonly<Record<string, unknown>>) as unknown as LlmRequest,
    generate: async (rest) => {
      const merged = mergeFields(acc, rest as Readonly<Record<string, unknown>>) as unknown as LlmRequest;
      const call: LlmCall = {
        systemPrompt: merged.profile?.systemPrompt,
        messages: merged.content?.messages ?? [],
      };
      calls.push(call);
      return textOutcome(script(call));
    },
  });
  return { calls, requester: make({}) };
}

function testHost(homeDir: string): OsHost {
  const node = createNodeOsHost();
  return {
    process: node.process,
    fs: node.fs,
    environment: {
      osKind: 'darwin',
      osArch: 'arm64',
      osVersion: '24.0.0',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir,
      ready: Promise.resolve(),
    },
  };
}

function bindCatalog(): Feature<void> {
  return createFeature('test-profile-catalog', {
    app() {
      const catalog = createStaticProfileCatalog([
        normalizeAgentProfile({
          name: 'coder',
          description: 'General software engineering agent',
          systemPrompt: () => 'coder system prompt',
        }),
      ]);
      useExpose(ProfileCatalogRef, {
        ready: Promise.resolve(),
        ...catalog,
        reload: async () => {},
      });
    },
  });
}

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface SessionInitTestEnv {
  readonly harness: Harness;
  readonly session: Session;
  readonly main?: Agent;
  readonly calls: LlmCall[];
  readonly workDir: string;
  face(): SessionInitFace;
  reminderFace(): AgentsMdReminderFace;
}

async function startApp(opts?: {
  withMain?: boolean;
  withRequester?: boolean;
}): Promise<SessionInitTestEnv> {
  const workDir = await mkdtemp(join(tmpdir(), 'session-init-work-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'session-init-home-'));
  tmpDirs.push(workDir, homeDir);
  const { requester, calls } = createMockRequester(() => 'init summary');
  const harness = createHarness({ space: memoryHarnessSpace() });
  const host = testHost(homeDir);
  await harness.app.features.add(createSessionInit({ workDir, host }));
  await harness.app.features.add(createAgentsMdReminder({ workDir, host }));
  await harness.app.features.add(bindCatalog());
  let faceRef: Readonly<ShallowRef<SessionInitFace | undefined>> | undefined;
  await harness.app.features.add(
    createFeature('session-init-probe', {
      session: () => {
        faceRef = useInject(SessionInitRef);
      },
    }),
  );
  const reminderRefs = new Map<string, Readonly<ShallowRef<AgentsMdReminderFace | undefined>>>();
  await harness.app.features.add(
    createFeature('agents-md-reminder-probe', {
      agent: () => {
        reminderRefs.set(useAgent().id, useInject(AgentsMdReminderRef));
      },
    }),
  );
  const session = await harness.app.create({ sessionId: 'sess' });
  let main: Agent | undefined;
  if (opts?.withMain !== false) {
    main = await harness.ensureAgent(session, MAIN_AGENT_ID);
    if (opts?.withRequester !== false) setRequester(harness, session, MAIN_AGENT_ID, requester);
  }
  const face = (): SessionInitFace => {
    const value = faceRef?.value;
    if (value === undefined) throw new Error('sessionInit facade is not exposed');
    return value;
  };
  const reminderFace = (): AgentsMdReminderFace => {
    const value = reminderRefs.get(MAIN_AGENT_ID)?.value;
    if (value === undefined) throw new Error('agentsMdReminder facade is not exposed');
    return value;
  };
  return { harness, session, main, calls, workDir, face, reminderFace };
}

function setRequester(
  harness: Harness,
  session: Session,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const runtime = harnessInternals(harness.app).agents.get(session)?.get(agentId);
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

describe('sessionInit', () => {
  it('runs the coder subagent pipeline and lands seed and remind on the main agent', async () => {
    const env = await startApp();
    const main = env.main!;
    await writeFile(join(env.workDir, 'AGENTS.md'), '# Project Guide\n');
    const seeded: string[][] = [];
    env.reminderFace().seed = (paths) => seeded.push([...paths]);

    await env.face().generateAgentsMd();
    await main.flush();

    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]!.systemPrompt).toBe('coder system prompt');
    const prompt = env.calls[0]!.messages[0];
    expect(prompt?.role).toBe('user');
    expect(extractText(prompt!)).toBe(DEFAULT_INIT_PROMPT);

    const child = [...env.session.agents.values()].find((agent) => agent.id !== MAIN_AGENT_ID);
    expect(child).toBeDefined();
    await child!.flush();
    expect(env.session.roster.getState().agents[child!.id]?.source).toBe('session-init');
    expect(child!.loop.state.profile.systemPrompt).toBe('coder system prompt');
    const childTexts = child!.view
      .getState()
      .messages.filter((entry) => entry.message.role === 'user')
      .map((entry) => extractText(entry.message));
    expect(childTexts).toEqual([DEFAULT_INIT_PROMPT]);

    expect(seeded).toEqual([[join(env.workDir, 'AGENTS.md')]]);

    const queued = main.loop.state.inbox.remind.find(
      (entry) => entry.meta?.key === SESSION_INIT_REMIND_KEY,
    );
    expect(queued).toBeDefined();
    expect(extractText(queued!.message)).toContain('# Project Guide');

    await main.loop.runTurn(createUserEntry(createUserMessage('follow up'), { source: 'input' }));
    await main.flush();
    const reminder = main.view
      .getState()
      .messages.find((entry) => entry.meta?.key === SESSION_INIT_REMIND_KEY);
    expect(reminder).toBeDefined();
    const text = extractText(reminder!.message);
    expect(text).toContain('The user just ran `/init` slash command.');
    expect(text).toContain('# Project Guide');

    await env.harness.close();
  });

  it('rejects a repeated init while one is already running', async () => {
    const env = await startApp();
    const first = env.face().generateAgentsMd();
    await expect(env.face().generateAgentsMd()).rejects.toMatchObject({
      name: 'SessionInitError',
      code: SESSION_INIT_BUSY,
    });
    await first;
    await expect(env.face().generateAgentsMd()).resolves.toBeUndefined();
    expect(env.calls).toHaveLength(2);
    await env.harness.close();
  });

  it('rejects when the main agent is missing or has no model bound', async () => {
    const missing = await startApp({ withMain: false });
    await expect(missing.face().generateAgentsMd()).rejects.toMatchObject({
      name: 'SessionInitError',
      code: AGENT_NOT_FOUND,
    });
    await missing.harness.close();

    const unbound = await startApp({ withRequester: false });
    await expect(unbound.face().generateAgentsMd()).rejects.toMatchObject({
      name: 'SessionInitError',
      code: SESSION_INIT_FAILED,
      message: 'Main agent has no model bound',
    });
    await unbound.harness.close();
  });
});
