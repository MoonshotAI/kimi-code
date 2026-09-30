import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createMessageAccumulator,
  createUserMessage,
  extractText,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
  type StreamedMessagePart,
} from '@moonshot-ai/agent-core';
import { createKimiHarness, type KimiHarness, type KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { InteractionController } from '#/tui/reverse-rpc/interaction-controller';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/reverse-rpc/types';
import { SessionReplayRenderer, type SessionReplayHost } from '#/tui/controllers/session-replay';
import { StreamingUIController, type StreamingUIHost } from '#/tui/controllers/streaming-ui';
import { createTUIState } from '#/tui/tui-state';
import type { AppState, LivePaneState, TranscriptEntry } from '#/tui/types';
import { groupTurns } from '#/tui/utils/transcript-window';

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

class ReplayTestHost implements StreamingUIHost, SessionReplayHost {
  readonly state: ReturnType<typeof createTUIState>;
  session: KimiSession | undefined;
  readonly streamingUI: StreamingUIController;
  readonly replay: SessionReplayRenderer;
  readonly interactionController: InteractionController;
  readonly errors: string[] = [];

  constructor(workDir: string) {
    this.state = createTUIState({
      initialAppState: fakeInitialAppState(workDir),
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    this.streamingUI = new StreamingUIController(this);
    this.replay = new SessionReplayRenderer(this);
    this.interactionController = new InteractionController({
      showApprovalPanel: (payload: ApprovalPanelData) => {
        void payload;
        this.interactionController.respondApproval({ response: 'approved' });
      },
      hideApprovalPanel: () => {},
      showQuestionDialog: (payload: QuestionPanelData) => {
        void payload;
        this.interactionController.respondQuestion({ answers: [] });
      },
      hideQuestionDialog: () => {},
      onApprovalResolved: () => {},
    });
  }

  mountInteractions(): void {
    if (this.session !== undefined) this.interactionController.mountSession(this.session);
  }

  setAppState(patch: Partial<AppState>): void {
    Object.assign(this.state.appState, patch);
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    Object.assign(this.state.livePane, patch);
  }

  resetLivePane(): void {}

  updateActivityPane(): void {}

  updateQueueDisplay(): void {}

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  mergeCurrentTurnSteps(): void {}

  mergeCompletedTurnAssistants(): void {}

  mergeAllTurnSteps(): void {}

  showError(msg: string): void {
    this.errors.push(msg);
  }
}

interface TestEnv {
  readonly root: string;
  readonly harness: KimiHarness;
  readonly workDir: string;
}

async function createHarnessEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-tui-replay-'));
  const workDir = join(root, 'work');
  const harness = await createKimiHarness({
    homeDir: join(root, 'home'),
    workDir,
  });
  return { root, harness, workDir };
}

async function submitAndWait(session: KimiSession, text: string, promptId: string): Promise<void> {
  session.main.submit(createUserMessage(text), {
    origin: { kind: 'user' },
    tracked: true,
    promptId,
  });
  const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });
  expect(done.outcome.type).toBe('done');
}

async function closeAndReopen(
  env: TestEnv,
  session: KimiSession,
  host: ReplayTestHost,
): Promise<KimiSession> {
  await session.close();
  const resumed = await env.harness.resumeSession(session.id);
  const reopened = new ReplayTestHost(env.workDir);
  reopened.session = resumed;
  const hydrated = reopened.replay.hydrate(resumed);
  expect(hydrated).toBe(true);
  expect(reopened.errors).toEqual([]);
  void host;
  return resumed;
}

