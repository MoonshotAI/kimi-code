import type { Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import {
  computeEditStats,
  computeWriteStats,
} from '#/tui/components/messages/tool-renderers/chip';
import type { TranscriptPresentationOptions } from '#/tui/config';
import { TRANSCRIPT_TAIL_THINKING_TICK_MS } from '#/tui/constant/rendering';
import type { ToolResultBlockData } from '#/tui/types';
import {
  deriveGroupView,
  fitRunningTail,
  rowStatusOf,
  tailText,
  titleText,
  type GroupView,
} from '#/tui/utils/group-view';
import { TranscriptItemInspector } from '#/tui/utils/transcript-items';
import {
  projectTranscript,
  type GroupProjection,
  type TranscriptProjection,
} from '#/tui/utils/transcript-projection';
import {
  countedAt,
  instant,
  isToolCallId,
  phaseAt,
  preparingAt,
  settledAt,
  slowAt,
  slowSince,
  thinkingTextAt,
  turnLiveAt,
  TurnTimeline,
  type CallFacts,
  type Instant,
  type ThinkingFacts,
  type TimelineReader,
  type ToolCallId,
} from '#/tui/utils/turn-timeline';

let id = 0;

function options(overrides: Partial<TranscriptPresentationOptions> = {}): TranscriptPresentationOptions {
  return {
    fullscreen: true,
    toolCallDensity: 'detailed',
    thinking: 'grouped',
    ...overrides,
  };
}

function result(output = 'ok', isError = false): ToolResultBlockData {
  const callId = `call-${++id}`;
  return { tool_call_id: callId, output, is_error: isError };
}

function tool(
  name: string,
  args: Record<string, unknown> = {},
  toolResult: ToolResultBlockData | null | undefined = result(),
): ToolCallComponent {
  const actualResult = toolResult ?? undefined;
  const callId = actualResult?.tool_call_id ?? `call-${++id}`;
  return new ToolCallComponent(
    { id: callId, name, args },
    actualResult,
    undefined,
    '/work',
  );
}

function thought(ms?: number): ThinkingComponent {
  const component = new ThinkingComponent('reasoning', true, 'finalized');
  component.finalize(ms === undefined ? { known: false } : { known: true, ms });
  return component;
}

function inspect(components: readonly Component[], presentation = options()) {
  return new TranscriptItemInspector().read(components, presentation);
}

function project(components: readonly Component[], presentation = options()) {
  const items = inspect(components, presentation);
  return projectTranscript(items, presentation);
}

function onlyGroup(components: readonly Component[], presentation = options()): GroupProjection {
  const groups = project(components, presentation).filter((item) => item.kind === 'group');
  expect(groups).toHaveLength(1);
  return groups[0] as GroupProjection;
}

function groupView(group: GroupProjection, timeline: TimelineReader = new TurnTimeline(), now = 0, last = false): GroupView {
  return deriveGroupView({ members: group.members, pending: group.pending, last, timeline }, instant(now));
}

function fragmentsOf(projection: TranscriptProjection): readonly string[] {
  if (projection.kind !== 'group') return [];
  const { title } = groupView(projection);
  return title.kind === 'summary' ? title.text.split(', ') : [titleText(title)];
}

function summary(components: readonly Component[], presentation = options()) {
  const { title } = groupView(onlyGroup(components, presentation));
  if (title.kind === 'item') return { fragments: [titleText(title)], added: 0, removed: 0, failed: 0, interrupted: 0 };
  return { ...title, fragments: title.text.split(', ') };
}

describe('transcript projection', () => {
  it('returns the original source list when every grouping option is off or not fullscreen', () => {
    const read = tool('Read', { path: '/work/a.ts' });
    const group = new ReadGroupComponent(undefined);
    group.attach(read.toolCallView.id, read);
    group.attach('read-b', tool('Read', { path: '/work/b.ts' }));
    const components = [thought(1000), group];

    for (const presentation of [
      options({ toolCallDensity: 'ungrouped', thinking: 'ungrouped' }),
      options({ fullscreen: false }),
    ]) {
      const items = inspect(components, presentation);
      expect(items.map((item) => item.display)).toEqual(components);
      expect(projectTranscript(items, presentation).map((item) => item.kind)).toEqual(['single', 'single']);
    }
  });

  it('treats whitespace-only assistant text as transparent until content arrives', () => {
    const assistant = new AssistantMessageComponent();
    assistant.updateContent(' \n\t ');
    const components = [
      tool('Read', { path: '/work/a.ts' }),
      assistant,
      tool('Grep', { pattern: 'needle' }),
    ];

    expect(onlyGroup(components).members).toHaveLength(2);
    expect(assistant.render(80)).toEqual([]);
    const initialVersion = assistant.transcriptProjectionVersion;

    assistant.updateContent('answer');
    expect(assistant.transcriptProjectionVersion).toBe(initialVersion + 1);
    const projections = project(components);
    expect(projections.map((item) => item.kind)).toEqual(['group', 'single', 'group']);
    expect(projections[1]).toMatchObject({
      kind: 'single',
      item: { kind: 'boundary', display: assistant },
    });

    assistant.updateContent('answer with more text');
    expect(assistant.transcriptProjectionVersion).toBe(initialVersion + 1);
    assistant.updateContent(' ');
    expect(assistant.transcriptProjectionVersion).toBe(initialVersion + 2);
    expect(onlyGroup(components).members).toHaveLength(2);
  });

  it('includes running tools as members and uses present tense only for their category', () => {
    const current = tool('Grep', { pattern: 'needle' }, null);
    const group = onlyGroup([
      tool('Read', { path: '/work/a.ts' }),
      current,
      tool('Read', { path: '/work/b.ts' }),
    ]);

    expect(group.members.map((item) => item.display)).toContain(current);
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(0).callStarted(callId(current.toolCallView.id), 'Grep');
    expect(groupView(group, timeline, 300).title).toMatchObject({ text: 'Read 2 files, searching 1 pattern' });
  });

  it('keeps streaming thinking in the group and titles it first', () => {
    const thinking = new ThinkingComponent('reasoning', true, 'live');
    const components = [tool('Read'), thinking, tool('Grep')];

    expect(onlyGroup(components).members.map((item) => item.display)).toContain(thinking);
    expect(summary(components).fragments).toEqual(['Thinking', 'read 1 file', 'searched 1 pattern']);

    thinking.finalize({ known: true, ms: 3000 });
    expect(summary(components).fragments).toEqual(['Thought for 3s', 'read 1 file', 'searched 1 pattern']);
  });

  it('splits the run around a user-opened member in source order, then restores it', () => {
    const read = tool('Read');
    const components = [thought(3000), read, tool('Grep')];
    const items = inspect(components);
    const opened = projectTranscript(items, options(), (component) => component === read);

    expect(opened.map((projection) => projection.kind)).toEqual(['group', 'single', 'group']);
    expect(opened[1]).toMatchObject({ kind: 'single', item: { display: read } });
    expect(opened.filter((projection) => projection.kind === 'group').map(fragmentsOf))
      .toEqual([['Thought for 3s'], ['Search']]);

    expect(summary(components).fragments).toEqual(['Thought for 3s', 'read 1 file', 'searched 1 pattern']);
  });

  it('makes Agent and AgentSwarm boundaries in auto mode', () => {
    const agent = tool('Agent', {}, null);
    agent.markBackgrounded();
    const swarm = tool('AgentSwarm', {}, null);
    const projections = project([
      tool('Read', { path: '/work/a.ts' }),
      agent,
      swarm,
      tool('Read', { path: '/work/b.ts' }),
    ], options({ toolCallDensity: 'compact' }));

    expect(projections.map((item) => item.kind)).toEqual(['group', 'single', 'single', 'group']);
    expect(projections[1]).toMatchObject({ kind: 'single', item: { display: agent } });
    expect(projections[2]).toMatchObject({ kind: 'single', item: { display: swarm } });
  });

  it('keeps the first run item as the anchor when calls finish out of order', () => {
    const first = tool('Read', { path: '/work/a.ts' }, null);
    const third = tool('Read', { path: '/work/c.ts' }, null);
    const components = [
      first,
      tool('Grep', { pattern: 'needle' }),
      third,
      tool('Read', { path: '/work/d.ts' }),
    ];
    const initial = onlyGroup(components);
    expect(initial.anchor).toBe(first);
    expect(initial.members.find((item) => item.display === first)?.current).toBe(true);
    expect(initial.members.find((item) => item.display === third)?.current).toBe(true);

    third.setResult(result(), { known: true, ms: 1 });
    const thirdDone = onlyGroup(components);
    expect(thirdDone.anchor).toBe(first);
    expect(thirdDone.members.find((item) => item.display === third)?.current).toBe(false);

    first.setResult(result(), { known: true, ms: 1 });
    expect(onlyGroup(components).anchor).toBe(first);
  });

  it('holds streaming Bash as a pending member until its arguments parse, before the next call appears', () => {
    const read = tool('Read', { path: '/work/a.ts' });
    const bash = tool('Bash', { command: '' }, null);
    bash.updateToolCall({ ...bash.toolCallView, streamingArguments: '{"command":"rm -f out' });

    const streaming = onlyGroup([read, bash]);
    expect(streaming.pending.map((item) => item.display)).toEqual([bash]);
    expect(streaming.members.map((item) => item.display)).not.toContain(bash);

    bash.updateToolCall({
      ...bash.toolCallView,
      args: { command: 'rm -f output.txt' },
      streamingArguments: '{"command":"rm -f output.txt"}',
    });
    const next = tool('Read', { path: '/work/b.ts' }, null);
    next.updateToolCall({ ...next.toolCallView, streamingArguments: '{"path":"/work/b' });
    const placed = project([read, bash, next]);
    expect(placed.map((item) => item.kind)).toEqual(['group', 'single', 'group']);
    expect(placed[1]).toMatchObject({ kind: 'single', item: { display: bash } });

    bash.updateToolCall({ ...bash.toolCallView, streamingArguments: undefined });
    expect(project([read, bash, next]).map((item) => item.kind)).toEqual(['group', 'single', 'group']);
  });

  it('joins a streamed read-only command to its group as soon as its arguments parse', () => {
    const read = tool('Read', { path: '/work/a.ts' });
    const bash = tool('Bash', { command: '' }, null);
    bash.updateToolCall({
      ...bash.toolCallView,
      args: { command: 'ls src' },
      streamingArguments: '{"command":"ls src"}',
    });
    const write = tool('Write', { path: '/work/b.ts' }, null);
    write.updateToolCall({ ...write.toolCallView, streamingArguments: '{"path":"/work/b' });

    const projections = project([read, bash, write]);
    expect(projections.map((item) => item.kind)).toEqual(['group', 'single']);
    expect((projections[0] as GroupProjection).members.map((item) => item.display)).toEqual([read, bash]);
    expect((projections[0] as GroupProjection).pending).toEqual([]);
  });

  it('makes a running non-foldable tool a boundary immediately', () => {
    const bash = tool('Bash', { command: 'rm -f output.txt' }, null);
    const projections = project([tool('Read', { path: '/work/a.ts' }), bash, tool('Read', { path: '/work/b.ts' })]);

    expect(projections.map((item) => item.kind)).toEqual(['group', 'single', 'group']);
    expect(projections[1]).toMatchObject({ kind: 'single', item: { display: bash } });
  });

  it('keeps web tools as cards in detailed and folds them in compact', () => {
    const components = [
      tool('WebSearch'),
      tool('Read', { path: '/work/a.ts' }),
      tool('FetchURL'),
    ];

    expect(project(components).map((item) => item.kind)).toEqual(['single', 'group', 'single']);
    expect(summary(components, options({ toolCallDensity: 'compact' })).fragments).toEqual([
      'Read 1 file',
      'fetched 1 page',
      'ran 1 web search',
    ]);
  });

  it.each([
    ['compact', 'grouped', ['group']],
    ['balanced', 'grouped', ['group', 'row', 'row', 'row', 'group']],
    ['detailed', 'grouped', ['group', 'single', 'single', 'single', 'group']],
    ['ungrouped', 'grouped', ['group', 'single', 'single', 'single', 'single', 'single']],
    ['compact', 'ungrouped', ['single', 'group']],
  ] as const)('folds %s tool calls with %s thinking', (toolCallDensity, thinking, kinds) => {
    const components = [
      thought(1000),
      tool('Read', { path: '/work/a.ts' }),
      tool('Edit', { path: '/work/a.ts', old_string: 'a', new_string: 'b' }),
      tool('Bash', { command: 'npm install' }),
      tool('Bash', { command: 'ls -la' }),
      tool('Read', { path: '/work/b.ts' }),
    ];

    expect(project(components, options({ toolCallDensity, thinking })).map((item) => item.kind)).toEqual(kinds);
  });

  it('groups one tool and silently includes select_tools in the same group', () => {
    const read = tool('Read', { path: '/work/a.ts' });
    expect(project([read]).map((item) => item.kind)).toEqual(['group']);
    expect(project([tool('select_tools'), read]).map((item) => item.kind)).toEqual(['group']);

    const group = onlyGroup([read, tool('select_tools'), tool('Grep')]);
    expect(group.members).toHaveLength(3);
    expect(fragmentsOf(group)).toEqual(['Read 1 file', 'searched 1 pattern']);
  });

  it('passes through a run containing only select_tools', () => {
    expect(project([tool('select_tools'), tool('select_tools')]).map((item) => item.kind))
      .toEqual(['single', 'single']);
  });

  it('groups a thought-only run and preserves its elapsed text', () => {
    expect(summary([thought(3000)]).fragments).toEqual(['Thought for 3s']);
    expect(summary([thought(3000), thought()]).fragments).toEqual(['Thought']);
  });

  it('formats fragments in a stable order with plurals and combined other tools', () => {
    const components = [
      tool('mcp__serverB__tool'),
      tool('TaskStop'),
      thought(60_000),
      tool('mcp__serverA__one'),
      tool('TaskOutput'),
      tool('Edit', { path: '/work/a.ts', old_string: 'a', new_string: 'b' }),
      tool('Bash', { command: 'git status' }),
      tool('TodoList'),
      tool('TaskList'),
      tool('Skill'),
      tool('WebSearch'),
      tool('FetchURL'),
      tool('Read', { path: '/work/a.ts' }),
      tool('Read', { path: '/work/a.ts' }),
      tool('Read', { path: '/work/b.ts' }),
      tool('Grep'),
      tool('mcp__serverA__two'),
      thought(65_000),
    ];

    expect(summary(components, options({ toolCallDensity: 'compact' })).fragments).toEqual([
      'Thought for 2m 5s',
      'read 2 files',
      'searched 1 pattern',
      'fetched 1 page',
      'ran 1 web search',
      'loaded 1 skill',
      'updated todos',
      'ran 1 command',
      'edited 1 file',
      'checked 1 task',
      'called serverB 1 time',
      'called serverA 2 times',
      'used 2 tools',
    ]);
  });

  it('uses singular labels throughout the summary', () => {
    expect(summary([
      tool('Read', { path: '/work/a.ts' }),
      tool('Grep'),
      tool('Bash', { command: 'git status' }),
    ]).fragments).toEqual(['Read 1 file', 'searched 1 pattern', 'ran 1 command']);
  });

  it('uses the card diff computations for edit and write totals', () => {
    const editArgs = {
      path: '/work/a.ts',
      old_string: 'one\ntwo\nthree\nfour',
      new_string: 'one\nTWO\nthree\nfour',
    };
    const writeArgs = { path: '/work/b.ts', content: 'first\nsecond\n' };
    const edit = computeEditStats(editArgs);
    const write = computeWriteStats(writeArgs);
    const result = summary([
      tool('Edit', editArgs),
      tool('Write', writeArgs),
      thought(1),
    ], options({ toolCallDensity: 'compact' }));

    expect(result.added).toBe(edit.added + write.lines);
    expect(result.removed).toBe(edit.removed);
    expect(result.fragments).toContain('edited 2 files');
  });

  it.each([
    ['Bash', 'The user manually interrupted "Bash"'],
    ['Bash', 'Tool "Bash" was aborted'],
    ['Bash', 'Interrupted by user'],
    ['Edit', 'Tool "Edit" was not run because the user rejected the approval request'],
    ['Read', 'Tool "Read" was not run because the approval request was cancelled'],
    ['CustomTool', 'User tool "CustomTool" was aborted.'],
  ])('counts %s interruption output separately from failures', (name, output) => {
    const interrupted = tool(name, {}, result(output, true));
    const summaryResult = summary([interrupted, thought(1)], options({ toolCallDensity: 'compact' }));

    expect(summaryResult.failed).toBe(0);
    expect(summaryResult.interrupted).toBe(1);
  });

  it.each(['failed', 'timed_out', 'killed', 'lost'])(
    'counts TaskOutput %s status even when the error bit is false',
    (status) => {
      const failed = tool('TaskOutput', {}, result(`retrieval_status: success\nstatus: ${status}\n\n[output]\ntests failed`));
      const summaryResult = summary([failed, thought(1)], options({ toolCallDensity: 'compact' }));

      expect(summaryResult.failed).toBe(1);
      expect(summaryResult.interrupted).toBe(0);
    },
  );

  it.each(['failed', 'timed_out', 'killed', 'lost'])('counts WaitFor %s task status', (status) => {
    const output = [
      'wait_status: completed',
      'task_id: task-1',
      'waited_ms: 1000',
      '',
      '[finished]',
      'task_id: task-1',
      `status: ${status}`,
      '',
      '[output]',
      'tests failed',
    ].join('\n');
    const summaryResult = summary([
      tool('WaitFor', {}, result(output)),
      thought(1),
    ], options({ toolCallDensity: 'compact' }));

    expect(summaryResult.failed).toBe(1);
    expect(summaryResult.interrupted).toBe(0);
  });

  it('does not count a WaitFor timeout without a finished task as a failure', () => {
    const output = [
      'wait_status: timed_out',
      'task_id: task-1',
      'waited_ms: 1000',
      '',
      '[still_running]',
      'active_background_tasks: 1',
      'description: build',
    ].join('\n');
    const summaryResult = summary([
      tool('WaitFor', {}, result(output)),
      thought(1),
    ], options({ toolCallDensity: 'compact' }));

    expect(summaryResult.failed).toBe(0);
    expect(summaryResult.interrupted).toBe(0);
  });

  it('counts every failure of an all-failed group without marking the group', () => {
    const summaryResult = summary([
      tool('Bash', {}, result('failed', true)),
      tool('Read', {}, result('missing', true)),
    ], options({ toolCallDensity: 'compact' }));

    expect(summaryResult).toMatchObject({ failed: 2, text: 'Read 1 file, ran 1 command' });
  });

  it('splits ReadGroup only when tool grouping is enabled', () => {
    const group = new ReadGroupComponent(undefined);
    const first = tool('Read', { path: '/work/a.ts' });
    const second = tool('Read', { path: '/work/b.ts' });
    group.attach(first.toolCallView.id, first);
    group.attach(second.toolCallView.id, second);

    expect(inspect([group]).map((item) => item.display)).toEqual([first, second]);
    expect(project([group], options({ toolCallDensity: 'ungrouped' }))).toEqual([
      expect.objectContaining({ kind: 'single', item: expect.objectContaining({ display: group }) }),
    ]);
  });

  it('treats AgentSwarmProgress as a card boundary before and after completion', () => {
    const component = new AgentSwarmProgressComponent({ description: 'review' });
    component.updateArgs({ items: ['a', 'b'] });
    expect(inspect([component], options({ toolCallDensity: 'compact' }))[0]).toMatchObject({
      kind: 'boundary',
      role: 'card',
      display: component,
    });
    expect(project([component], options({ toolCallDensity: 'compact' }))[0])
      .toMatchObject({ kind: 'single', item: { display: component } });

    component.applyResult([
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<subagent index="1" outcome="completed">done</subagent>',
      '<subagent index="2" outcome="failed">failed</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    component.markToolCallEnded();
    expect(inspect([component], options({ toolCallDensity: 'compact' }))[0]).toMatchObject({
      kind: 'boundary',
      role: 'card',
      display: component,
    });
  });

  it('treats AgentGroup as one card boundary', () => {
    const group = new AgentGroupComponent(undefined);
    const first = tool('Agent');
    const second = tool('Agent', {}, result('failed', true));
    group.attach(first.toolCallView.id, first);
    group.attach(second.toolCallView.id, second);

    expect(inspect([group], options({ toolCallDensity: 'compact' }))[0]).toMatchObject({
      kind: 'boundary',
      role: 'card',
      display: group,
    });
    expect(project([group], options({ toolCallDensity: 'compact' }))[0])
      .toMatchObject({ kind: 'single', item: { display: group } });
  });
});

describe('transcript projection versions', () => {
  it('changes only for projection-relevant thinking updates', () => {
    const component = new ThinkingComponent('one', true, 'live');
    const initial = component.transcriptProjectionVersion;
    component.setText('two');
    expect(component.transcriptProjectionVersion).toBe(initial);
    component.finalize({ known: true, ms: 1250 });
    expect(component.transcriptProjectionVersion).toBe(initial + 1);
    expect(component.thinkingElapsed).toEqual({ known: true, ms: 1250 });
  });

  it('changes when Bash arguments finalize and when results arrive', () => {
    const component = tool('Bash', { command: '' }, null);
    component.updateToolCall({ ...component.toolCallView, streamingArguments: '{"command":"git status"}' });
    const streaming = component.transcriptProjectionVersion;
    component.updateToolCall({
      ...component.toolCallView,
      args: { command: 'git status' },
      streamingArguments: undefined,
    });
    expect(component.transcriptProjectionVersion).toBe(streaming + 1);
    component.setResult(result(), { known: true, ms: 20 });
    expect(component.transcriptProjectionVersion).toBe(streaming + 2);
    expect(component.toolElapsed).toEqual({ known: true, ms: 20 });
  });

  it('tracks AgentSwarm phase changes without tracking model deltas', () => {
    const component = new AgentSwarmProgressComponent({ description: 'review' });
    component.updateArgs({ items: ['a'] });
    component.markInputComplete();
    component.registerSubagent({ agentId: 'agent-1', swarmIndex: 1 });
    component.markStarted('agent-1');
    const initial = component.transcriptProjectionVersion;
    component.appendModelDelta({ agentId: 'agent-1', delta: 'working' });
    expect(component.transcriptProjectionVersion).toBe(initial);
    component.markCompleted('agent-1');
    expect(component.transcriptProjectionVersion).toBeGreaterThan(initial);
  });
});

function callId(id: string): ToolCallId {
  if (!isToolCallId(id)) throw new Error('a tool call id is never empty');
  return id;
}

function scriptedTimeline(): { timeline: TurnTimeline; at: (ms: number) => TurnTimeline } {
  let clock = 0;
  const timeline = new TurnTimeline(() => instant(clock));
  return {
    timeline,
    at: (ms) => {
      clock = ms;
      return timeline;
    },
  };
}

function latestThought(timeline: TurnTimeline, now: Instant): ThinkingFacts {
  const thinking = timeline.latestThinking(now);
  if (thinking === undefined) throw new Error('expected a thought');
  return thinking;
}

describe('turn timeline', () => {
  it('ends arguments at the next call, an approval or the start of execution', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(100).callDelta(callId('read'), 'Read');
    at(300).callDelta(callId('read'));
    at(400).callDelta(callId('bash'), 'Bash');
    at(450).callDelta(callId('read'));
    at(700).approvalRequested(callId('bash'), 'Bash');
    at(900).callStarted(callId('read'), 'Read');
    at(1000).callStarted(callId('bash'), 'Bash');
    at(1500).callResult(callId('read'));

    const read = timeline.call(callId('read'));
    const bash = timeline.call(callId('bash'));
    expect(read).toEqual({
      start: 100,
      name: 'Read',
      argsEnd: 400,
      exec: 900,
      settle: { kind: 'result', at: 1500 },
    });
    expect(phaseAt(bash, instant(500))).toEqual({ kind: 'writing', since: 400 });
    expect(phaseAt(bash, instant(800))).toEqual({ kind: 'queued', since: 700 });
    expect(phaseAt(bash, instant(1200))).toEqual({ kind: 'executing', since: 1000 });
    expect(phaseAt(read, instant(1400))).toEqual({ kind: 'executing', since: 900 });
    expect(phaseAt(read, instant(1500))).toEqual({ kind: 'settled', settle: { kind: 'result', at: 1500 } });
    expect(phaseAt(timeline.call(callId('replayed')), instant(1500))).toEqual({ kind: 'history' });
  });

  it('ignores repeated and late marks', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(100).callDelta(callId('read'), 'Read');
    at(200).callStarted(callId('read'), 'Read');
    at(300).callStarted(callId('read'), 'Grep');
    at(400).callResult(callId('read'));
    at(500).callResult(callId('read'));
    at(600).callDelta(callId('read'), 'Glob');
    at(700).approvalRequested(callId('read'), 'Read');
    at(800).callDelta(callId('write'), 'Write');
    at(900).abandonUnstarted();
    at(1000).callStarted(callId('write'), 'Write');
    at(1100).callResult(callId('write'));

    expect(timeline.call(callId('read'))).toEqual({
      start: 100,
      name: 'Read',
      argsEnd: 200,
      exec: 200,
      settle: { kind: 'result', at: 400 },
    });
    expect(timeline.call(callId('write'))).toEqual({
      start: 800,
      name: 'Write',
      argsEnd: 900,
      settle: { kind: 'abandoned', at: 900 },
    });
  });

  it('abandons calls that never started at a retry, a step boundary and the end of the turn', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(100).callDelta(callId('cut'), 'Write');
    at(300).abandonUnstarted();
    at(400).callDelta(callId('run'), 'Bash');
    at(500).callStarted(callId('run'), 'Bash');
    at(600).abandonUnstarted();
    at(700).turnEnded();

    const cut = timeline.call(callId('cut'));
    const run = timeline.call(callId('run'));
    expect(cut).toMatchObject({ argsEnd: 300, settle: { kind: 'abandoned', at: 300 } });
    expect(run).toMatchObject({ exec: 500, settle: { kind: 'abandoned', at: 700 } });
    expect(countedAt(cut, instant(60_000))).toBe(false);
    expect(countedAt(run, instant(700))).toBe(true);
    expect(settledAt(run, instant(699))).toBe(false);
    expect(settledAt(run, instant(700))).toBe(true);
  });

  it('starts the turn when the request is sent, ends it once and clears on reset', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(300).turnStarted();
    expect(timeline.turn()).toEqual({ kind: 'live', start: 0 });

    at(400).thinkingDelta('plan');
    at(1000).turnEnded();
    at(1200).turnEnded();
    expect(timeline.turn()).toEqual({ kind: 'ended', start: 0, end: 1000 });
    expect(timeline.latestThinking(instant(1200))).toMatchObject({ start: 400, end: 1000 });
    expect(turnLiveAt(timeline.turn(), instant(999))).toBe(true);
    expect(turnLiveAt(timeline.turn(), instant(1000))).toBe(false);

    at(1500).turnStarted();
    expect(timeline.turn()).toEqual({ kind: 'live', start: 1500 });
    expect(timeline.latestThinking(instant(1500))).toBeUndefined();

    at(1600).callDelta(callId('read'), 'Read');
    timeline.reset();
    expect(timeline.turn()).toBeUndefined();
    expect(phaseAt(timeline.call(callId('read')), instant(1600))).toEqual({ kind: 'history' });
  });

  it('counts a call 200 ms after it starts executing, or at its result if that comes first', () => {
    const running: CallFacts = { start: instant(0), argsEnd: instant(100), exec: instant(100) };
    const quick: CallFacts = { start: instant(0), exec: instant(100), settle: { kind: 'result', at: instant(150) } };
    const resultOnly: CallFacts = { start: instant(0), settle: { kind: 'result', at: instant(50) } };

    expect(countedAt(running, instant(299))).toBe(false);
    expect(countedAt(running, instant(300))).toBe(true);
    expect(countedAt(quick, instant(149))).toBe(false);
    expect(countedAt(quick, instant(150))).toBe(true);
    expect(countedAt(resultOnly, instant(49))).toBe(false);
    expect(countedAt(resultOnly, instant(50))).toBe(true);
    expect(countedAt(undefined, instant(0))).toBe(true);
    expect(settledAt(undefined, instant(0))).toBe(true);
  });

  it('reports the idle gap the model is waiting in', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(1000).thinkingDelta('plan');
    at(1600).callDelta(callId('read'), 'Read');
    at(1900).callStarted(callId('read'), 'Read');
    at(2500).callResult(callId('read'));
    at(4000).turnEnded();

    expect([500, 1200, 1700, 2000, 3000, 4500].map((now) => timeline.waitingSince(instant(now)))).toEqual([
      0,
      undefined,
      undefined,
      undefined,
      2500,
      undefined,
    ]);
  });

  it('changes the live thinking line only on the 240 ms grid', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(1000).thinkingDelta('He');
    at(1100).thinkingDelta('llo');
    at(1300).thinkingDelta(' wor');
    at(1500).thinkingDelta('ld');
    const thinking = latestThought(timeline, instant(1500));

    expect(TRANSCRIPT_TAIL_THINKING_TICK_MS).toBe(240);
    expect([1100, 1199, 1200, 1439, 1440, 1680].map((now) => thinkingTextAt(thinking, instant(now)))).toEqual([
      'He',
      'He',
      'Hello',
      'Hello',
      'Hello wor',
      'Hello world',
    ]);
  });

  it('keeps one slow-call timer across chained calls and restarts it after a break', () => {
    const chained: CallFacts[] = [
      { start: instant(0), exec: instant(0), settle: { kind: 'result', at: instant(3000) } },
      { start: instant(0), exec: instant(1500), settle: { kind: 'result', at: instant(6000) } },
      { start: instant(0), exec: instant(6500) },
    ];
    const touching: CallFacts[] = [
      { start: instant(0), exec: instant(0), settle: { kind: 'result', at: instant(2000) } },
      { start: instant(0), exec: instant(1000), settle: { kind: 'result', at: instant(4000) } },
    ];

    expect([999, 1000, 2999, 3500, 5999, 6000, 7500].map((now) => slowSince(chained, instant(now)))).toEqual([
      undefined,
      0,
      0,
      0,
      0,
      undefined,
      6500,
    ]);
    expect(slowSince(touching, instant(2000))).toBe(0);
    expect(slowAt(chained[0], instant(1000))).toBe(true);
    expect(slowAt(chained[0], instant(3000))).toBe(false);
  });

  it('reports an argument stream as preparing once it has run for a second', () => {
    const long: CallFacts = { start: instant(0), argsEnd: instant(1500) };
    const short: CallFacts = { start: instant(0), argsEnd: instant(800) };
    const open: CallFacts = { start: instant(0) };

    expect([999, 1000, 1499, 1500].map((now) => preparingAt(long, instant(now)))).toEqual([false, true, true, false]);
    expect(preparingAt(short, instant(1000))).toBe(false);
    expect(preparingAt(open, instant(5000))).toBe(true);
  });

  it.each([
    ['an argument stream that runs for a second', (at: (ms: number) => TurnTimeline) => {
      at(1000).callDelta(callId('write'), 'Write');
    }, 2000],
    ['a call that runs for a second', (at: (ms: number) => TurnTimeline) => {
      at(1000).callDelta(callId('bash'), 'Bash');
      at(1100).callStarted(callId('bash'), 'Bash');
    }, 2100],
    ['a new thought', (at: (ms: number) => TurnTimeline) => {
      at(1000).callDelta(callId('read'), 'Read');
      at(1100).callStarted(callId('read'), 'Read');
      at(1200).callResult(callId('read'));
      at(1400).thinkingDelta('next');
    }, 1400],
    ['a wait for the model, even one that is over', (at: (ms: number) => TurnTimeline) => {
      at(500).callDelta(callId('read'), 'Read');
      at(700).callStarted(callId('read'), 'Read');
      at(800).callResult(callId('read'));
      at(2000).callDelta(callId('grep'), 'Grep');
    }, 1800],
    ['two seconds when nothing else takes the tail', (at: (ms: number) => TurnTimeline) => {
      at(1000).callDelta(callId('read'), 'Read');
      at(1500).callStarted(callId('read'), 'Read');
      at(2200).callResult(callId('read'));
      at(2600).callDelta(callId('grep'), 'Grep');
    }, 3000],
  ])('holds a finished thought until %s', (_case, script, deadline) => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(100).thinkingDelta('plan');
    script(at);

    expect(timeline.thoughtHeldUntil(latestThought(timeline, instant(100)))).toBe(deadline);
  });

  it('holds no thought that is still being written or that belongs to an earlier turn', () => {
    const { timeline, at } = scriptedTimeline();
    at(0).turnStarted();
    at(100).thinkingDelta('plan');
    const thought = latestThought(timeline, instant(100));
    expect(timeline.thoughtHeldUntil(thought)).toBeUndefined();

    at(500).turnEnded();
    at(600).turnStarted();
    expect(timeline.thoughtHeldUntil(thought)).toBe(500);
  });
});

