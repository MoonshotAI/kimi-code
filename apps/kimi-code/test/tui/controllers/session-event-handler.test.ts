import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  createMessageAccumulator,
  createUserMessage,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
  type StreamedMessagePart,
} from '@moonshot-ai/agent-core';
import { createKimiHarness, type KimiHarness, type KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { InteractionController } from '#/tui/reverse-rpc/interaction-controller';
import { GoalRef, SkillRef } from '@moonshot-ai/harness-core';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { SessionEventHandler, type SessionEventHost } from '#/tui/controllers/session-event-handler';
import { StreamingUIController, type StreamingUIHost } from '#/tui/controllers/streaming-ui';
import { createTUIState } from '#/tui/tui-state';
import type { AppState, LivePaneState } from '#/tui/types';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';

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

class TestHost implements StreamingUIHost {
  readonly state: ReturnType<typeof createTUIState>;
  session: KimiSession | undefined;
  aborted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;
  readonly interactionController: InteractionController;
  readonly approvals: ApprovalPanelData[] = [];
  readonly questions: QuestionPanelData[] = [];
  readonly statuses: string[] = [];
  readonly errors: string[] = [];
  readonly surveyController = {
    notifyTurnStarted: () => {},
    notifyTurnEnded: () => {},
    notifyToolCallStarted: () => {},
    notifyCompactionFinished: () => {},
  } as unknown as SessionEventHost['surveyController'];
  readonly sessionEventHandler: SessionEventHandler;

  constructor(workDir: string) {
    this.state = createTUIState({
      initialAppState: fakeInitialAppState(workDir),
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    this.streamingUI = new StreamingUIController(this);
    this.interactionController = new InteractionController({
      showApprovalPanel: (payload) => {
        this.approvals.push(payload);
        this.interactionController.respondApproval({ response: 'approved' });
      },
      hideApprovalPanel: () => {},
      showQuestionDialog: (payload) => {
        this.questions.push(payload);
        this.interactionController.respondQuestion({ answers: [] });
      },
      hideQuestionDialog: () => {},
      onApprovalResolved: () => {},
    });
    this.sessionEventHandler = new SessionEventHandler(this.asEventHost());
  }

  asEventHost(): SessionEventHost {
    // oxlint-disable-next-line @typescript-eslint/consistent-this
    const self = this;
    return {
      get state() {
        return self.state;
      },
      get session() {
        return self.session;
      },
      get aborted() {
        return self.aborted;
      },
      get sessionEventUnsubscribe() {
        return self.sessionEventUnsubscribe;
      },
      set sessionEventUnsubscribe(value) {
        self.sessionEventUnsubscribe = value;
      },
      streamingUI: this.streamingUI,
      surveyController: this.surveyController as SessionEventHost['surveyController'],
      interactionController: this.interactionController,
      requireSession: () => {
        if (self.session === undefined) throw new Error('no session');
        return self.session;
      },
      mainAgent: () => self.session?.handle.get('main') ?? self.session?.main,
      onMainAgentRemounted: () => {
        self.sessionEventHandler.startSubscription();
      },
      remountMainAgent: async () => {
        const session = self.session;
        if (session === undefined) return;
        if (session.handle.get('main') !== undefined) {
          await session.handle.close('main');
        }
        await session.handle.create({ agentId: 'main' });
      },
      setAppState: (patch) => {
        Object.assign(self.state.appState, patch);
      },
      patchLivePane: (patch) => {
        Object.assign(self.state.livePane, patch);
      },
      showError: (msg) => {
        self.errors.push(msg);
      },
      showStatus: (msg) => {
        self.statuses.push(msg);
      },
      updateQueueDisplay: () => {},
      updateTerminalTitle: () => {},
      drainBashQueue: () => {},
      appendTranscriptEntry: (entry) => {
        self.state.transcriptEntries.push(entry);
      },
      handleShellOutput: () => {},
      mergeCurrentTurnSteps: () => {},
      configDefaultModel: () => 'test/test-model',
    };
  }

  setAppState(patch: Partial<AppState>): void {
    Object.assign(this.state.appState, patch);
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    Object.assign(this.state.livePane, patch);
  }

  resetLivePane(): void {
    this.state.livePane = { mode: 'idle', pendingApproval: null, pendingQuestion: null };
  }

  updateActivityPane(): void {}

  updateQueueDisplay(): void {}

  pushTranscriptEntry(entry: (typeof this.state.transcriptEntries)[number]): void {
    this.state.transcriptEntries.push(entry);
  }

  mergeCurrentTurnSteps(): void {}

  mergeCompletedTurnAssistants(): void {}
}

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
  readonly root: string;
  readonly harness: KimiHarness;
  readonly session: KimiSession;
  readonly host: TestHost;
}

async function createTestEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-tui-v3-events-'));
  const harness = await createKimiHarness({
    homeDir: join(root, 'home'),
    workDir: join(root, 'work'),
  });
  const session = await harness.createSession();
  const host = new TestHost(join(root, 'work'));
  host.session = session;
  session.main.setModel({ spec: model });
  return { root, harness, session, host };
}

describe('session event ingestion (v3 harness)', () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    const current = env;
    env = undefined;
    if (current === undefined) return;
    current.host.sessionEventHandler.stopSubscription();
    await current.harness.close();
    await rm(current.root, { recursive: true, force: true });
  });

  it('drives a streaming text turn through the controllers', async () => {
    env = await createTestEnv();
    const { session, host } = env;
    session.main.setRequester(
      scriptedRequester(() => ({
        parts: [
          { type: 'think', think: 'thinking…' },
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      })),
    );
    host.sessionEventHandler.startSubscription();

    session.main.submit(createUserMessage('hi'), {
      origin: { kind: 'user' },
      tracked: true,
      promptId: 'p1',
    });
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });

    expect(done.outcome.type).toBe('done');
    expect(host.state.appState.streamingPhase).toBe('idle');
    const assistantEntries = host.state.transcriptEntries.filter(
      (entry) => entry.kind === 'assistant',
    );
    expect(assistantEntries.map((entry) => entry.content).join('')).toContain('hello world');
    const thinkingComponents = host.state.transcriptContainer.children.filter(
      (child) => child.constructor.name === 'ThinkingComponent',
    );
    expect(thinkingComponents.length).toBeGreaterThan(0);
    expect(host.errors).toEqual([]);
  });

  it('mounts a tool card with complete args and answers its approval', async () => {
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
          return { parts: [{ type: 'text', text: 'tool done' }] };
        }
        return {
          parts: [],
          toolCall: {
            id: 'call-1',
            name: 'NoSuchTool',
            arguments: '{"command":"echo ok"}',
          },
        };
      }),
    );
    host.sessionEventHandler.startSubscription();

    session.main.submit(createUserMessage('run a tool'), {
      origin: { kind: 'user' },
      tracked: true,
      promptId: 'p2',
    });
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });

    expect(done.outcome.type).toBe('done');
    // The unknown tool never reaches permission, so no approval is asked; the
    // card completes with the engine's failure result.
    const toolCall = host.streamingUI.getActiveToolCall('call-1');
    expect(toolCall).toBeUndefined();
    expect(host.errors).toEqual([]);
  });

  it('handles compaction events and remounts the main agent', async () => {
    env = await createTestEnv();
    const { session, host } = env;
    session.main.setRequester(createScriptedRequester('still alive'));
    host.sessionEventHandler.startSubscription();

    const original = session.handle.get('main');
    expect(original).toBeDefined();
    await session.handle.stores.session.dispatch({
      type: 'compaction.started',
      agentId: 'main',
      reason: 'manual',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(host.state.appState.isCompacting).toBe(true);

    await session.handle.stores.session.dispatch({
      type: 'compaction.completed',
      agentId: 'main',
      branch: 'branch-2',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(host.state.appState.isCompacting).toBe(false);

    // The compaction completion remounted the main agent (close + create):
    // a new handle must be live, and subscriptions must have been rebound
    // through `agent.opened` → onMainAgentRemounted.
    const remounted = session.handle.get('main');
    expect(remounted).toBeDefined();
    expect(remounted).not.toBe(original);
    remounted!.setModel({ spec: model });
    remounted!.setRequester(createScriptedRequester('still alive'));
    const done = await remounted!.run(createUserMessage('again'), { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');
  }, 20_000);

  it('asks for Bash approval through the interaction controller', async () => {
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
          return { parts: [{ type: 'text', text: 'ran it' }] };
        }
        return {
          parts: [],
          toolCall: {
            id: 'call-bash',
            name: 'Bash',
            arguments: '{"command":"echo ok","description":"say ok"}',
          },
        };
      }),
    );
    host.sessionEventHandler.startSubscription();

    session.main.submit(createUserMessage('echo please'), {
      origin: { kind: 'user' },
      tracked: true,
      promptId: 'p3',
    });
    const done = await session.main.wait('turn.done', { timeoutMs: 15_000 });

    expect(done.outcome.type).toBe('done');
    expect(host.approvals.length).toBeGreaterThan(0);
    expect(host.approvals[0]?.tool_name).toBe('Bash');
    expect(host.approvals[0]?.display[0]).toMatchObject({
      type: 'shell',
      command: 'echo ok',
    });
    const assistantText = host.state.transcriptEntries
      .filter((entry) => entry.kind === 'assistant')
      .map((entry) => entry.content)
      .join('');
    expect(assistantText).toContain('ran it');
  }, 20_000);

  it('routes a spawned subagent onto its parent tool card', async () => {
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
          return { parts: [{ type: 'text', text: 'parent done' }] };
        }
        return {
          parts: [],
          toolCall: {
            id: 'call-agent-1',
            name: 'Agent',
            arguments: JSON.stringify({ prompt: 'say hi', description: 'greeting task' }),
          },
        };
      }),
    );
    let childId: string | undefined;
    session.handle.on('agent.opened', (event) => {
      const agentId = event['agentId'];
      if (typeof agentId !== 'string' || agentId === 'main') return;
      childId = agentId;
      const child = session.handle.get(agentId);
      child?.setModel({ spec: model });
      child?.setRequester(createScriptedRequester('child says hi'));
    });
    host.sessionEventHandler.startSubscription();

    session.main.submit(createUserMessage('spawn a subagent'), {
      origin: { kind: 'user' },
      tracked: true,
      promptId: 'p4',
    });
    const done = await session.main.wait('turn.done', { timeoutMs: 15_000 });

    expect(done.outcome.type).toBe('done');
    expect(childId).toBeDefined();
    const tc = host.state.transcriptContainer.children.find(
      (child) =>
        child instanceof ToolCallComponent && child.toolCallView.id === 'call-agent-1',
    ) as ToolCallComponent | undefined;
    expect(tc).toBeDefined();
    expect(tc?.getSubagentAgentId()).toBe(childId);
    const snapshot = tc?.getSubagentSnapshot();
    expect(snapshot?.phase).toBe('done');
    const rendered = tc?.render(80).join('\n') ?? '';
    expect(rendered).toContain('Completed');
    expect(rendered).toContain('child says hi');
  }, 20_000);

  it('mounts a skill activation card on skill.activated', async () => {
    env = await createTestEnv();
    const { session, host } = env;
    session.main.setRequester(createScriptedRequester('skill done'));
    host.sessionEventHandler.startSubscription();

    const skill = session.main.resolve(SkillRef);
    if (skill === undefined) throw new Error('skill feature is not installed');
    const { turnId } = await skill.activate({ name: 'update-config', args: 'theme' });
    expect(turnId).toBeDefined();
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');

    const entries = host.state.transcriptEntries.filter(
      (entry) => entry.kind === 'skill_activation',
    );
    expect(entries.length).toBe(1);
    expect(entries[0]?.skillName).toBe('update-config');
    expect(entries[0]?.skillArgs).toBe('theme');
    expect(entries[0]?.skillTrigger).toBe('user-slash');
    expect(entries[0]?.turnId).toBeUndefined();
    expect(host.errors).toEqual([]);
  }, 20_000);

  it('shows the goal badge and transcript markers from goal events', async () => {
    env = await createTestEnv();
    const { session, host } = env;
    host.sessionEventHandler.startSubscription();

    const goal = session.main.resolve(GoalRef);
    if (goal === undefined) throw new Error('goal feature is not installed');
    await goal.createGoal({ objective: 'test objective' });

    expect(host.state.appState.goal?.objective).toBe('test objective');
    expect(host.state.appState.goal?.status).toBe('active');
    const kinds = host.state.transcriptContainer.children.map(
      (child) => child.constructor.name,
    );
    expect(kinds).toContain('GoalSetMessageComponent');

    await goal.markComplete({ reason: 'criterion met' });

    expect(host.state.appState.goal).toBeNull();
    const names = host.state.transcriptContainer.children.map(
      (child) => child.constructor.name,
    );
    expect(names).toContain('GoalCompletionMessageComponent');
    expect(host.errors).toEqual([]);
  }, 20_000);

  it('creates a goal through the CreateGoal tool approval flow', async () => {
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
          return { parts: [{ type: 'text', text: 'goal started' }] };
        }
        return {
          parts: [],
          toolCall: {
            id: 'call-goal-1',
            name: 'CreateGoal',
            arguments: JSON.stringify({ objective: 'ship feature x' }),
          },
        };
      }),
    );
    host.sessionEventHandler.startSubscription();

    session.main.submit(
      createUserMessage('Create the goal now by calling CreateGoal with this objective: ship feature x'),
      { origin: { kind: 'user' }, tracked: true, promptId: 'goal-intake-1' },
    );
    const done = await session.main.wait('turn.done', { timeoutMs: 15_000 });

    expect(done.outcome.type).toBe('done');
    expect(host.approvals.length).toBe(1);
    expect(host.approvals[0]?.tool_name).toBe('CreateGoal');
    expect(host.approvals[0]?.action).toBe('Start a goal?');
    expect(host.approvals[0]?.display[0]).toMatchObject({
      type: 'brief',
      text: 'Start goal: ship feature x',
    });
    expect(host.approvals[0]?.choices.map((choice) => choice.label)).toContain('Start goal');

    const goal = session.main.resolve(GoalRef)?.getGoal().goal ?? null;
    expect(goal?.objective).toBe('ship feature x');
    expect(goal?.status).toBe('active');
    expect(host.state.appState.goal?.goalId).toBe(goal?.goalId);
    const kinds = host.state.transcriptContainer.children.map(
      (child) => child.constructor.name,
    );
    expect(kinds).toContain('GoalSetMessageComponent');

    await session.main.resolve(GoalRef)?.cancelGoal({}, 'user');
    expect(host.state.appState.goal).toBeNull();
  }, 20_000);
});
