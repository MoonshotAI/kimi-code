import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  createUserMessage,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
} from '@moonshot-ai/agent-core';

import { createKimiHarness, createWorkspaceTrustStore, type KimiHarness } from '#/index';

const model: LlmModelSpec = { provider: 'test', name: 'test-model' };

function createScriptedRequester(text: string): AgentLlmRequester {
  const self: AgentLlmRequester = {
    with: () => self,
    request: () => {
      throw new Error('unused');
    },
    generate: async (_rest, control) => {
      control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text } });
      const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
      control.onEvent?.({ type: 'llm.streaming.usage', usage });
      const outcome: LlmOutcome = {
        type: 'done',
        message: createAssistantMessage([{ type: 'text', text }]),
        usage,
      };
      control.onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
  return self;
}

interface TestEnv {
  readonly homeDir: string;
  readonly workDir: string;
  readonly harness: KimiHarness;
}

async function createTestEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
  const homeDir = join(root, 'home');
  const workDir = join(root, 'work');
  const harness = await createKimiHarness({ homeDir, workDir });
  return { homeDir, workDir, harness };
}

describe('kimi harness composition', () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    const current = env;
    env = undefined;
    if (current === undefined) return;
    await current.harness.close();
    await rm(join(current.homeDir, '..'), { recursive: true, force: true });
  });

  it('mounts and creates a session with a main agent', async () => {
    env = await createTestEnv();
    const session = await env.harness.createSession();
    expect(session.id).toMatch(/^session_/);
    expect(session.main.agentId).toBe('main');
    expect(env.harness.sessions.get(session.id)).toBe(session);
    const listed = await env.harness.listSessions();
    expect(listed.some((record) => record.id === session.id)).toBe(true);
  });

  it('persists config writes to the TOML file', async () => {
    env = await createTestEnv();
    await env.harness.config.set('defaultModel', 'test/test-model', 'user');
    expect(env.harness.config.get<string>('defaultModel')).toBe('test/test-model');
    const text = await readFile(env.harness.configPath, 'utf-8');
    expect(text).toContain('test/test-model');
  });

  it('round-trips workspace trust through the trust store file', async () => {
    env = await createTestEnv();
    expect(env.harness.trust.isTrusted(env.workDir)).toBe(false);
    env.harness.trust.trust(env.workDir);
    expect(env.harness.trust.isTrusted(env.workDir)).toBe(true);
    expect(env.harness.trust.isTrusted(join(env.workDir, 'nested', 'dir'))).toBe(true);
    expect(createWorkspaceTrustStore(env.homeDir).isTrusted(env.workDir)).toBe(true);
    env.harness.trust.untrust(env.workDir);
    expect(env.harness.trust.isTrusted(env.workDir)).toBe(false);
  });

  it('runs a turn to completion with a scripted requester', async () => {
    env = await createTestEnv();
    const session = await env.harness.createSession();
    session.main.setModel({ spec: model });
    session.main.setRequester(createScriptedRequester('sdk turn ok'));
    const result = await session.main.run(createUserMessage('hello'));
    expect(result.outcome.type).toBe('done');
  });
});
