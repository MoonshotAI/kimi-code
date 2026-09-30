import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  extractText,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
} from '@moonshot-ai/agent-core';
import { BtwRef } from '@moonshot-ai/harness-core';
import { createKimiHarness, type KimiHarness, type KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { BtwPanelController } from '#/tui/controllers/btw-panel';
import { createTUIState } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';

const model: LlmModelSpec = { provider: 'test', name: 'test-model' };

function echoRequester(): AgentLlmRequester {
  const self: AgentLlmRequester = {
    with: () => self,
    request: () => {
      throw new Error('unused');
    },
    generate: async (rest, control) => {
      const last = rest.content?.messages?.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      const reply = `echo: ${text.slice(0, 40)}`;
      control.onEvent?.({
        type: 'llm.streaming.part',
        part: { type: 'text', text: reply },
      });
      const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
      control.onEvent?.({ type: 'llm.streaming.usage', usage });
      const outcome: LlmOutcome = {
        type: 'done',
        message: createAssistantMessage([{ type: 'text', text: reply }]),
        usage,
      };
      control.onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
  return self;
}

function fakeInitialAppState(workDir: string): AppState {
  return {
    model: 'test/test-model',
    workDir,
    sessionId: '',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

class BtwTestHost {
  readonly state: ReturnType<typeof createTUIState>;
  session: KimiSession | undefined;
  readonly btwPanel: BtwPanelController;
  readonly errors: string[] = [];

  constructor(workDir: string) {
    this.state = createTUIState({
      initialAppState: fakeInitialAppState(workDir),
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    this.btwPanel = new BtwPanelController(this);
  }

  showError(msg: string): void {
    this.errors.push(msg);
  }
}

interface TestEnv {
  readonly root: string;
  readonly harness: KimiHarness;
  readonly session: KimiSession;
  readonly host: BtwTestHost;
}

async function createTestEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-tui-btw-'));
  const harness = await createKimiHarness({
    homeDir: join(root, 'home'),
    workDir: join(root, 'work'),
  });
  const session = await harness.createSession();
  const host = new BtwTestHost(join(root, 'work'));
  host.session = session;
  session.main.setModel({ spec: model });
  session.handle.on('agent.opened', (event) => {
    const agentId = event['agentId'];
    if (typeof agentId !== 'string' || agentId === 'main') return;
    const child = session.handle.get(agentId);
    child?.setModel({ spec: model });
    child?.setRequester(echoRequester());
  });
  return { root, harness, session, host };
}

function panelText(host: BtwTestHost): string {
  return host.state.btwPanelContainer.children
    .flatMap((child) => child.render(80))
    .join('\n');
}

describe('btw panel (v3 harness)', () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    const current = env;
    env = undefined;
    if (current === undefined) return;
    current.host.btwPanel.clear();
    await current.harness.close();
    await rm(current.root, { recursive: true, force: true });
  });

  it('answers side questions through the forked agent and accepts follow-ups', async () => {
    env = await createTestEnv();
    const { session, host } = env;

    const btw = session.handle.resolve(BtwRef);
    if (btw === undefined) throw new Error('btw feature is not installed');
    const { agentId } = await btw.ask();
    host.btwPanel.open(agentId, 'what is 2+2?');
    expect(host.btwPanel.isActive()).toBe(true);

    const child = session.handle.get(agentId);
    expect(child).toBeDefined();
    const first = await child!.wait('turn.done', { timeoutMs: 10_000 });
    expect(first.outcome.type).toBe('done');
    expect(panelText(host)).toContain('echo: what is 2+2?');

    expect(host.btwPanel.sendUserInput('and 3+3?')).toBe(true);
    const second = await child!.wait('turn.done', { timeoutMs: 10_000 });
    expect(second.outcome.type).toBe('done');
    const text = panelText(host);
    expect(text).toContain('echo: and 3+3?');
    expect(text).toContain('Q: what is 2+2?');
    expect(host.errors).toEqual([]);

    expect(host.btwPanel.closeOrCancel()).toBe(true);
    expect(host.btwPanel.isActive()).toBe(false);
  }, 20_000);
});