const compact = options({ toolCallDensity: 'compact' });
const idOf = (component: ToolCallComponent): ToolCallId => callId(component.toolCallView.id);

function tailAt(view: GroupView, now: number, columns = 120): string | undefined {
  return view.tail === undefined ? undefined : tailText(view.tail, columns, instant(now));
}

function streaming(name: string, args: Record<string, unknown> = {}): ToolCallComponent {
  const component = tool(name, args, null);
  component.updateToolCall({ ...component.toolCallView, streamingArguments: '{' });
  return component;
}

describe('group view', () => {
  it('counts a 0.1 s Read straight in the past tense and never puts it in the tail', () => {
    const { timeline, at } = scriptedTimeline();
    const read = tool('Read', { path: '/work/a.ts' }, null);
    const group = onlyGroup([thought(1000), read], compact);
    at(0).turnStarted();
    at(100).callDelta(idOf(read), 'Read');
    at(300).callStarted(idOf(read), 'Read');
    at(400).callResult(idOf(read));

    const titles: string[] = [];
    for (let now = 300; now <= 3000; now += 10) {
      const view = groupView(group, timeline, now, true);
      if (titles.at(-1) !== titleText(view.title)) titles.push(titleText(view.title));
      expect(tailAt(view, now)).not.toMatch(/^Reading/);
    }
    expect(titles).toEqual(['Thought for 1s', 'Thought for 1s, read 1 file']);
    expect([1399, 1400, 2400].map((now) => tailAt(groupView(group, timeline, now, true), now)))
      .toEqual(['', 'Waiting for response', 'Waiting for response · 2s']);
  });

  it('lists parallel slow commands in the tail under one timer that never runs backwards', () => {
    const { timeline, at } = scriptedTimeline();
    const calls = [
      { component: tool('Bash', { command: 'sleep 30' }, null), exec: 300, end: 30_300 },
      { component: tool('Bash', { command: 'sleep 50' }, null), exec: 310, end: 50_310 },
      { component: tool('Bash', { command: 'sleep 60' }, null), exec: 320, end: 60_320 },
    ];
    at(0).turnStarted();
    for (const [index, { component }] of calls.entries()) at(index * 100).callDelta(idOf(component), 'Bash');
    for (const { component, exec } of calls) at(exec).callStarted(idOf(component), 'Bash');
    for (const { component, end } of calls) at(end).callResult(idOf(component));
    at(61_000).turnEnded();
    const group = onlyGroup(calls.map(({ component }) => component), compact);

    const titles: string[] = [];
    for (let now = 300; now <= 61_100; now += 10) {
      const view = groupView(group, timeline, now, true);
      if (titles.at(-1) !== titleText(view.title)) titles.push(titleText(view.title));
      expect(view.tail).toBeDefined();
    }
    expect(titles).toEqual([
      'Running commands',
      'Running 1 command',
      'Running 2 commands',
      'Running 3 commands',
      'Ran 3 commands',
    ]);
    expect([1320, 2300, 31_000, 60_400].map((now) => tailAt(groupView(group, timeline, now, true), now))).toEqual([
      'Running sleep 30, sleep 50, sleep 60',
      'Running sleep 30, sleep 50, sleep 60 · 2s',
      'Running sleep 50, sleep 60 · 31s',
      '',
    ]);
    expect(groupView(group, timeline, 1320, false)).toMatchObject({ tail: undefined, working: true });
    expect(groupView(group, timeline, 61_100, true)).toMatchObject({ working: false, live: false });
  });

  it('drops an argument stream cut by a retry from the tail and never counts it', () => {
    const { timeline, at } = scriptedTimeline();
    const read = tool('Read', { path: '/work/a.ts' }, null);
    const edit = tool('Edit', { path: '/work/a.ts' }, null);
    const group = onlyGroup([read, edit], compact);
    at(0).turnStarted();
    at(100).callDelta(idOf(read), 'Read');
    at(200).callStarted(idOf(read), 'Read');
    at(300).callResult(idOf(read));
    at(500).callDelta(idOf(edit), 'Edit');
    at(1700).outputEnded();
    at(4000).abandonUnstarted();

    expect([1600, 1800, 5000].map((now) => tailAt(groupView(group, timeline, now, true), now)))
      .toEqual(['Preparing Edit', '', 'Waiting for response']);
    for (const now of [1600, 1800, 5000]) {
      expect(titleText(groupView(group, timeline, now, true).title)).toBe('Read 1 file');
    }
    expect(rowStatusOf(group.members[1] ?? group.members[0], timeline, instant(5000))).toEqual({ kind: 'interrupted' });
  });

  it('settles an interrupted turn: the running call counts as interrupted and the tail goes blank', () => {
    const { timeline, at } = scriptedTimeline();
    const bash = tool('Bash', { command: 'sleep 60' }, null);
    const edit = tool('Edit', { path: '/work/a.ts' }, null);
    at(0).turnStarted();
    at(100).callDelta(idOf(bash), 'Bash');
    at(200).callDelta(idOf(edit), 'Edit');
    at(300).callStarted(idOf(bash), 'Bash');
    at(2000).abandonUnstarted();
    at(2050).callResult(idOf(bash));
    at(2100).turnEnded();
    bash.setResult(result('Interrupted by user', true), { known: true, ms: 1750 });
    const group = onlyGroup([bash, edit], compact);
    const view = groupView(group, timeline, 2200, true);

    expect(view.title).toMatchObject({ text: 'Ran 1 command', interrupted: 1, failed: 0 });
    expect(tailAt(view, 2200)).toBe('');
    expect(view).toMatchObject({ working: false, live: false });
  });

  it('drops a call cut by max_tokens from the tail and the title', () => {
    const { timeline, at } = scriptedTimeline();
    const write = tool('Write', { path: '/work/a.ts' }, null);
    const group = onlyGroup([thought(400), write], compact);
    at(0).turnStarted();
    at(100).thinkingDelta('plan');
    at(500).callDelta(idOf(write), 'Write');
    at(1700).outputEnded();
    at(1700).abandonUnstarted();

    expect(tailAt(groupView(group, timeline, 1600, true), 1600)).toBe('Preparing Write');
    for (const now of [1700, 2000, 2600]) {
      const view = groupView(group, timeline, now, true);
      expect(titleText(view.title)).toBe('Thought for 1s');
      expect(tailAt(view, now)).toBe('');
    }
  });

  it('gives a finished thought up for good once something else takes the tail, even a wait that is over', () => {
    const first = scriptedTimeline();
    const read = tool('Read', { path: '/work/a.ts' }, null);
    const displaced = onlyGroup([thought(500), read], compact);
    first.at(0).turnStarted();
    first.at(100).thinkingDelta('Plan the change');
    first.at(600).callDelta(idOf(read), 'Read');
    first.at(2100).callStarted(idOf(read), 'Read');
    expect([700, 1600, 2200].map((now) => tailAt(groupView(displaced, first.timeline, now, true), now)))
      .toEqual(['Plan the change', 'Preparing Read', '']);

    const second = scriptedTimeline();
    const fast = tool('Read', { path: '/work/b.ts' }, null);
    const grep = tool('Grep', { pattern: 'needle' }, null);
    const waited = onlyGroup([thought(100), fast, grep], compact);
    second.at(0).turnStarted();
    second.at(100).thinkingDelta('Look around');
    second.at(200).callDelta(idOf(fast), 'Read');
    second.at(300).callStarted(idOf(fast), 'Read');
    second.at(400).callResult(idOf(fast));
    second.at(1500).callDelta(idOf(grep), 'Grep');
    expect([300, 1450, 1550].map((now) => tailAt(groupView(waited, second.timeline, now, true), now)))
      .toEqual(['Look around', 'Waiting for response', '']);
  });

  it('keeps a group of an earlier turn idle while the next turn waits, then waits inside the group', () => {
    const { timeline, at } = scriptedTimeline();
    const earlier = tool('Read', { path: '/work/a.ts' });
    const later = tool('Read', { path: '/work/b.ts' });
    at(0).turnStarted();
    at(100).callDelta(idOf(earlier), 'Read');
    at(200).callStarted(idOf(earlier), 'Read');
    at(300).callResult(idOf(earlier));
    at(400).turnEnded();
    at(10_000).turnStarted();
    expect(groupView(onlyGroup([earlier], compact), timeline, 14_000, true))
      .toMatchObject({ tail: { kind: 'blank' }, working: false, live: false });

    at(14_500).callDelta(idOf(later), 'Read');
    at(14_600).callStarted(idOf(later), 'Read');
    at(15_000).callResult(idOf(later));
    const group = onlyGroup([earlier, later], compact);
    expect([16_000, 17_000].map((now) => tailAt(groupView(group, timeline, now, true), now)))
      .toEqual(['Waiting for response', 'Waiting for response · 2s']);
  });

  it('gives up the tail the moment text starts and drops it once the group is not last', () => {
    const { timeline, at } = scriptedTimeline();
    const read = tool('Read', { path: '/work/a.ts' });
    at(0).turnStarted();
    at(100).callDelta(idOf(read), 'Read');
    at(200).callStarted(idOf(read), 'Read');
    at(300).callResult(idOf(read));
    at(1500).textDelta();
    const group = onlyGroup([thought(100), read], compact);

    expect([1400, 1500].map((now) => tailAt(groupView(group, timeline, now, true), now)))
      .toEqual(['Waiting for response', '']);
    expect(groupView(group, timeline, 1500, false).tail).toBeUndefined();
  });

  function slowSearchAndTest(): { readonly group: GroupProjection; readonly timeline: TurnTimeline } {
    const { timeline, at } = scriptedTimeline();
    const calls = [
      tool('Grep', { pattern: 'TODO' }, null),
      tool('Grep', { pattern: 'FIXME' }, null),
      tool('Grep', { pattern: 'deprecated' }, null),
      tool('Bash', { command: 'pnpm vitest run --project tui' }, null),
    ];
    at(0).turnStarted();
    for (const call of calls) at(0).callStarted(idOf(call), call.toolCallView.name);
    return { group: onlyGroup(calls, compact), timeline };
  }

  it.each([
    [90, 'Searching "TODO", "FIXME", "deprecated"; running pnpm vitest run --project tui · 2s'],
    [75, 'Searching "TODO" +2 more; running pnpm vitest run --project tui · 2s'],
    [60, 'Searching "TODO" +2 more; running pnpm vitest run… · 2s'],
    [44, 'Searching "TODO" +2 more; running… · 2s'],
  ])('shortens the slow-call tail to fit %i columns', (width, expected) => {
    const { group, timeline } = slowSearchAndTest();
    expect(tailAt(groupView(group, timeline, 2400, true), 2400, width - '  └ '.length)).toBe(expected);
  });

  it('keeps the names in place when the timer appears or reaches two digits', () => {
    const { group, timeline } = slowSearchAndTest();
    const names = [1900, 2400, 9400, 10_400].map((now) =>
      tailAt(groupView(group, timeline, now, true), now, 56)?.replace(/ · \d+s$/, ''));
    expect(new Set(names)).toEqual(new Set(['Searching "TODO" +2 more; running pnpm vitest run…']));
    expect(fitRunningTail([{ verb: 'running', names: ['a'] }], 0)).toBe('');
  });

  it('titles a group with nothing counted yet by its first member category', () => {
    const { timeline, at } = scriptedTimeline();
    const bash = tool('Bash', { command: 'make' }, null);
    const mcp = tool('mcp__github__create_issue', {}, null);
    at(0).turnStarted();
    at(0).callStarted(idOf(bash), 'Bash');
    at(0).callStarted(idOf(mcp), 'mcp__github__create_issue');

    expect(titleText(groupView(onlyGroup([bash, mcp], compact), timeline, 100).title)).toBe('Running commands');
    expect(titleText(groupView(onlyGroup([mcp, bash], compact), timeline, 100).title)).toBe('Calling github');
    expect(titleText(groupView(onlyGroup([mcp, bash], compact), timeline, 200).title))
      .toBe('Running 1 command, calling github 1 time');
  });

  it('streams the latest paragraph of a live thought into the tail without a timer', () => {
    const { timeline, at } = scriptedTimeline();
    const group = onlyGroup([new ThinkingComponent('reasoning', true, 'live')], compact);
    at(0).turnStarted();
    at(100).thinkingDelta('First idea.\n\nSecond');
    at(600).thinkingDelta(' idea\ngrows');

    expect(titleText(groupView(group, timeline, 500, true).title)).toBe('Thinking');
    expect([500, 720, 4000].map((now) => tailAt(groupView(group, timeline, now, true), now)))
      .toEqual(['Second', 'Second idea grows', 'Second idea grows']);
  });

  it('draws a blank tail instead of repeating the title', () => {
    const { timeline, at } = scriptedTimeline();
    const group = onlyGroup([new ThinkingComponent('reasoning', true, 'live')], compact);
    at(0).turnStarted();
    at(100).thinkingDelta('\n\n');
    expect(groupView(group, timeline, 200, true).tail).toEqual({ kind: 'blank' });
  });

  it('prepares an unnamed pending call as a tool call, then by the name the card shows', () => {
    const { timeline, at } = scriptedTimeline();
    const unnamed = streaming('Tool');
    at(0).turnStarted();
    at(100).callDelta(idOf(unnamed));
    const group = onlyGroup([tool('Read', { path: '/work/a.ts' }), unnamed]);

    expect(group.pending.map((item) => item.display)).toEqual([unnamed]);
    expect(titleText(groupView(group, timeline, 1100, true).title)).toBe('Read a.ts');
    expect(tailAt(groupView(group, timeline, 1100, true), 1100)).toBe('Preparing a tool call');
    at(1200).callDelta(idOf(unnamed), 'mcp__github__create_issue');
    expect(tailAt(groupView(group, timeline, 3200, true), 3200)).toBe('Preparing create_issue · 3s');
  });
});

