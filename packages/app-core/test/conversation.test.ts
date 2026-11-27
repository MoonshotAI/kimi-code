import { describe, expect, it } from 'vitest';
import {
  conversationTurnError,
  createConversationProjector,
  conversationToTurns,
  pendingPromptTurn,
  sessionPlansOf,
  type ChatTurn,
} from '../src/client';
import {
  applyConversationFrame,
  EMPTY_CONVERSATION,
  mergeLatestPage,
  prependOlderPage,
  type AssistantMessageItem,
  type ConversationItem,
  type ConversationTurn,
  type ConversationTurnHeader,
  type ConversationView,
  type NotificationItem,
  type PlanReviewDisplay,
  type ToolCallItem,
  type UserMessageItem,
} from '../src/conversation';

const AT = '2026-01-01T00:00:00.000Z';

const header = (ordinal: number, extra: Partial<ConversationTurnHeader> = {}): ConversationTurnHeader => ({
  turn_id: `t${ordinal}`,
  ordinal,
  turn_number: ordinal + 1,
  kind: 'agent',
  status: 'ended',
  outcome: 'completed',
  started_at: AT,
  steps: [],
  ...extra,
});

const running = { status: 'running', outcome: undefined } as const;

const turn = (ordinal: number, items: ConversationItem[], extra: Partial<ConversationTurnHeader> = {}): ConversationTurn => ({
  ...header(ordinal, extra),
  items,
});

const opener = (id: string, text: string, extra: Partial<UserMessageItem> = {}): UserMessageItem => ({
  type: 'user_message',
  item_id: id,
  status: 'ended',
  outcome: 'completed',
  created_at: AT,
  prompt_ids: [id],
  placement: 'opener',
  origin: { kind: 'user' },
  text,
  attachments: [],
  skills: [],
  ...extra,
});

const answer = (id: string, text: string, status: 'running' | 'ended' = 'ended'): AssistantMessageItem => ({
  type: 'assistant_message',
  item_id: id,
  status,
  outcome: status === 'ended' ? 'completed' : undefined,
  step_index: 1,
  created_at: AT,
  text,
});

const tool = (id: string, extra: Partial<ToolCallItem> = {}): ToolCallItem => ({
  type: 'tool_call',
  item_id: id,
  status: 'ended',
  outcome: 'completed',
  step_index: 1,
  created_at: AT,
  started_at: AT,
  name: 'Bash',
  input: { command: 'pnpm build' },
  output: 'ok',
  ...extra,
});

const project = (turns: ConversationTurn[]): ChatTurn[] =>
  conversationToTurns(turns, {
    sessionId: 'session-1',
    getFileUrl: (id) => `/files/${id}`,
    getSessionMediaUrl: (sid, id) => `/sessions/${sid}/media/${id}`,
  });

const toolsOf = (turns: ChatTurn[]) => turns.flatMap((chatTurn) => chatTurn.tools ?? []);

describe('chat MCP authorization', () => {
  const request = { serverName: 'example', waitId: 'wait-1', authorizationUrl: 'https://example.test/authorize?state=test', expiresAt: 2_000_000_000_000 };
  const display = { kind: 'generic', summary: 'Authenticate example', detail: { kind: 'mcp_oauth', serverName: 'example' } };
  const call = tool('auth-1', { ...running, name: 'mcp__example__authenticate', input: {}, output: undefined, stage: 'executing', display });
  const start: ConversationView = { turns: [turn(0, [opener('p0', 'use example'), call], running)], hasMore: false };
  const fields = { 'mcp.oauth.authorization_url': request };

  it('exposes the action before output arrives and drops it when the tool ends', () => {
    const waiting = applyConversationFrame(start, { type: 'item.updated', turn_id: 't0', item_id: 'auth-1', set: { fields } });
    expect(toolsOf(project(waiting.turns.slice()))[0]?.mcpAuth).toMatchObject({ phase: 'waiting', request });
    const ended = applyConversationFrame(waiting, { type: 'item.ended', turn_id: 't0', item: { ...call, status: 'ended', outcome: 'completed' } });
    expect(toolsOf(project(ended.turns.slice()))[0]?.mcpAuth).toEqual({ phase: 'connected', serverName: 'example' });
  });

  it.each(['file:///tmp/auth', 'http://example.test/authorize', 'https://user:pass@example.test', 'javascript:void(0)'])('rejects an unsafe authorization URL: %s', (authorizationUrl) => {
    const item = { ...call, fields: { 'mcp.oauth.authorization_url': { ...request, authorizationUrl } } };
    expect(toolsOf(project([turn(0, [item], running)]))[0]?.mcpAuth).toEqual({ serverName: 'example', phase: 'unavailable' });
  });

  it('does not turn tool names, output or model arguments into an authorization action', () => {
    const untrusted = { ...call, fields, display: undefined, input: display, output: request.authorizationUrl };
    expect(toolsOf(project([turn(0, [untrusted], running)]))[0]?.mcpAuth).toBeUndefined();
  });
});