describe('session replay hydration (v3 harness)', () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    const current = env;
    env = undefined;
    if (current === undefined) return;
    await current.harness.close();
    await rm(current.root, { recursive: true, force: true });
  });

  it('hydrates the transcript from persisted turns', async () => {
    env = await createHarnessEnv();
    const session = await env.harness.createSession();
    session.main.setModel({ spec: model });
    session.main.setRequester(
      scriptedRequester((content) => {
        const messages = content.messages;
        const hasToolResult = messages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            (message as { role?: unknown }).role === 'tool',
        );
        const userTexts = messages
          .filter(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              (message as { role?: unknown }).role === 'user',
          )
          .map((message) => JSON.stringify(message));
        if (userTexts.some((text) => text.includes('second question'))) {
          return { parts: [{ type: 'text', text: 'second answer' }] };
        }
        if (hasToolResult) return { parts: [{ type: 'text', text: 'tool finished' }] };
        return {
          parts: [
            { type: 'think', think: 'pondering' },
            { type: 'text', text: 'first answer' },
          ],
          toolCall: {
            id: 'call-1',
            name: 'NoSuchTool',
            arguments: '{"command":"echo ok"}',
          },
        };
      }),
    );
    const host = new ReplayTestHost(env.workDir);
    host.session = session;
    host.mountInteractions();

    await submitAndWait(session, 'first question', 'p1');
    await submitAndWait(session, 'second question', 'p2');

    const toolEntryText = (session.handle.stores.get('main')?.getState().history ?? [])
      .filter((entry) => entry.message.role === 'tool')
      .map((entry) => extractText(entry.message))
      .join('');
    expect(toolEntryText.length).toBeGreaterThan(0);

    const resumed = await closeAndReopen(env, session, host);
    const reopened = new ReplayTestHost(env.workDir);
    reopened.session = resumed;
    expect(reopened.replay.hydrate(resumed)).toBe(true);

    const entries = reopened.state.transcriptEntries;
    const userTexts = entries
      .filter((entry) => entry.kind === 'user')
      .map((entry) => entry.content);
    expect(userTexts).toEqual(['first question', 'second question']);
    for (const entry of entries.filter((entry) => entry.kind === 'user')) {
      expect(entry.turnId).toBeUndefined();
    }

    const assistantText = entries
      .filter((entry) => entry.kind === 'assistant')
      .map((entry) => entry.content)
      .join('\n');
    expect(assistantText).toContain('first answer');
    expect(assistantText).toContain('second answer');
    expect(assistantText).toContain('tool finished');

    const thinking = reopened.state.transcriptContainer.children.filter(
      (child) => child instanceof ThinkingComponent,
    );
    expect(thinking.length).toBeGreaterThan(0);

    const toolCard = reopened.state.transcriptContainer.children.find(
      (child) => child instanceof ToolCallComponent && child.toolCallView.id === 'call-1',
    ) as ToolCallComponent | undefined;
    expect(toolCard).toBeDefined();
    expect(toolCard?.render(100).join('\n')).toContain(toolEntryText.slice(0, 20));

    const turns = groupTurns(entries).filter((turn) =>
      turn.entries.some((entry) => entry.kind === 'user'),
    );
    expect(turns.length).toBe(2);
  }, 20_000);

  it('renders replayed skill-part user entries as skill activation cards', async () => {
    env = await createHarnessEnv();
    const session = await env.harness.createSession();
    session.main.setModel({ spec: model });
    session.main.setRequester(
      scriptedRequester(() => ({ parts: [{ type: 'text', text: 'skill ran' }] })),
    );

    session.main.submit(
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<skill>body</skill>',
            contentType: 'text/xml',
            meta: {
              kind: 'skill',
              activationId: 'act-1',
              skillName: 'demo-skill',
              skillArgs: 'with args',
            },
          },
          { type: 'text', text: 'run the demo skill' },
        ],
      },
      {
        origin: { kind: 'skill_activation' },
        tracked: true,
        promptId: 'p1',
      },
    );
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');

    const host = new ReplayTestHost(env.workDir);
    host.session = session;
    const resumed = await closeAndReopen(env, session, host);
    const reopened = new ReplayTestHost(env.workDir);
    reopened.session = resumed;
    expect(reopened.replay.hydrate(resumed)).toBe(true);

    const skillEntries = reopened.state.transcriptEntries.filter(
      (entry) => entry.kind === 'skill_activation',
    );
    expect(skillEntries.length).toBe(1);
    expect(skillEntries[0]?.skillName).toBe('demo-skill');
    expect(skillEntries[0]?.skillArgs).toBe('with args');
    const userTexts = reopened.state.transcriptEntries
      .filter((entry) => entry.kind === 'user')
      .map((entry) => entry.content);
    expect(userTexts).toEqual(['run the demo skill']);
  }, 20_000);

  it('renders a compaction summary seed as a compaction card', async () => {
    env = await createHarnessEnv();
    const session = await env.harness.createSession();
    session.main.setModel({ spec: model });
    session.main.setRequester(
      scriptedRequester(() => ({ parts: [{ type: 'text', text: 'ok' }] })),
    );
    const host = new ReplayTestHost(env.workDir);
    host.session = session;
    await submitAndWait(session, 'before compaction', 'p1');

    const store = session.handle.stores.get('main');
    expect(store).toBeDefined();
    const summaryText =
      'The conversation so far has been compacted to free up context. What follows is your own working summary of this task.\nDid the thing, tests passed.';
    await store!.dispatch([
      { type: 'turn.started', turnId: 1 },
      {
        type: 'message.appended',
        message: {
          message: { role: 'user', content: [{ type: 'text', text: summaryText }] },
          meta: { source: 'compaction', key: 'summary' },
        },
      },
      { type: 'turn.ended', turnId: 1, outcome: 'done' },
    ]);

    const resumed = await closeAndReopen(env, session, host);
    const reopened = new ReplayTestHost(env.workDir);
    reopened.session = resumed;
    expect(reopened.replay.hydrate(resumed)).toBe(true);

    const compactionEntries = reopened.state.transcriptEntries.filter(
      (entry) => entry.compactionData !== undefined,
    );
    expect(compactionEntries.length).toBe(1);
    expect(compactionEntries[0]?.compactionData?.summary).toBe(
      'Did the thing, tests passed.',
    );
  }, 20_000);

  it('renders cron-origin entries as cron cards', async () => {
    env = await createHarnessEnv();
    const session = await env.harness.createSession();
    session.main.setModel({ spec: model });
    session.main.setRequester(
      scriptedRequester(() => ({ parts: [{ type: 'text', text: 'cron ran' }] })),
    );

    const cronOrigin = {
      kind: 'cron_job',
      jobId: 'job-9',
      cron: '0 9 * * *',
      recurring: true,
      coalescedCount: 0,
      stale: false,
    };
    session.main.submit(
      createUserMessage('<cron-fire jobId="job-9" cron="0 9 * * *" recurring="true" coalescedCount="0" stale="false">\n<prompt>\nDaily standup summary\n</prompt>\n</cron-fire>'),
      {
        origin: cronOrigin,
        tracked: true,
        promptId: 'p1',
      },
    );
    const done = await session.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');

    const host = new ReplayTestHost(env.workDir);
    host.session = session;
    const resumed = await closeAndReopen(env, session, host);
    const reopened = new ReplayTestHost(env.workDir);
    reopened.session = resumed;
    expect(reopened.replay.hydrate(resumed)).toBe(true);

    const cronEntries = reopened.state.transcriptEntries.filter(
      (entry) => entry.kind === 'cron',
    );
    expect(cronEntries.length).toBe(1);
    expect(cronEntries[0]?.content).toBe('Daily standup summary');
    expect(cronEntries[0]?.cronData?.jobId).toBe('job-9');
    const userEntries = reopened.state.transcriptEntries.filter(
      (entry) => entry.kind === 'user' && entry.content.includes('cron-fire'),
    );
    expect(userEntries.length).toBe(0);
  }, 20_000);
});