describe('fold rules', () => {
  it('holds a streaming command only after a titled member and places it once classified', () => {
    const alone = streaming('Bash');
    expect(project([alone]).map((projection) => projection.kind)).toEqual(['single']);
    alone.updateToolCall({ ...alone.toolCallView, args: { command: 'ls' }, streamingArguments: undefined });
    expect(project([alone]).map((projection) => projection.kind)).toEqual(['single']);

    const read = tool('Read', { path: '/work/a.ts' });
    const bash = streaming('Bash');
    const held = onlyGroup([read, bash]);
    expect(held.members.map((item) => item.display)).toEqual([read]);
    expect(held.pending.map((item) => item.display)).toEqual([bash]);

    bash.updateToolCall({ ...bash.toolCallView, args: { command: 'ls' }, streamingArguments: undefined });
    expect(onlyGroup([read, bash]).members.map((item) => item.display)).toEqual([read, bash]);
    bash.updateToolCall({ ...bash.toolCallView, args: { command: 'npm install' } });
    expect(project([read, bash]).map((projection) => projection.kind)).toEqual(['group', 'single']);
  });

  it('folds an unnamed call into the run in compact and titles it as a tool', () => {
    const { timeline, at } = scriptedTimeline();
    const unnamed = streaming('Tool');
    at(0).turnStarted();
    at(0).callDelta(idOf(unnamed));
    const group = onlyGroup([unnamed], compact);
    expect(group.members.map((item) => item.display)).toEqual([unnamed]);
    expect(titleText(groupView(group, timeline, 100).title)).toBe('Using tools');
    expect(project([unnamed]).map((projection) => projection.kind)).toEqual(['single']);
  });
});