describe('conversation reducer', () => {
  it('applies turn and item frames while keeping untouched turns by identity', () => {
    const first = turn(0, [opener('p0', 'hello'), answer('s0:0', 'hi')]);
    let view: ConversationView = { turns: [first], hasMore: false };
    view = applyConversationFrame(view, { type: 'turn.started', turn: header(1, running) });
    view = applyConversationFrame(view, { type: 'item.ended', turn_id: 't1', item: opener('p1', 'next') });
    view = applyConversationFrame(view, { type: 'item.started', turn_id: 't1', item: answer('a1', 'Hel', 'running') });
    view = applyConversationFrame(view, { type: 'item.delta', turn_id: 't1', item_id: 'a1', field: 'text', delta: 'lo' });

    expect(view.turns[0]).toBe(first);
    expect(view.turns[1]?.items.at(-1)).toMatchObject({ text: 'Hello', status: 'running' });

    view = applyConversationFrame(view, { type: 'item.ended', turn_id: 't1', item: answer('a1', 'Hello!') });
    view = applyConversationFrame(view, { type: 'turn.ended', turn: header(1) });
    expect(view.turns[1]).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(view.turns[1]?.items.map((item) => item.item_id)).toEqual(['p1', 'a1']);
    expect(view.turns[1]?.items[1]).toMatchObject({ text: 'Hello!', status: 'ended' });

    view = applyConversationFrame({ ...view, hasMore: true }, { type: 'turns.removed', turn_ids: ['t1'] });
    expect(view).toEqual({ turns: [first], hasMore: true });
  });

  it('shallow-merges item.updated and appends item.delta to the field it names', () => {
    let view: ConversationView = { turns: [turn(0, [opener('p0', 'build it')], running)], hasMore: false };
    view = applyConversationFrame(view, {
      type: 'item.started',
      turn_id: 't0',
      item: tool('call-1', { status: 'running', outcome: undefined, stage: 'input', input: undefined, output: undefined }),
    });
    view = applyConversationFrame(view, { type: 'item.delta', turn_id: 't0', item_id: 'call-1', field: 'input_text', delta: '{"command":' });
    view = applyConversationFrame(view, { type: 'item.delta', turn_id: 't0', item_id: 'call-1', field: 'input_text', delta: '"pnpm build"}' });
    view = applyConversationFrame(view, {
      type: 'item.updated',
      turn_id: 't0',
      item_id: 'call-1',
      set: { stage: 'executing', input: { command: 'pnpm build' } },
    });
    view = applyConversationFrame(view, { type: 'item.delta', turn_id: 't0', item_id: 'call-1', field: 'output', delta: 'compiling\n' });
    view = applyConversationFrame(view, { type: 'item.delta', turn_id: 't0', item_id: 'call-1', field: 'output', delta: 'linking\n' });
    view = applyConversationFrame(view, {
      type: 'item.updated',
      turn_id: 't0',
      item_id: 'call-1',
      set: { progress: { percent: 50, status: 'halfway' } },
    });

    expect(view.turns[0]?.items[1]).toMatchObject({
      status: 'running',
      stage: 'executing',
      name: 'Bash',
      input_text: '{"command":"pnpm build"}',
      input: { command: 'pnpm build' },
      output: 'compiling\nlinking\n',
      progress: { percent: 50, status: 'halfway' },
    });

    view = applyConversationFrame(view, { type: 'item.ended', turn_id: 't0', item: tool('call-1', { output: 'built' }) });
    expect(view.turns[0]?.items[1]).toEqual(tool('call-1', { output: 'built' }));
  });

  it('keeps the local turns older than a latest page whose first turn it already has', () => {
    const local: ConversationView = { turns: [turn(0, []), turn(1, []), turn(2, []), turn(3, [])], hasMore: true };
    const page = { turns: [turn(2, [answer('x', 'fresh')]), turn(4, [])], has_more: true };

    const merged = mergeLatestPage(local, page);

    expect(merged.turns.map((value) => value.turn_id)).toEqual(['t0', 't1', 't2', 't4']);
    expect(merged.turns[0]).toBe(local.turns[0]);
    expect(merged.turns[2]).toBe(page.turns[0]);
    expect(merged.hasMore).toBe(true);
    expect(mergeLatestPage({ ...local, hasMore: false }, page).hasMore).toBe(false);
  });

  it('puts an older page in front of the loaded turns', () => {
    const view = prependOlderPage(
      { turns: [turn(2, []), turn(3, [])], hasMore: true },
      { turns: [turn(0, []), turn(1, [])], has_more: false },
    );
    expect(view.turns.map((value) => value.turn_id)).toEqual(['t0', 't1', 't2', 't3']);
    expect(view.hasMore).toBe(false);
    expect(prependOlderPage(EMPTY_CONVERSATION, { turns: [turn(0, [])], has_more: true }).hasMore).toBe(true);
  });
});

