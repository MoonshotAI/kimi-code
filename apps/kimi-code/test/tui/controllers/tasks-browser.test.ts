import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createMessageAccumulator,
  createUserMessage,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
  type StreamedMessagePart,
} from '@moonshot-ai/agent-core';
import { TaskRef, type TaskFace } from '@moonshot-ai/harness-core';
import { createKimiHarness, type KimiHarness, type KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { TasksBrowserApp } from '#/tui/components/dialogs/tasks-browser';
import { InteractionController } from '#/tui/reverse-rpc/interaction-controller';
import { TasksBrowserController } from '#/tui/controllers/tasks-browser';
import { createTUIState } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';

const model: LlmModelSpec = { provider: 'test', name: 'test-model' };

function scriptedRequester(
  steps: (input: { readonly messages: readonly { role?: unknown }[] }) => {
    parts: StreamedMessagePart[];
    toolCall?: { id: string; name: string; arguments: string };
  },
): AgentLlmRequester {
  const self: AgentLlmRequester = {
    with: () => self,
    request: () => {
      throw new Error('unused');
    },
    generate: async (rest, control) => {
      const step = steps({ messages: rest.content?.messages ?? [] });
      const accumulator = createMessageAccumulator();
      for (const part of step.parts) {
        control.onEvent?.({ type: 'llm.streaming.part', part });
        accumulator.push(part);
      }
      if (step.toolCall !== undefined) {
        const part: StreamedMessagePart = {
          type: 'function',
          id: step.toolCall.id,
          name: step.toolCall.name,
          arguments: step.toolCall.arguments,
        };
        control.onEvent?.({ type: 'llm.streaming.part', part });
        accumulator.push(part);
      }
      const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
      control.onEvent?.({ type: 'llm.streaming.usage', usage });
      const outcome: LlmOutcome = { type: 'done', message: accumulator.finish(), usage };
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

class TasksTestHost {
  readonly state: ReturnType<typeof createTUIState>;
  session: KimiSession | undefined;
  readonly tasksBrowser: TasksBrowserController;
  readonly interactionController: InteractionController;
  readonly errors: string[] = [];

  constructor(workDir: string) {
    this.state = createTUIState({
      initialAppState: fakeInitialAppState(workDir),
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    this.tasksBrowser = new TasksBrowserController(this);
    this.interactionController = new InteractionController({
      showApprovalPanel: () => {
        this.interactionController.respondApproval({ response: 'approved' });
      },
      hideApprovalPanel: () => {},
      showQuestionDialog: () => {
        this.interactionController.respondQuestion({ answers: [] });
      },
      hideQuestionDialog: () => {},
      onApprovalResolved: () => {},
    });
  }

  mainAgent() {
    return this.session?.handle.get('main') ?? this.session?.main;
  }

  showError(msg: string): void {
    this.errors.push(msg);
  }
}

interface TestEnv {
  readonly root: string;
  readonly harness: KimiHarness;
  readonly session: KimiSession;
  readonly host: TasksTestHost;
}

async function createTestEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-tui-tasks-'));
  const workDir = join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const harness = await createKimiHarness({
    homeDir: join(root, 'home'),
    workDir,
  });
  const session = await harness.createSession();
  const host = new TasksTestHost(join(root, 'work'));
  host.session = session;
  session.main.setModel({ spec: model });
  host.interactionController.mountSession(session);
  return { root, harness, session, host };
}

async function waitForRecord(face: TaskFace, predicate: (status: string) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = [...face.records.value.values()][0];
    if (record !== undefined && predicate(record.status)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for task record; have ${record?.status ?? 'none'}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function mountedBrowser(host: TasksTestHost): TasksBrowserApp | undefined {
  return host.state.ui.children.find(
    (child): child is TasksBrowserApp => child instanceof TasksBrowserApp,
  );
}

describe('tasks browser (v3 harness)', () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    const current = env;
    env = undefined;
    if (current === undefined) return;
    current.host.tasksBrowser.close();
    await current.harness.close();
    await rm(current.root, { recursive: true, force: true });
  });

  it('lists a detached Bash task from TaskRef and renders its output', async () => {
    env = await createTestEnv();
    const { session, host } = env;
    session.main.setRequester(
      scriptedRequester((content) => {
        const hasToolResult = content.messages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            (message as { role?: unknown }).role === 'tool',
        );
        if (hasToolResult) {
          return { parts: [{ type: 'text', text: 'backgrounded' }] };
        }
        return {
          parts: [],
          toolCall: {
            id: 'call-bg-1',
            name: 'Bash',
            arguments: JSON.stringify({
              command: 'echo hi-from-bg',
              description: 'bg echo',
              run_in_background: true,
            }),
          },
        };
      }),
    );

    session.main.submit(createUserMessage('run it in background'), {
      origin: { kind: 'user' },
      tracked: true,
      promptId: 'p1',
    });
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');

    const face = session.main.resolve(TaskRef);
    if (face === undefined) throw new Error('task feature is not installed');
    await waitForRecord(face, (status) => status === 'completed');

    host.tasksBrowser.show();
    expect(host.tasksBrowser.isOpen()).toBe(true);
    const browser = mountedBrowser(host);
    expect(browser).toBeDefined();
    const rendered = browser!.render(120).join('\n');
    expect(rendered).toContain('call-bg-1');
    expect(rendered).toContain('bg echo');
    expect(rendered).toContain('completed');
    expect(rendered).toContain('hi-from-bg');
    expect(host.errors).toEqual([]);
  }, 20_000);

  it('stops a running detached task from the browser', async () => {
    env = await createTestEnv();
    const { session, host } = env;
    session.main.setRequester(
      scriptedRequester((content) => {
        const hasToolResult = content.messages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            (message as { role?: unknown }).role === 'tool',
        );
        if (hasToolResult) {
          return { parts: [{ type: 'text', text: 'backgrounded' }] };
        }
        return {
          parts: [],
          toolCall: {
            id: 'call-bg-2',
            name: 'Bash',
            arguments: JSON.stringify({
              command: 'sleep 60',
              description: 'bg sleeper',
              run_in_background: true,
            }),
          },
        };
      }),
    );

    session.main.submit(createUserMessage('sleep in background'), {
      origin: { kind: 'user' },
      tracked: true,
      promptId: 'p1',
    });
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');

    const face = session.main.resolve(TaskRef);
    if (face === undefined) throw new Error('task feature is not installed');
    await waitForRecord(face, (status) => status === 'running');

    host.tasksBrowser.show();
    expect(host.tasksBrowser.isOpen()).toBe(true);
    const browser = mountedBrowser(host);
    expect(browser).toBeDefined();
    expect(browser!.render(120).join('\n')).toContain('running');

    await face.stop('call-bg-2', 'test stop');
    await waitForRecord(face, (status) => status === 'killed');
    const record = [...face.records.value.values()][0];
    expect(record?.status).toBe('killed');
    expect(host.errors).toEqual([]);
  }, 20_000);
});
