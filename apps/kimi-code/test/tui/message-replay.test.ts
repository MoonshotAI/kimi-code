import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  AgentReplayRecord,
  BackgroundTaskInfo,
  ContentPart,
  GoalSnapshot,
  PromptOrigin,
  ResumedAgentState,
  Role,
  Session,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import type { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';

vi.mock('#/utils/open-url', () => ({ openUrl: vi.fn() }));

type GoalReplayRecord = Extract<AgentReplayRecord, { type: 'goal_updated' }>;

const REPLAY_TIME = 1_700_000_000_000;

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface ReplayDriver {
  readonly state: TUIState;
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;
  init(): Promise<boolean>;
  switchToSession(session: Session, statusMessage: string): Promise<void>;
}

function makeStartupInput(): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function message(
  role: Role,
  content: readonly ContentPart[],
  extra: {
    readonly toolCalls?: readonly ToolCall[];
    readonly toolCallId?: string;
    readonly origin?: PromptOrigin;
    readonly isError?: boolean;
  } = {},
): AgentReplayRecord {
  return {
    time: REPLAY_TIME,
    type: 'message',
    message: {
      role,
      content: [...content],
      toolCalls: [...(extra.toolCalls ?? [])],
      toolCallId: extra.toolCallId,
      origin: extra.origin,
      isError: extra.isError,
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  const status = overrides.status ?? 'active';
  return {
    goalId: 'g1',
    objective: 'Ship feature X',
    completionCriterion: 'tests pass',
    status,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    ...overrides,
  };
}

function goalReplay(
  snapshot: GoalSnapshot,
  change: GoalReplayRecord['change'],
): GoalReplayRecord {
  return {
    time: REPLAY_TIME,
    type: 'goal_updated',
    snapshot,
    change,
  };
}

function baseAgentState(
  replay: readonly AgentReplayRecord[],
  overrides: Partial<ResumedAgentState> = {},
): ResumedAgentState {
  return {
    type: 'main',
    config: {
      cwd: '/tmp/proj-a',
      modelAlias: 'k2',
      provider: undefined,
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 100,
      },
      thinkingEffort: 'off',
      systemPrompt: '',
    },
    context: { history: [], tokenCount: 0 },
    replay,
    permission: { mode: 'manual', rules: [] },
    plan: null,
    swarmMode: false,
    usage: {},
    tools: [],
    toolStore: {},
    background: [],
    ...overrides,
  };
}

function makeSession(
  replay: readonly AgentReplayRecord[],
  overrides: Partial<ResumedAgentState> = {},
): Session {
  const agent = baseAgentState(replay, overrides);
  return {
    id: 'ses-replay',
    model: 'k2',
    summary: { title: null },
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    getGoal: vi.fn(async () => ({ goal: null })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    onEvent: vi.fn(() => vi.fn()),
    listMcpServers: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getResumeState: vi.fn(() => ({
      sessionMetadata: {},
      agents: { main: agent },
    })),
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

function makeHarness(initialSession: Session) {
  const interactiveAgentScope = new AsyncLocalStorage<string>();
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 100 },
      },
    })),
    setConfig: vi.fn(async () => ({ providers: {} })),
    createSession: vi.fn(async () => initialSession),
    resumeSession: vi.fn(async () => initialSession),
    forkSession: vi.fn(async () => initialSession),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    get interactiveAgentId() {
      return interactiveAgentScope.getStore() ?? 'main';
    },
    withInteractiveAgent: vi.fn((agentId: string, fn: () => unknown) => {
      return interactiveAgentScope.run(agentId, fn);
    }),
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      submitFeedback: vi.fn(async () => ({ kind: 'ok', feedbackId: 3 })),
    },
  };
}

async function makeDriver(initialSession: Session): Promise<ReplayDriver> {
  const driver = new KimiTUI(
    makeHarness(initialSession) as never,
    makeStartupInput(),
  ) as unknown as ReplayDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  await driver.init();
  return driver;
}