describe('conversation turn state', () => {
  it('reports the failure of an ended turn with its end reason', () => {
    const failed = turn(0, [], {
      outcome: 'failed',
      end_reason: 'max_steps',
      error: { code: 'loop.max_steps_exceeded', message: 'step limit', status_code: 400, request_id: 'req-1' },
    });
    expect(conversationTurnError(failed)).toEqual({
      code: 'loop.max_steps_exceeded',
      message: 'step limit',
      name: undefined,
      retryable: undefined,
      statusCode: 400,
      requestId: 'req-1',
      endReason: 'max_steps',
    });
    expect(conversationTurnError(turn(0, [], { outcome: 'interrupted', end_reason: 'user_cancelled' }))).toBeUndefined();
  });
});

describe('conversationToTurns', () => {
  it('describes a ReadMediaFile image with its path, size and dimensions', () => {
    const media = { kind: 'image' as const, file_id: 'f_1', media_type: 'image/png' };
    const [read, other] = toolsOf(project([
      turn(0, [
        opener('p0', 'Look at the screenshot'),
        tool('read-1', {
          name: 'ReadMediaFile',
          input: { path: '/tmp/shot.png' },
          output: '<image path="/tmp/shot.png"></image>',
          note: 'Read image file. Mime type: image/png. Size: 123456 bytes. Original dimensions: 1920x1080 pixels.',
          media: [media],
        }),
        tool('mcp-1', { name: 'mcp__screenshots__take', output: 'Size: 99 bytes', media: [media] }),
      ]),
    ]));

    expect(read?.media).toEqual(expect.objectContaining({
      kind: 'image',
      url: '/sessions/session-1/media/f_1',
      path: '/tmp/shot.png',
      mimeType: 'image/png',
      bytes: 123456,
      dimensions: '1920x1080',
    }));
    expect(other?.media).toEqual({
      kind: 'image',
      url: '/sessions/session-1/media/f_1',
      mimeType: 'image/png',
      fileId: 'f_1',
      sessionId: 'session-1',
    });
  });

  it('projects openers, reasoning, tools and answers with the engine turn number', () => {
    const turns = project([
      turn(0, [
        opener('p0', 'Check the build'),
        { type: 'reasoning', item_id: 'r0', status: 'ended', outcome: 'completed', step_index: 1, created_at: AT, started_at: AT, text: 'thinking' },
        tool('call-1', { agent_refs: [{ agent_id: 'sub-1', role: 'member', swarm_index: 0 }] }),
        answer('a0', 'Build passed'),
      ], { turn_number: 7 }),
    ]);

    expect(turns.map((value) => value.role)).toEqual(['user', 'assistant']);
    expect(turns[0]).toMatchObject({ id: 'p0', text: 'Check the build', promptIds: ['p0'] });
    expect(turns[1]).toMatchObject({ daemonTurnId: 7, forkTurnIndex: 7, daemonTurnState: 'completed', thinking: 'thinking', sourceTurnId: 't0' });
    expect(turns[1]?.tools).toEqual([expect.objectContaining({ id: 'call-1', name: 'Bash', status: 'ok', output: ['ok'] })]);
  });

  it('shows a failed tool as an error with its error text and an interrupted one as cancelled', () => {
    const tools = toolsOf(project([
      turn(0, [
        opener('p0', 'run them'),
        tool('ok-1'),
        tool('failed-1', { outcome: 'failed', output: undefined, error: 'exit code 2' }),
        tool('stopped-1', { outcome: 'interrupted', output: undefined, error: 'partial line\nInterrupted by user' }),
        tool('stopped-2', { outcome: 'interrupted', output: 'streamed line' }),
      ], { outcome: 'interrupted', end_reason: 'user_cancelled' }),
    ]));

    expect(tools.map((value) => [value.id, value.status, value.output, value.resultText])).toEqual([
      ['ok-1', 'ok', ['ok'], 'ok'],
      ['failed-1', 'error', ['exit code 2'], 'exit code 2'],
      ['stopped-1', 'cancelled', ['partial line', 'Interrupted by user'], 'partial line\nInterrupted by user'],
      ['stopped-2', 'cancelled', ['streamed line'], 'streamed line'],
    ]);
  });

  it('hides an AgentSwarm call rejected before any subagent starts', () => {
    const rejected = tool('swarm-rejected', {
      name: 'AgentSwarm',
      outcome: 'failed',
      output: undefined,
      error: 'Swarm mode is off, so AgentSwarm did not run and no subagents were started.',
    });
    const turns = project([
      turn(0, [opener('p0', 'delegate'), answer('a0', 'Trying swarm'), rejected, answer('a1', 'Swarm mode is off.')]),
    ]);

    const assistant = turns.find((value) => value.role === 'assistant');
    expect(assistant?.tools).toBeUndefined();
    expect(assistant?.blocks?.some((block) => block.kind === 'tool')).toBe(false);
    expect(assistant?.text).toBe('Trying swarm\nSwarm mode is off.');
  });

  it('hides a running AgentSwarm call only while swarm mode is off', () => {
    const swarm = tool('swarm-running', { ...running, name: 'AgentSwarm', output: undefined });
    const input = [turn(0, [opener('p0', 'delegate'), swarm], running)];
    const off = conversationToTurns(input, { sessionId: 'session-1', swarmMode: false });
    const on = conversationToTurns(input, { sessionId: 'session-1', swarmMode: true });

    expect(toolsOf(off)).toEqual([]);
    expect(toolsOf(on)).toEqual([expect.objectContaining({ id: 'swarm-running', name: 'AgentSwarm', status: 'running' })]);
  });

  it('keeps AgentSwarm calls with subagents and cancellations', () => {
    const started = tool('swarm-started', {
      name: 'AgentSwarm',
      outcome: 'failed',
      output: undefined,
      error: 'Unexpected failure',
      agent_refs: [{ agent_id: 'agent-1', role: 'member', swarm_index: 0 }],
    });
    const cancelled = tool('swarm-cancelled', {
      name: 'AgentSwarm',
      outcome: 'interrupted',
      output: undefined,
      error: 'Interrupted by user',
    });

    expect(toolsOf(project([turn(0, [opener('p0', 'delegate'), started, cancelled])]))).toEqual([
      expect.objectContaining({ id: 'swarm-started', status: 'error' }),
      expect.objectContaining({ id: 'swarm-cancelled', status: 'cancelled' }),
    ]);
  });

  it('reads an ExitPlanMode plan and its review from display.plan_review', () => {
    const planReview = (review: PlanReviewDisplay['review']): PlanReviewDisplay => ({
      kind: 'plan_review',
      plan: '# Plan',
      path: '/tmp/plan.md',
      options: [{ label: 'A', description: 'Small change' }],
      review,
    });
    const turns = [
      turn(0, [
        opener('p0', 'plan it'),
        tool('plan-1', { name: 'ExitPlanMode', display: planReview({ state: 'rejected', feedback: 'Too broad' }) }),
        tool('plan-2', { name: 'ExitPlanMode', display: planReview({ state: 'cancelled' }) }),
        tool('plan-3', { name: 'ExitPlanMode', display: planReview({ state: 'approved', selected_option: 'A', feedback: 'Go' }) }),
        tool('plan-4', { ...running, name: 'ExitPlanMode', stage: 'awaiting_approval', interaction_id: 'i-4', display: planReview({ state: 'pending' }) }),
        tool('plan-5', { name: 'ExitPlanMode', output: 'Plan saved to: /tmp/fallback.md' }),
      ], running),
    ];

    expect(toolsOf(project(turns)).map((value) => [value.planPath, value.plan?.review])).toEqual([
      ['/tmp/plan.md', { state: 'rejected', selectedOption: undefined, feedback: 'Too broad' }],
      ['/tmp/plan.md', { state: 'cancelled', selectedOption: undefined, feedback: undefined }],
      ['/tmp/plan.md', { state: 'approved', selectedOption: 'A', feedback: 'Go' }],
      ['/tmp/plan.md', { state: 'pending', selectedOption: undefined, feedback: undefined }],
      ['/tmp/fallback.md', undefined],
    ]);
    expect(Object.keys(sessionPlansOf(turns))).toEqual(['plan-1', 'plan-2', 'plan-3', 'plan-4']);
    expect(sessionPlansOf(turns)['plan-1']).toEqual({
      toolCallId: 'plan-1',
      plan: '# Plan',
      path: '/tmp/plan.md',
      review: { state: 'rejected', selectedOption: undefined, feedback: 'Too broad' },
    });
  });

  it('projects user message text, attachments, skills and client metadata', () => {
    const composer = { kimi_code_composer: { version: 1 } };
    const [user] = project([
      turn(0, [
        opener('p0', 'compare [notes](kimi-code-composer://attachments/1) with this', {
          attachments: [
            { kind: 'file', file_id: 'f_doc', name: 'notes.md', media_type: 'text/markdown', ordinal: 1 },
            { kind: 'image', file_id: 'f_img', name: 'shot.png', media_type: 'image/png', ordinal: 2 },
            { kind: 'image', url: 'data:image/png;base64,AAAA', ordinal: 3 },
            { kind: 'video', file_id: 'f_vid', name: 'clip.mp4', ordinal: 4 },
          ],
          skills: [{ name: 'review', path: '/work/B/review/SKILL.md', args: 'src' }],
          metadata: composer,
        }),
      ]),
    ]);

    expect(user).toMatchObject({
      role: 'user',
      text: 'compare [notes](kimi-code-composer://attachments/1) with this',
      skillActivations: [{ name: 'review', path: '/work/B/review/SKILL.md', args: 'src' }],
      clientMetadata: [composer],
    });
    expect(user?.attachments?.map((value) => [value.kind, value.url])).toEqual([
      ['image', '/sessions/session-1/media/f_img'],
      ['image', 'data:image/png;base64,AAAA'],
      ['video', '/sessions/session-1/media/f_vid'],
    ]);
    expect(user?.inlineAttachments?.find((value) => value.kind === 'file')).toMatchObject({
      fileId: 'f_doc',
      name: 'notes.md',
      url: '/files/f_doc',
    });
  });

  it('projects each input origin to the user bubble, chip, card or row it uses', () => {
    const turns = project([
      turn(0, [opener('p0', '', { origin: { kind: 'skill', name: 'review', path: '/work/B/review/SKILL.md', args: 'src/api' } })]),
      turn(1, [opener('p1', 'expanded command', { origin: { kind: 'plugin_command', plugin_id: 'gh', command: 'pr', args: '42' } })]),
      turn(2, [opener('p2', 'run the nightly report', {
        prompt_ids: [],
        origin: { kind: 'cron', job_id: 'job-1', schedule: '0 9 * * *', recurring: true, coalesced_count: 2, stale: false },
      })]),
      turn(3, [opener('p3', '', { prompt_ids: [], origin: { kind: 'goal' } }), answer('a3', 'continuing the goal')]),
    ]);

    expect(turns.map((value) => value.role)).toEqual(['user', 'user', 'cron', 'goal', 'assistant']);
    expect(turns[0]).toMatchObject({ skillActivation: { name: 'review', path: '/work/B/review/SKILL.md', args: 'src/api' }, text: 'src/api' });
    expect(turns[1]).toMatchObject({ pluginCommand: { pluginId: 'gh', commandName: 'pr', args: '42' } });
    expect(turns[2]).toMatchObject({
      text: 'run the nightly report',
      cron: { jobId: 'job-1', cron: '0 9 * * *', recurring: true, coalescedCount: 2, stale: false },
    });
    expect(turns[4]).toMatchObject({ text: 'continuing the goal', goalContinuation: true });
  });

  it('shows a cron prompt verbatim, including prompt tags of its own', () => {
    const text = 'Summarize this block:\n<prompt>\ndraft\n</prompt>';
    const turns = project([
      turn(0, [opener('p0', text, {
        prompt_ids: [],
        origin: { kind: 'cron', job_id: 'job-1', schedule: '0 9 * * *', recurring: true, coalesced_count: 1, stale: false },
      })]),
    ]);

    expect(turns[0]).toMatchObject({ role: 'cron', text });
  });

  it('hides hook, retry and empty system inputs and shows a system input with text that cannot be undone', () => {
    const turns = project([
      turn(0, [opener('p0', 'mine'), answer('a0', 'first')]),
      turn(1, [opener('h1', '', { prompt_ids: [], origin: { kind: 'hook', hook_event: 'SessionStart' } }), answer('a1', 'after hook')]),
      turn(2, [opener('r2', '', { prompt_ids: [], origin: { kind: 'retry' } }), answer('a2', 'after retry')]),
      turn(3, [opener('s3', '', { prompt_ids: [], origin: { kind: 'system' } }), answer('a3', 'after system')]),
      turn(4, [opener('s4', 'Investigate the bug', { prompt_ids: [], origin: { kind: 'system' } })]),
    ]);

    const users = turns.filter((value) => value.role === 'user');
    expect(users.map((value) => [value.text, value.undoTurnId])).toEqual([
      ['mine', 't0'],
      ['Investigate the bug', undefined],
    ]);
    expect(turns.filter((value) => value.role === 'assistant').map((value) => value.text)).toEqual([
      'first',
      'after hook',
      'after retry',
      'after system',
    ]);
  });

  it('renders notification items from their structured fields', () => {
    const notification = (extra: Partial<NotificationItem>): NotificationItem => ({
      type: 'notification',
      item_id: 'n1',
      status: 'ended',
      outcome: 'completed',
      created_at: AT,
      notification_id: 'task:bash-1:failed',
      title: 'pnpm build',
      body: 'Background process failed with exit code 1.',
      severity: 'error',
      notification_type: 'task.failed',
      source: { kind: 'background_task', id: 'bash-1' },
      task_id: 'bash-1',
      ...extra,
    });
    const blocks = project([
      turn(0, [
        notification({ output: { preview: 'error TS2304', bytes: 4096, truncated: true } }),
        notification({ item_id: 'n2', notification_id: 'task:agent-1:completed', notification_type: 'task.completed', source: { kind: 'subagent', id: 'agent-task-1' }, agent_id: 'agent-1', output: { file: '/tmp/out.log', bytes: 12 } }),
        notification({
          item_id: 'n3',
          notification_id: 'task:question-1:completed',
          notification_type: 'task.completed',
          title: 'Background question answered',
          body: 'The user answered "Proceed?".',
          source: { kind: 'background_task', id: 'question-1' },
          answer: { answers: { 'Proceed?': 'Yes' }, note: 'ship it' },
        }),
      ], { kind: 'agent' }),
    ]).flatMap((value) => value.blocks ?? []);

    const notifications = blocks.flatMap((block) => (block.kind === 'notification' ? [block.notification] : []));
    expect(notifications[0]).toMatchObject({
      id: 'task:bash-1:failed',
      type: 'task.failed',
      sourceKind: 'background_task',
      sourceId: 'bash-1',
      title: 'pnpm build',
      severity: 'error',
      body: 'Background process failed with exit code 1.',
      outputPreview: { text: 'error TS2304', bytes: 4096, truncated: true },
      createdAt: AT,
    });
    expect(notifications[0]?.questionAnswer).toBeUndefined();
    expect(notifications[1]).toMatchObject({ agentId: 'agent-1', sourceKind: 'subagent', outputFile: { path: '/tmp/out.log', bytes: 12 } });
    expect(notifications[2]?.questionAnswer).toEqual({ answers: { 'Proceed?': 'Yes' }, note: 'ship it' });
  });

  it('renders a compaction as a divider', () => {
    const turns = project([
      turn(0, [opener('p0', 'hi'), answer('a0', 'hello')]),
      turn(1, [{
        type: 'system',
        kind: 'compaction',
        item_id: 'c1',
        status: 'ended',
        outcome: 'completed',
        created_at: AT,
        trigger: 'manual',
        summary: 'Summary',
        tokens_before: 100,
        tokens_after: 10,
      }], { kind: 'system', turn_number: undefined }),
    ]);

    expect(turns.at(-1)).toEqual(expect.objectContaining({
      role: 'compaction',
      text: 'Summary',
      compaction: { trigger: 'manual', tokensBefore: 100, tokensAfter: 10 },
    }));
  });

  it('starts a forked conversation at its own first turn without a boundary row', () => {
    const own = [
      turn(1, [opener('p1', 'side question'), answer('a1', 'side answer')]),
      turn(2, [opener('p2', 'follow-up'), answer('a2', 'more')]),
    ];
    const boundary = turn(0, [{
      type: 'system',
      kind: 'fork_boundary',
      item_id: 'fork-0',
      status: 'ended',
      outcome: 'completed',
      created_at: AT,
      source: 'btw',
      forked_from: { agent_id: 'main' },
    }], { kind: 'system', turn_number: undefined });

    const forked = project([boundary, ...own]);

    expect(forked.map((value) => [value.role, value.text])).toEqual([
      ['user', 'side question'],
      ['assistant', 'side answer'],
      ['user', 'follow-up'],
      ['assistant', 'more'],
    ]);
    expect(forked).toEqual(project(own));
  });

  it('keeps every assistant message of a turn, including one that repeats an earlier text', () => {
    const turns = project([
      turn(0, [
        opener('p0', 'Check it twice'),
        { ...answer('a1', 'Checking.'), step_index: 1 },
        tool('call-1', { input: { command: 'git status' }, output: 'clean' }),
        { ...answer('a2', 'Checking.'), step_index: 2 },
        tool('call-2', { step_index: 2, input: { command: 'git status' }, output: 'clean' }),
      ]),
    ]);

    const assistant = turns.find((value) => value.role === 'assistant');
    expect(assistant?.blocks?.map((block) => block.kind)).toEqual(['text', 'tool', 'text', 'tool']);
    expect(assistant?.text).toBe('Checking.\nChecking.');
  });

  it('splits a turn at a steer, marks the answer before it final and appends a later notification', () => {
    const notification: NotificationItem = {
      type: 'notification', item_id: 'n0', status: 'ended', outcome: 'completed', created_at: AT,
      notification_id: 'task:b1:completed', notification_type: 'task.completed', source: { kind: 'background_task', id: 'b1' },
      title: 'Background process completed', body: 'done', severity: 'info',
    };
    const turns = project([
      turn(0, [
        opener('p0', 'build it'),
        answer('a0', 'Building.'),
        tool('call-0'),
        answer('a1', 'Built.'),
        opener('p1', 'also test', { placement: 'steer' }),
        { ...answer('a2', 'Testing.'), step_index: 2 },
      ]),
      turn(1, [notification, { ...answer('a3', 'The background build finished.'), step_index: 1 }]),
    ]);

    expect(turns.map((value) => value.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[1]?.blocks?.map((block) => [block.kind, block.kind === 'text' ? block.final === true : undefined])).toEqual([
      ['text', false], ['tool', undefined], ['text', true],
    ]);
    expect(turns[1]).toMatchObject({ sourceTurnId: 't0', sourceReplyId: 'a1' });
    expect(turns[2]).toMatchObject({ steered: true, steerPhase: 'injected', promptIds: ['p1'], undoTurnId: undefined });
    expect(turns[0]).toMatchObject({ undoTurnId: 't0' });
    expect(turns[3]?.blocks?.map((block) => block.kind)).toEqual(['text', 'notification', 'text']);
    expect(turns[3]).toMatchObject({ daemonTurnId: 1, forkTurnIndex: 2, sourceTurnId: 't1', sourceReplyId: 'a3' });
  });

  it('reads the subagent id of an agent call from its refs or its persisted result', () => {
    const tools = toolsOf(project([turn(0, [
      opener('p0', 'delegate'),
      tool('call-1', { name: 'Agent', agent_refs: [{ agent_id: 'agent-1', role: 'child' }] }),
      tool('call-2', { name: 'SubAgent', output: 'agent_id: agent-2\n\nDone.' }),
    ])]));

    expect(tools.map((value) => value.agentId)).toEqual(['agent-1', 'agent-2']);
  });

  it('merges adjacent text and reasoning items and spans the reasoning time of both', () => {
    const reasoning = (id: string, startedAt: string, durationMs: number): ConversationItem => ({
      type: 'reasoning', item_id: id, status: 'ended', outcome: 'completed', step_index: 1, created_at: startedAt, started_at: startedAt, duration_ms: durationMs, text: id,
    });
    const [, assistant] = project([turn(0, [
      opener('p0', 'think'),
      reasoning('r0', '2026-01-01T00:00:00.000Z', 1000),
      reasoning('r1', '2026-01-01T00:00:02.000Z', 1000),
      answer('a0', 'one'),
      answer('a1', 'two', 'running'),
    ], { duration_ms: 4000, ended_at: '2026-01-01T00:00:04.000Z' })]);

    expect(assistant?.blocks).toEqual([
      { kind: 'thinking', thinking: 'r0\nr1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 3000 },
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two', streaming: true },
    ]);
    expect(assistant).toMatchObject({ durationMs: 4000, endedAt: '2026-01-01T00:00:04.000Z' });
  });

  it('reads the state of a reply that spans turns from its last turn', () => {
    const [, reply] = project([
      turn(0, [opener('p0', 'go'), answer('a0', 'first')]),
      turn(1, [answer('a1', 'more', 'running')], running),
    ]);

    expect(reply).toMatchObject({ daemonTurnId: 1, forkTurnIndex: 2, daemonTurnState: 'running', sourceTurnId: 't1' });
  });

  it('associates feedback with the body-producing turn when a later turn has only activity', () => {
    const [, reply] = project([
      turn(0, [opener('p0', 'go'), answer('a0', 'the answer')]),
      turn(1, [tool('follow-up-tool')]),
    ]);

    expect(reply).toMatchObject({ sourceTurnId: 't0', forkTurnIndex: 2 });
  });

  it('carries the request debug of an item onto its block and keeps both when blocks merge', () => {
    const [, assistant] = project([turn(0, [
      opener('p0', 'go'),
      { ...answer('a0', 'one'), debug: { finish_reason: 'length' } },
      { ...answer('a1', 'two'), step_index: 2, debug: { finish_reason: 'end_turn', timing: { first_token_ms: 300 } } },
      tool('c0'),
    ])]);

    expect(assistant?.blocks?.map((block) => [block.kind, block.debug])).toEqual([
      ['text', [{ finish_reason: 'length' }, { finish_reason: 'end_turn', timing: { first_token_ms: 300 } }]],
      ['tool', undefined],
    ]);
  });

  it('renders a pending prompt bubble from the submitted parts', () => {
    const bubble = pendingPromptTurn({
      id: 'msg_opt_1',
      sessionId: 'session-1',
      role: 'user',
      createdAt: AT,
      content: [
        { type: 'text', text: 'see [notes](kimi-code-composer://attachments/1)' },
        { type: 'file', fileId: 'f_doc', name: 'notes.md', mediaType: 'text/markdown', size: 4 },
        { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_img' } },
      ],
      metadata: { 'kimiWeb.promptId': 'p_new', 'kimiWeb.steered': true, 'kimiWeb.steerPhase': 'accepted' },
    }, 3, { sessionId: 'session-1', getFileUrl: (id) => `/files/${id}`, getSessionMediaUrl: (sid, id) => `/sessions/${sid}/media/${id}` });

    expect(bubble).toMatchObject({ no: 3, steered: true, steerPhase: 'accepted', promptIds: ['p_new'] });
    expect(bubble.undoTurnId).toBeUndefined();
    expect(bubble.attachments).toEqual([
      { kind: 'image', url: '/sessions/session-1/media/f_img', fileId: 'f_img', sessionId: 'session-1', mediaOrdinal: 1 },
    ]);
    expect(bubble.inlineAttachments?.[0]).toMatchObject({ kind: 'file', url: '/files/f_doc', size: 4 });
  });

  it('keeps selected skill paths on pending prompt bubbles', () => {
    const base = { sessionId: 's', role: 'user' as const, createdAt: AT, content: [] };
    const single = pendingPromptTurn({
      ...base,
      id: 'single',
      metadata: {
        origin: {
          kind: 'skill_activation',
          skillName: 'review',
          skillPath: '/work/B/review/SKILL.md',
          skillArgs: 'src',
        },
      },
    }, 1, { sessionId: 's' });
    const bundled = pendingPromptTurn({
      ...base,
      id: 'bundled',
      metadata: {
        origin: {
          kind: 'user',
          skillActivations: [
            { skillName: 'review', skillPath: '/work/A/review/SKILL.md' },
            { skillName: 'review', skillPath: '/work/B/review/SKILL.md' },
          ],
        },
      },
    }, 2, { sessionId: 's' });

    expect(single.skillActivation).toEqual({ name: 'review', path: '/work/B/review/SKILL.md', args: 'src' });
    expect(bundled.skillActivations).toEqual([
      { name: 'review', path: '/work/A/review/SKILL.md', args: undefined },
      { name: 'review', path: '/work/B/review/SKILL.md', args: undefined },
    ]);
  });

  it('reuses the projection of untouched segments', () => {
    const projector = createConversationProjector();
    const options = { sessionId: 's' };
    const earlier = turn(0, [opener('p0', 'one'), answer('a0', 'first')]);
    const before = projector([earlier, turn(1, [opener('p1', 'two'), answer('a1', 'x', 'running')], running)], options);
    const after = projector([earlier, turn(1, [opener('p1', 'two'), answer('a1', 'xy', 'running')], running)], options);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[3]).not.toBe(before[3]);
  });

  it('projects a continuation turn without an opener user_message cleanly without an empty user bubble', () => {
    const turns = project([
      turn(0, [opener('p0', 'start work'), answer('a0', 'partial output')], {
        outcome: 'interrupted',
        end_reason: 'user_cancelled',
      }),
      turn(1, [answer('a1', 'resumed output')]),
    ]);
    expect(turns.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.text).toBe('partial output\nresumed output');
  });
});
