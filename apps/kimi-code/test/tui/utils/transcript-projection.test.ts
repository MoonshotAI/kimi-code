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
import type { ToolResultBlockData } from '#/tui/types';
import { TranscriptItemInspector } from '#/tui/utils/transcript-items';
import {
  projectTranscript,
  summarizeGroup,
  type GroupProjection,
  type GroupSummary,
} from '#/tui/utils/transcript-projection';

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

function summary(components: readonly Component[], presentation = options()): GroupSummary {
  return summarizeGroup(onlyGroup(components, presentation).members);
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

    expect(group.external).toEqual([]);
    expect(group.members.map((item) => item.display)).toContain(current);
    expect(group.running).toBe(true);
    expect(summarizeGroup(group.members).fragments).toEqual(['Read 2 files', 'searching 1 pattern']);
  });

  it('keeps streaming thinking outside and folds it into the summary when finished', () => {
    const thinking = new ThinkingComponent('reasoning', true, 'live');
    const components = [tool('Read'), thinking, tool('Grep')];
    const streaming = onlyGroup(components);

    expect(streaming.external.map((item) => item.display)).toEqual([thinking]);
    expect(streaming.members.map((item) => item.display)).not.toContain(thinking);
    expect(summarizeGroup(streaming.members).fragments).toEqual(['Read 1 file', 'searched 1 pattern']);

    thinking.finalize({ known: true, ms: 3000 });
    const finished = onlyGroup(components);
    expect(finished.external).toEqual([]);
    expect(finished.members.map((item) => item.display)).toContain(thinking);
    expect(summarizeGroup(finished.members).fragments).toContain('Thought for 3s');
  });

  it('splits the run around a user-opened member in source order, then restores it', () => {
    const read = tool('Read');
    const components = [thought(3000), read, tool('Grep')];
    const items = inspect(components);
    const opened = projectTranscript(items, options(), (component) => component === read);

    expect(opened.map((projection) => projection.kind)).toEqual(['group', 'single', 'group']);
    expect(opened[1]).toMatchObject({ kind: 'single', item: { display: read } });
    expect(opened.flatMap((projection) =>
      projection.kind === 'group' ? [summarizeGroup(projection.members).fragments] : [],
    )).toEqual([['Thought for 3s'], ['Searched 1 pattern']]);

    const restored = onlyGroup(components);
    expect(restored.external).toEqual([]);
    expect(summarizeGroup(restored.members).fragments)
      .toEqual(['Thought for 3s', 'read 1 file', 'searched 1 pattern']);
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
    expect(initial.external).toEqual([]);
    expect(initial.members.find((item) => item.display === first)?.current).toBe(true);
    expect(initial.members.find((item) => item.display === third)?.current).toBe(true);

    third.setResult(result(), { known: true, ms: 1 });
    const thirdDone = onlyGroup(components);
    expect(thirdDone.anchor).toBe(first);
    expect(thirdDone.members.find((item) => item.display === third)?.current).toBe(false);

    first.setResult(result(), { known: true, ms: 1 });
    expect(onlyGroup(components).anchor).toBe(first);
    expect(onlyGroup(components).running).toBe(false);
  });

  it('groups streaming Bash before final arguments classify it', () => {
    const bash = tool('Bash', { command: '' }, null);
    bash.updateToolCall({
      ...bash.toolCallView,
      streamingArguments: '{"command":"rm -f output.txt"}',
    });
    const components = [tool('Read', { path: '/work/a.ts' }), bash, tool('Read', { path: '/work/b.ts' })];

    const streaming = onlyGroup(components);
    expect(streaming.external).toEqual([]);
    expect(streaming.members.map((item) => item.display)).toContain(bash);

    bash.updateToolCall({
      ...bash.toolCallView,
      args: { command: 'rm -f output.txt' },
      streamingArguments: undefined,
    });
    const projections = project(components);
    expect(projections.map((item) => item.kind)).toEqual(['group', 'single', 'group']);
    expect(projections.some((item) => item.kind === 'single' && item.item.display === bash)).toBe(true);
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
    ['balanced', 'grouped', ['group', 'single', 'single', 'group']],
    ['detailed', 'grouped', ['group', 'single', 'single', 'group']],
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
    expect(summarizeGroup(group.members).fragments).toEqual(['Read 1 file', 'searched 1 pattern']);
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
    expect(summaryResult.allFailed).toBe(false);
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

  it('marks an all-failed group', () => {
    const summaryResult = summary([
      tool('Bash', {}, result('failed', true)),
      tool('Read', {}, result('missing', true)),
    ], options({ toolCallDensity: 'compact' }));

    expect(summaryResult.failed).toBe(2);
    expect(summaryResult.allFailed).toBe(true);
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