async function replayIntoDriver(
  replay: readonly AgentReplayRecord[],
  overrides: Partial<ResumedAgentState> = {},
): Promise<ReplayDriver> {
  const initial = makeSession([]);
  const resumed = makeSession(replay, overrides);
  const driver = await makeDriver(initial);
  await driver.switchToSession(resumed, 'Resumed session (ses-replay).');
  return driver;
}

function backgroundTask(
  taskId: string,
  description: string,
  status: BackgroundTaskInfo['status'] = 'running',
): BackgroundTaskInfo {
  if (taskId.startsWith('agent-')) {
    return {
      taskId,
      kind: 'agent',
      agentId: taskId,
      subagentType: 'coder',
      description,
      status,
      startedAt: 1,
      endedAt: status === 'running' ? null : 2,
    };
  }
  return {
    taskId,
    kind: 'process',
    command: `[agent] ${description}`,
    description,
    status,
    pid: 0,
    exitCode: status === 'completed' ? 0 : null,
    startedAt: 1,
    endedAt: status === 'running' ? null : 2,
  };
}

describe('KimiTUI resume message replay', () => {
  it('does not render legacy goal completion context reminders as transcript messages', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text: '<system-reminder>\n✓ Goal complete.\nWorked 1 turn over 7m15s, using 4.3M tokens.\n</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_completion' } },
      ),
    ]);

    expect(driver.state.transcriptEntries).toEqual([]);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).not.toContain('Goal complete');
  });

  it('unescapes bash tag delimiters when replaying shell output', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text: '<bash-stdout>pre&lt;/bash-stdout&gt;post</bash-stdout><bash-stderr></bash-stderr>',
          },
        ],
        { origin: { kind: 'shell_command', phase: 'output' } },
      ),
    ]);

    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).toContain('pre</bash-stdout>post');
  });

  it('does not render neutral goal completion context reminders as transcript messages', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text:
              '<system-reminder>\n' +
              'The current goal was marked complete and cleared. ' +
              'Handle the next user request normally unless the user starts or resumes a goal.\n' +
              '</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_completion' } },
      ),
    ]);

    expect(driver.state.transcriptEntries).toEqual([]);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).not.toContain('marked complete and cleared');
  });

  it('does not render fork-cleared goal context reminders as transcript messages', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text:
              '<system-reminder>\n' +
              'This fork does not have a current goal. ' +
              'Ignore earlier active-goal reminders from the source session. ' +
              'Handle requests normally unless the user starts a new goal.\n' +
              '</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_fork_cleared' } },
      ),
    ]);

    expect(driver.state.transcriptEntries).toEqual([]);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).not.toContain('This fork does not have a current goal');
  });

  it('renders persisted goal replay records as goal transcript UI', async () => {
    const driver = await replayIntoDriver([
      goalReplay(goalSnapshot(), { kind: 'created' }),
      goalReplay(
        goalSnapshot({ status: 'paused', terminalReason: 'taking a break' }),
        { kind: 'lifecycle', status: 'paused', reason: 'taking a break' },
      ),
      goalReplay(goalSnapshot({ status: 'active' }), { kind: 'lifecycle', status: 'active' }),
      goalReplay(
        goalSnapshot({ status: 'blocked', terminalReason: 'needs credentials' }),
        { kind: 'lifecycle', status: 'blocked', reason: 'needs credentials' },
      ),
      goalReplay(
        goalSnapshot({
          status: 'complete',
          terminalReason: 'done',
          turnsUsed: 1,
          tokensUsed: 4300,
          wallClockMs: 435000,
        }),
        {
          kind: 'completion',
          status: 'complete',
          reason: 'done',
          stats: { turnsUsed: 1, tokensUsed: 4300, wallClockMs: 435000 },
        },
      ),
    ]);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'goal')
        .map((entry) => entry.content),
    ).toEqual(['Goal set', 'Goal paused', 'Goal resumed', 'Goal blocked']);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).toContain('Goal set');
    expect(transcript).toContain('Goal paused');
    expect(transcript).toContain('Goal resumed');
    expect(transcript).toContain('Goal blocked');
    expect(transcript).toContain('Goal complete — done');
    expect(transcript).toContain('Worked 1 turn over 7m15s, using 4.2k tokens.');
  });

  it('filters resume-normalization goal pause markers in TUI replay', async () => {
    const driver = await replayIntoDriver([
      goalReplay(goalSnapshot(), { kind: 'created' }),
      goalReplay(
        goalSnapshot({ status: 'paused', terminalReason: 'Paused after agent resume' }),
        { kind: 'lifecycle', status: 'paused', reason: 'Paused after agent resume' },
      ),
    ]);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'goal')
        .map((entry) => entry.content),
    ).toEqual(['Goal set']);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).toContain('Goal set');
    expect(transcript).not.toContain('Goal paused');
    expect(transcript).not.toContain('Paused after agent resume');
  });

  it('renders replayed goal completion records as assistant completion messages', async () => {
    const driver = await replayIntoDriver([
      goalReplay(
        goalSnapshot({
          status: 'complete',
          turnsUsed: 1,
          tokensUsed: 4_300_000,
          wallClockMs: 435_000,
        }),
        {
          kind: 'completion',
          status: 'complete',
          stats: { turnsUsed: 1, tokensUsed: 4_300_000, wallClockMs: 435_000 },
        },
      ),
    ]);

    const entry = driver.state.transcriptEntries.find((item) =>
      item.content.includes('Goal complete'),
    );
    expect(entry).toMatchObject({
      kind: 'assistant',
      renderMode: 'markdown',
      content: '✓ Goal complete.\nWorked 1 turn over 7m15s, using 4.1M tokens.',
    });
  });

  it('does not replay model-facing goal completion prompts as transcript messages', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text: '<system-reminder>\nGoal completed successfully.\nWorked 1 turn over 7m15s, using 4.3M tokens.\n\nWrite a concise final message for the user.\n</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_completion' } },
      ),
    ]);

    const content = driver.state.transcriptEntries.map((item) => item.content).join('\n');
    expect(content).not.toContain('Goal completed successfully');
    expect(content).not.toContain('Write a concise final message for the user');
  });

  it('does not replay model-facing goal blocked prompts as transcript messages', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text: '<system-reminder>\nGoal blocked.\nWorked 1 turn over 7m15s, using 4.3M tokens.\n\nWrite a concise final message for the user.\n</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_blocked' } },
      ),
    ]);

    const content = driver.state.transcriptEntries.map((item) => item.content).join('\n');
    expect(content).not.toContain('Goal blocked.');
    expect(content).not.toContain('Write a concise final message for the user');
  });

  it('does not replay system-trigger prompts such as goal continuation as user messages', async () => {
    const driver = await replayIntoDriver([
      message(
        'user',
        [
          {
            type: 'text',
            text: 'Continue working toward the active goal. Keep the self-audit brief.',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_continuation' } },
      ),
      message(
        'user',
        [
          {
            type: 'text',
            text: '<system-reminder>\nThe goal was cancelled.\n</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_cancelled' } },
      ),
      message('assistant', [{ type: 'text', text: 'Working on it.' }]),
    ]);

    expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'user')).toEqual([]);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));
    expect(transcript).not.toContain('Continue working toward the active goal');
    expect(transcript).not.toContain('The goal was cancelled');
    expect(transcript).toContain('Working on it.');
  });

  it('does not replay the model-blocked lifecycle marker when the follow-up is replayed', async () => {
    const driver = await replayIntoDriver([
      goalReplay(
        goalSnapshot({ status: 'blocked' }),
        { kind: 'lifecycle', status: 'blocked', actor: 'model' },
      ),
      message(
        'user',
        [
          {
            type: 'text',
            text: '<system-reminder>\nGoal blocked.\nWorked 1 turn over 7m15s, using 4.3M tokens.\n\nWrite a concise final message for the user.\n</system-reminder>',
          },
        ],
        { origin: { kind: 'system_trigger', name: 'goal_blocked' } },
      ),
      message(
        'assistant',
        [{ type: 'text', text: 'I am blocked because I need credentials.' }],
      ),
    ]);

    expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'goal')).toEqual([]);
    const content = driver.state.transcriptEntries.map((item) => item.content).join('\n');
    expect(content).not.toContain('Goal blocked');
    expect(content).toContain('I am blocked because I need credentials.');
  });

  it('does not replay model-blocked lifecycle markers without a follow-up', async () => {
    const driver = await replayIntoDriver([
      goalReplay(
        goalSnapshot({ status: 'blocked' }),
        { kind: 'lifecycle', status: 'blocked', actor: 'model' },
      ),
    ]);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'goal')
        .map((entry) => entry.content),
    ).toEqual([]);
  });

  it('keeps replayed blocked lifecycle markers when actor is unavailable', async () => {
    const driver = await replayIntoDriver([
      goalReplay(
        goalSnapshot({ status: 'blocked' }),
        { kind: 'lifecycle', status: 'blocked' },
      ),
    ]);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'goal')
        .map((entry) => entry.content),
    ).toEqual(['Goal blocked']);
  });

  it('keeps replayed runtime-blocked lifecycle markers', async () => {
    const driver = await replayIntoDriver([
      goalReplay(
        goalSnapshot({ status: 'blocked' }),
        { kind: 'lifecycle', status: 'blocked', actor: 'runtime' },
      ),
    ]);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'goal')
        .map((entry) => entry.content),
    ).toEqual(['Goal blocked']);
  });

  it('groups replayed Agent calls from one assistant message using live grouping', async () => {
    const replay: AgentReplayRecord[] = [
      message('user', [{ type: 'text', text: 'run two agents' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_agent_1', 'Agent', {
            description: 'Review API',
            subagent_type: 'reviewer',
          }),
          toolCall('call_agent_2', 'Agent', {
            description: 'Review tests',
            subagent_type: 'reviewer',
          }),
        ],
      }),
      message('tool', [{ type: 'text', text: 'agent one done' }], {
        toolCallId: 'call_agent_1',
      }),
      message('tool', [{ type: 'text', text: 'agent two done' }], {
        toolCallId: 'call_agent_2',
      }),
    ];

    const driver = await replayIntoDriver(replay);
    const group = driver.state.transcriptContainer.children.find(
      (child) => child instanceof AgentGroupComponent,
    );

    expect(group).toBeInstanceOf(AgentGroupComponent);
    expect((group as AgentGroupComponent).size()).toBe(2);
    const output = stripAnsi((group as AgentGroupComponent).render(120).join('\n'));
    expect(output).toContain('2 agents finished');
    expect(output).not.toContain('Still working…');
    expect(output).not.toContain('Waiting to start…');
    expect(driver.streamingUI.hasPendingAgentGroup()).toBe(false);
    expect(driver.streamingUI.getToolComponent('call_agent_1')).toBeUndefined();
    expect(driver.streamingUI.getToolComponent('call_agent_2')).toBeUndefined();
  });

  it('groups replayed Read calls from one assistant message using live grouping', async () => {
    const replay: AgentReplayRecord[] = [
      message('user', [{ type: 'text', text: 'read files' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_read_1', 'Read', { file_path: '/tmp/proj-a/src/a.ts' }),
          toolCall('call_read_2', 'Read', { file_path: '/tmp/proj-a/src/b.ts' }),
        ],
      }),
      message('tool', [{ type: 'text', text: 'line a\nline b\n' }], {
        toolCallId: 'call_read_1',
      }),
      message('tool', [{ type: 'text', text: 'line c\n' }], {
        toolCallId: 'call_read_2',
      }),
    ];

    const driver = await replayIntoDriver(replay);
    const group = driver.state.transcriptContainer.children.find(
      (child) => child instanceof ReadGroupComponent,
    );

    expect(group).toBeInstanceOf(ReadGroupComponent);
    expect((group as ReadGroupComponent).size()).toBe(2);
    expect(driver.streamingUI.hasPendingReadGroup()).toBe(false);
    expect(driver.streamingUI.getToolComponent('call_read_1')).toBeUndefined();
    expect(driver.streamingUI.getToolComponent('call_read_2')).toBeUndefined();
  });

  it('renders replayed AgentSwarm calls as compact result summaries', async () => {
    const replay: AgentReplayRecord[] = [
      message('user', [{ type: 'text', text: 'review files with a swarm' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_swarm', 'AgentSwarm', {
            description: 'Review changed files',
            items: ['src/a.ts', 'src/b.ts'],
          }),
        ],
      }),
      message(
        'tool',
        [{
          type: 'text',
          text: [
            '<agent_swarm_result>',
            '<summary>completed: 1, failed: 1</summary>',
            '<subagent index="1" outcome="completed">Reviewed src/a.ts.</subagent>',
            '<subagent index="2" outcome="failed">Agent timed out.</subagent>',
            '</agent_swarm_result>',
          ].join('\n'),
        }],
        { toolCallId: 'call_swarm' },
      ),
    ];

    const driver = await replayIntoDriver(replay);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));

    expect(transcript).toContain('Agent swarm: ✓ 1 completed · ✗ 1 failed');
    expect(transcript).not.toContain('<agent_swarm_result>');
    expect(transcript).not.toContain('Reviewed src/a.ts.');
    expect(transcript).not.toContain('Agent timed out.');
  });

  it('does not show no-index replayed AgentSwarm failures as completed', async () => {
    const replay: AgentReplayRecord[] = [
      message('user', [{ type: 'text', text: 'review files with a swarm' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_swarm', 'AgentSwarm', {
            description: 'Review changed files',
            items: ['src/a.ts', 'src/b.ts'],
          }),
        ],
      }),
      message(
        'tool',
        [{
          type: 'text',
          text: [
            '<agent_swarm_result>',
            '<summary>failed: 1, aborted: 1</summary>',
            '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values ' +
              'in this result to continue unfinished work.</resume_hint>',
            '<subagent agent_id="agent-1" item="src/a.ts" outcome="failed">' +
              'Agent timed out.</subagent>',
            '<subagent agent_id="agent-2" item="src/b.ts" outcome="aborted">' +
              'User interrupted.</subagent>',
            '</agent_swarm_result>',
          ].join('\n'),
        }],
        { toolCallId: 'call_swarm' },
      ),
    ];

    const driver = await replayIntoDriver(replay);
    const transcript = stripAnsi(driver.state.transcriptContainer.render(140).join('\n'));

    expect(transcript).toContain('Agent swarm: ✗ 1 failed · ⊘ 1 aborted');
    expect(transcript).not.toContain('Agent swarm: ✓ Completed.');
    expect(transcript).not.toContain('<agent_swarm_result>');
  });

  it('hydrates todo and background snapshot state from resumed main agent', async () => {
    const driver = await replayIntoDriver([], {
      toolStore: {
        todo: [
          { title: 'Review resume snapshot', status: 'done' },
          { title: 'Render replay transcript', status: 'in_progress' },
          { title: '', status: 'pending' },
        ],
      },
      background: [
        backgroundTask('agent-bg1', 'Review long-running work', 'running'),
        backgroundTask('bash-bg1', 'Build package', 'completed'),
      ],
    });

    expect(driver.state.todoPanel.getTodos()).toEqual([
      { title: 'Review resume snapshot', status: 'done' },
      { title: 'Render replay transcript', status: 'in_progress' },
    ]);
    expect(driver.sessionEventHandler.backgroundTasks.has('agent-bg1')).toBe(true);
    expect(driver.sessionEventHandler.backgroundTasks.has('bash-bg1')).toBe(true);
    expect(driver.sessionEventHandler.backgroundTaskTranscriptedTerminal.has('bash-bg1')).toBe(true);
  });

  it('matches completed resumed background agents by agent id when task id differs', async () => {
    const driver = await replayIntoDriver([], {
      background: [
        {
          taskId: 'task-bg1',
          kind: 'agent',
          agentId: 'agent-bg1',
          subagentType: 'coder',
          description: 'Review long-running work',
          status: 'running',
          startedAt: 1,
          endedAt: null,
        },
      ],
    });

    expect(
      driver.sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata.has('agent-bg1'),
    ).toBe(true);
    expect(
      driver.sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata.has('task-bg1'),
    ).toBe(false);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.completed',
        agentId: 'main',
        sessionId: 'ses-replay',
        subagentId: 'agent-bg1',
        resultSummary: 'Reviewed the long-running work.',
      },
      () => {},
    );

    const status = driver.state.transcriptEntries.find(
      (entry) => entry.backgroundAgentStatus?.phase === 'completed',
    );

    expect(
      driver.sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata.has('agent-bg1'),
    ).toBe(false);
    expect(status?.backgroundAgentStatus?.headline).toBe('agent completed in background');
    expect(status?.backgroundAgentStatus?.detail).toContain('Review long-running work');
  });

  it('keeps timed-out status when an aborted resumed background agent later fails', async () => {
    const info: BackgroundTaskInfo = {
      taskId: 'task-bg-timeout',
      kind: 'agent',
      agentId: 'agent-bg-timeout',
      subagentType: 'coder',
      description: 'Review timeout handling',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      timeoutMs: 1000,
    };
    const driver = await replayIntoDriver([], { background: [info] });
    const applyTerminalStatus = vi
      .spyOn(driver.streamingUI, 'applyBackgroundTaskTerminalStatus')
      .mockReturnValue(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'background.task.terminated',
        agentId: 'main',
        sessionId: 'ses-replay',
        info: { ...info, status: 'timed_out', endedAt: 2 },
      },
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 'ses-replay',
        subagentId: 'agent-bg-timeout',
        error: 'The subagent was aborted.',
      },
      () => {},
    );

    expect(applyTerminalStatus.mock.calls.map(([args]) => args.status)).toEqual(['timed_out']);
    expect(
      driver.sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata.has(
        'agent-bg-timeout',
      ),
    ).toBe(false);
    expect(driver.sessionEventHandler.backgroundTaskTranscriptedTerminal.has('task-bg-timeout'))
      .toBe(true);
    expect(
      driver.state.transcriptEntries.some(
        (entry) => entry.backgroundAgentStatus?.phase === 'failed',
      ),
    ).toBe(false);
  });

  it('renders replayed bash background notifications as bash tasks', async () => {
    const driver = await replayIntoDriver(
      [
        message('user', [{ type: 'text', text: 'Background task lost.' }], {
          origin: {
            kind: 'background_task',
            taskId: 'bash-lost0000',
            status: 'lost',
            notificationId: 'task:bash-lost0000:lost',
          },
        }),
      ],
      {
        background: [backgroundTask('bash-lost0000', 'Background timestamp logger', 'lost')],
      },
    );

    const status = driver.state.transcriptEntries.find(
      (entry) => entry.backgroundAgentStatus !== undefined,
    );

    expect(status?.backgroundAgentStatus?.headline).toBe('bash task lost');
    expect(status?.backgroundAgentStatus?.detail).toContain('Background timestamp logger');
    expect(status?.backgroundAgentStatus?.headline).not.toContain('agent');
  });

  it('renders only the most recent ten visible user turns', async () => {
    const replay = Array.from({ length: 12 }, (_, index) => [
      message('user', [{ type: 'text', text: `prompt ${index}` }]),
      message('assistant', [{ type: 'text', text: `answer ${index}` }]),
    ]).flat();

    const driver = await replayIntoDriver(replay);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual([
      'prompt 2',
      'prompt 3',
      'prompt 4',
      'prompt 5',
      'prompt 6',
      'prompt 7',
      'prompt 8',
      'prompt 9',
      'prompt 10',
      'prompt 11',
    ]);
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'assistant')
        .map((entry) => entry.content),
    ).toEqual([
      'answer 2',
      'answer 3',
      'answer 4',
      'answer 5',
      'answer 6',
      'answer 7',
      'answer 8',
      'answer 9',
      'answer 10',
      'answer 11',
    ]);
  });

  it('renders cron_job origin records during replay without exposing raw XML', async () => {
    const cronFire =
      '<cron-fire jobId="job-1" cron="*/5 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\nrun nightly\n</prompt>\n</cron-fire>';
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'real prompt' }]),
      message('assistant', [{ type: 'text', text: 'real answer' }]),
      message('user', [{ type: 'text', text: cronFire }], {
        origin: {
          kind: 'cron_job',
          jobId: 'job-1',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      }),
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');
    expect(transcript).not.toContain('<cron-fire');
    expect(transcript).toContain('Scheduled reminder fired');
    expect(transcript).toContain('run nightly');
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual(['real prompt']);
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'cron')
        .map((entry) => entry.content),
    ).toEqual(['run nightly']);
  });

  it('renders cron_missed origin records during replay without exposing raw XML', async () => {
    const cronMissed =
      '<cron-fire jobId="job-2" missed="true" count="3">\n3 one-shot tasks missed while offline\n</cron-fire>';
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'real prompt' }]),
      message('assistant', [{ type: 'text', text: 'real answer' }]),
      message('user', [{ type: 'text', text: cronMissed }], {
        origin: { kind: 'cron_missed', count: 3 },
      }),
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');
    expect(transcript).not.toContain('<cron-fire');
    expect(transcript).toContain('Missed scheduled reminders');
    expect(transcript).toContain('3 one-shot tasks missed while offline');
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual(['real prompt']);
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'cron')
        .map((entry) => entry.content),
    ).toEqual(['3 one-shot tasks missed while offline']);
  });

  it('renders user-slash skill activation once without exposing injected prompt text', async () => {
    const activation = message(
      'user',
      [{ type: 'text', text: 'Review the requested file.\n\nUser request:\nsrc/app.ts' }],
      {
        origin: {
          kind: 'skill_activation',
          activationId: 'act-review',
          skillName: 'review',
          skillArgs: 'src/app.ts',
          trigger: 'user-slash',
        },
      },
    );

    const driver = await replayIntoDriver([activation, activation]);
    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('review');
    expect(transcript).toContain('src/app.ts');
    expect(transcript).not.toContain('Review the requested file');
    expect(driver.sessionEventHandler.renderedSkillActivationIds.has('act-review')).toBe(true);
  });

  it('renders replayed hook results as assistant transcript entries', async () => {
    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n' +
      '<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'prompt' }]),
      message('user', [{ type: 'text', text: hookResult }], {
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      }),
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('UserPromptSubmit hook');
    expect(transcript).toContain('hook response 1');
    expect(transcript).toContain('hook response 2');
  });

  it('renders replayed compaction records as completed compaction blocks', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'prompt before compaction' }]),
      {
        time: REPLAY_TIME,
        type: 'compaction',
        result: {
          summary: 'Compacted transcript summary.',
          compactedCount: 4,
          tokensBefore: 120,
          tokensAfter: 24,
        },
        instruction: 'preserve implementation notes',
      },
      message('user', [{ type: 'text', text: 'prompt after compaction' }]),
    ]);

    const compactionEntry = driver.state.transcriptEntries.find(
      (entry) => entry.compactionData !== undefined,
    );
    expect(compactionEntry?.compactionData).toEqual({
      summary: 'Compacted transcript summary.',
      tokensBefore: 120,
      tokensAfter: 24,
      instruction: 'preserve implementation notes',
    });
    const collapsed = stripAnsi(driver.state.transcriptContainer.render(120).join('\n'));
    expect(collapsed).toContain('Compaction complete');
    expect(collapsed).toContain('120 → 24 tokens');
    expect(collapsed).toContain('preserve implementation notes');
    expect(collapsed).not.toContain('Compacted transcript summary.');

    driver.state.editor.onToggleToolExpand?.();
    const expanded = stripAnsi(driver.state.transcriptContainer.render(120).join('\n'));
    expect(expanded).toContain('Compacted transcript summary.');
  });

  it('initializes replayed compaction blocks as expanded when tool output is already expanded', async () => {
    const initial = makeSession([]);
    const resumed = makeSession([
      {
        time: REPLAY_TIME,
        type: 'compaction',
        result: {
          summary: 'Compacted transcript summary.',
          compactedCount: 4,
          tokensBefore: 120,
          tokensAfter: 24,
        },
      },
    ]);
    const driver = await makeDriver(initial);
    driver.state.toolOutputExpanded = true;
    await driver.switchToSession(resumed, 'Resumed session (ses-replay).');

    const transcript = stripAnsi(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('Compaction complete');
    expect(transcript).toContain('Compacted transcript summary.');
  });

  it('renders replayed cancelled compaction records as cancelled compaction blocks', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'prompt before cancellation' }]),
      {
        time: REPLAY_TIME,
        type: 'compaction',
        result: 'cancelled',
        instruction: 'preserve implementation notes',
      },
      message('user', [{ type: 'text', text: 'prompt after cancellation' }]),
    ]);

    const compactionEntry = driver.state.transcriptEntries.find(
      (entry) => entry.compactionData !== undefined,
    );
    expect(compactionEntry?.compactionData).toEqual({
      result: 'cancelled',
      instruction: 'preserve implementation notes',
    });
    const transcript = stripAnsi(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('Compaction cancelled');
    expect(transcript).toContain('preserve implementation notes');
    expect(transcript).not.toContain('Compaction complete');
  });

  it('renders plan permission and approval replay notices', async () => {
    const driver = await replayIntoDriver([
      { time: REPLAY_TIME, type: 'plan_updated', enabled: true },
      { time: REPLAY_TIME, type: 'permission_updated', mode: 'auto' },
      { time: REPLAY_TIME, type: 'permission_updated', mode: 'yolo' },
      { time: REPLAY_TIME, type: 'permission_updated', mode: 'manual' },
      {
        time: REPLAY_TIME,
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_bash',
          action: 'run command',
          toolName: 'Bash',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
      },
      { time: REPLAY_TIME, type: 'plan_updated', enabled: false },
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('Plan mode: ON');
    expect(transcript).toContain('Permission mode: auto');
    expect(transcript).toContain('YOLO mode: ON');
    expect(transcript).toContain('YOLO mode: OFF');
    expect(transcript).toContain('Approved for session: run command');
    expect(transcript).toContain('Plan mode: OFF');
  });

  it('keeps only the final approved plan card after rejected plan reviews', async () => {
    const driver = await replayIntoDriver([
      message('assistant', [], {
        toolCalls: [toolCall('call_exit_reject', 'ExitPlanMode', {})],
      }),
      {
        time: REPLAY_TIME,
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_exit_reject',
          action: 'Review plan',
          toolName: 'ExitPlanMode',
          result: { decision: 'rejected', selectedLabel: 'Reject' },
        },
      },
      message('tool', [{ type: 'text', text: 'Plan rejected by user. Plan mode remains active.' }], {
        toolCallId: 'call_exit_reject',
        isError: true,
      }),
      message('assistant', [], {
        toolCalls: [toolCall('call_exit_final', 'ExitPlanMode', {})],
      }),
      {
        time: REPLAY_TIME,
        type: 'approval_result',
        record: {
          turnId: 1,
          toolCallId: 'call_exit_final',
          action: 'Review plan',
          toolName: 'ExitPlanMode',
          result: { decision: 'approved', selectedLabel: 'Approve' },
        },
      },
      message(
        'tool',
        [
          {
            type: 'text',
            text:
              'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
              'Plan saved to: /tmp/plans/final-plan.md\n\n' +
              '## Approved Plan:\n# Final Plan\n\n- replay final approved plan',
          },
        ],
        { toolCallId: 'call_exit_final' },
      ),
      { time: REPLAY_TIME, type: 'plan_updated', enabled: false },
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('Plan review rejected');
    expect(transcript).toContain('Final Plan');
    expect(transcript).toContain('replay final approved plan');
    expect(transcript).not.toContain('Plan rejected by user.');
    expect(transcript).not.toContain('Plan mode: OFF');
  });
});
