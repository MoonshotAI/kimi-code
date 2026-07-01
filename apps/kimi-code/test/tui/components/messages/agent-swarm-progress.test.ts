import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import {
  AgentSwarmProgressComponent,
  type AgentSwarmProgressOptions,
  agentSwarmDescriptionFromArgs,
  agentSwarmGridHeightForTerminalRows,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
  calculateAgentSwarmGridLayout,
} from '#/tui/components/messages/agent-swarm-progress';
import { AgentSwarmProgressEstimator } from '#/tui/components/messages/agent-swarm-progress-estimator';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

const DEFAULT_DESCRIPTION = 'Review changed files';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function createComponent(
  options: Partial<AgentSwarmProgressOptions> = {},
): AgentSwarmProgressComponent {
  return new AgentSwarmProgressComponent({
    description: options.description ?? DEFAULT_DESCRIPTION,
    requestRender: options.requestRender,
    availableGridHeight: options.availableGridHeight,
  });
}

function renderText(component: AgentSwarmProgressComponent, width = 100): string {
  return strip(component.render(width).join('\n'));
}

function renderLines(component: AgentSwarmProgressComponent, width = 100): string[] {
  return renderText(component, width).split('\n');
}

function registerSubagents(component: AgentSwarmProgressComponent, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    component.registerSubagent({
      agentId: `agent-${String(index)}`,
      description: `${DEFAULT_DESCRIPTION} #${String(index)} (coder)`,
    });
  }
}

function startSubagents(component: AgentSwarmProgressComponent, count: number): void {
  component.markInputComplete();
  for (let index = 1; index <= count; index += 1) {
    component.markStarted(`agent-${String(index)}`);
  }
}

afterEach(() => {
  vi.useRealTimers();
  currentTheme.setPalette(darkColors);
});

describe('calculateAgentSwarmGridLayout', () => {
  it('uses a text grid when labels fit within the available height', () => {
    const layout = calculateAgentSwarmGridLayout({
      width: 100,
      height: 3,
      count: 9,
    });

    expect(layout).toMatchObject({
      renderText: true,
      columns: 3,
      rows: 3,
    });
    expect(layout.barCells).toBeGreaterThanOrEqual(6);
    expect(layout.cellWidth).toBeGreaterThanOrEqual(22);
  });

  it('adds text columns before falling back to compact bars', () => {
    const textLayout = calculateAgentSwarmGridLayout({
      width: 120,
      height: 4,
      count: 20,
    });
    const compactLayout = calculateAgentSwarmGridLayout({
      width: 117,
      height: 4,
      count: 20,
    });

    expect(textLayout).toMatchObject({
      renderText: true,
      columns: 5,
      rows: 4,
    });
    expect(compactLayout).toMatchObject({
      renderText: false,
      columns: 5,
      rows: 4,
    });
    expect(compactLayout.barCells).toBeGreaterThan(textLayout.barCells);
  });

  it('uses compact bars to satisfy tight height budgets', () => {
    const layout = calculateAgentSwarmGridLayout({
      width: 100,
      height: 5,
      count: 30,
    });

    expect(layout).toMatchObject({
      renderText: false,
      columns: 6,
      rows: 5,
    });
    expect(layout.barCells).toBeGreaterThan(0);
  });

  it('keeps compact rows within the available height even when bars are narrow', () => {
    const layout = calculateAgentSwarmGridLayout({
      width: 100,
      height: 4,
      count: 40,
    });

    expect(layout).toMatchObject({
      renderText: false,
      columns: 10,
      rows: 4,
    });
    expect(layout.barCells).toBe(1);
  });

  it('keeps at least one bar cell when no rows are available', () => {
    const layout = calculateAgentSwarmGridLayout({
      width: 20,
      height: 0,
      count: 4,
    });

    expect(layout).toMatchObject({
      renderText: false,
      columns: 2,
      rows: 2,
    });
    expect(layout.barCells).toBeGreaterThan(0);
  });

  it('derives the grid height left inside the AgentSwarm block', () => {
    expect(agentSwarmGridHeightForTerminalRows(undefined)).toBeUndefined();
    expect(agentSwarmGridHeightForTerminalRows(10)).toBe(4);
    expect(agentSwarmGridHeightForTerminalRows(20, 5)).toBe(9);
    expect(agentSwarmGridHeightForTerminalRows(4)).toBe(0);
  });
});

describe('AgentSwarmProgressComponent', () => {
  it('renders an orchestrating panel before subagents spawn', () => {
    const component = createComponent();

    const output = renderText(component);

    expect(output).toContain('Agent Swarm');
    expect(output).toContain('Review changed files');
    expect(output).toContain('Orchestrating...');
    expect(output).not.toContain('01');
  });

  it('repaints from the active palette when the theme changes', () => {
    const previousLevel = chalk.level;
    chalk.level = 3; // force truecolor so palette differences surface as ANSI
    try {
      const component = createComponent();
      const titleOf = (): string => {
        const line = component.render(100).find((l) => strip(l).includes('Agent Swarm'));
        if (line === undefined) throw new Error('title line not found');
        return line;
      };
      const before = titleOf();

      currentTheme.setPalette(lightColors);
      const after = titleOf();

      // Same visible text, different ANSI colours (reads currentTheme live).
      expect(strip(after)).toBe(strip(before));
      expect(after).not.toBe(before);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('renders blank padding around the block without a bottom divider', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    const lines = renderLines(component);

    expect(lines[0]).toBe(' ');
    expect(lines[1]).toContain('Agent Swarm');
    expect(lines.at(-1)).toBe(' ');
    expect(lines.at(-2)).not.toMatch(/^─+$/);
  });

  it('reserves one blank column on the right edge', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    startSubagents(component, 1);

    const rendered = component.render(80).map(strip);
    const gridLine = rendered.find((line) => line.includes('001 ['));

    expect(rendered.every((line) => visibleWidth(line) <= 79)).toBe(true);
    expect(rendered.some((line) => line.includes('Agent Swarm'))).toBe(true);
    expect(gridLine).toBeDefined();
    expect(visibleWidth(gridLine ?? '')).toBeLessThanOrEqual(79);
  });

  it('renders spawned subagents as queued rows without empty progress bars', () => {
    const component = createComponent();

    registerSubagents(component, 2);

    const output = renderText(component);

    expect(output).toContain('001 Queued...');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('001 [');
    expect(output).not.toContain('002 [');
    expect(output).not.toContain('agents=2');
  });

  it('fits three queued columns with the narrower gap and minimum cell width', () => {
    const component = createComponent();

    registerSubagents(component, 3);

    const lines = renderLines(component, 97);
    const queuedLine = lines.find((line) => line.includes('001 Queued...'));

    expect(queuedLine).toBeDefined();
    expect(queuedLine).toContain('002 Queued...');
    expect(queuedLine).toContain('003 Queued...');
  });

  it('omits subagent text when the compact grid is needed to fit available height', () => {
    const component = createComponent({
      availableGridHeight: () => 5,
    });

    registerSubagents(component, 30);
    startSubagents(component, 30);

    const lines = renderLines(component, 102);
    const gridLines = lines.filter((line) => /\b\d{3} \[/.test(line));

    expect(gridLines).toHaveLength(5);
    expect(gridLines[0]).toContain('001 [');
    expect(gridLines[0]).toContain('006 [');
    expect(gridLines.join('\n')).not.toContain('Running');
  });

  it('keeps streamed pending items as text even when compact layout is selected', () => {
    const component = createComponent({
      availableGridHeight: () => 5,
    });

    component.updateArgs({
      items: Array.from({ length: 30 }, (_item, index) => `f${String(index + 1)}.ts`),
    });

    const output = renderText(component, 102);

    expect(output).toContain('001 f1.ts');
    expect(output).toContain('006 f6.ts');
    expect(output).not.toContain('001 [');
  });

  it('prefixes a cancelled running subagent label with the aborted mark without changing the text', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    startSubagents(component, 1);
    component.appendModelDelta({ agentId: 'agent-1', delta: 'Inspecting src/a.ts' });
    component.markCancelled('agent-1');

    const output = renderText(component);
    const cellLine = output.split('\n').find((line) => line.includes('001 ['));

    expect(cellLine).toBeDefined();
    expect(cellLine).toContain('⊘ Inspecting src/a.ts');
    expect(cellLine).not.toContain('⊘ Aborted.');
  });

  it('shows a cancelled label without a progress bar for queued subagents', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.markInputComplete();
    component.markCancelled('agent-1');

    const output = renderText(component);
    const cellLine = output.split('\n').find((line) => line.includes('001 '));

    expect(cellLine).toBeDefined();
    expect(cellLine).toContain('⊘ Cancelled.');
    expect(cellLine).not.toContain('[');
    expect(cellLine).not.toContain('⊘ Aborted.');
  });

  it('renders terminal marks against compact bars when subagent text is hidden', () => {
    const component = createComponent({
      availableGridHeight: () => 5,
    });

    registerSubagents(component, 30);
    startSubagents(component, 30);
    component.markCompleted('agent-1');
    component.markFailed('agent-2', 'Agent timed out');
    component.markCancelled('agent-3');

    const lines = renderLines(component, 102);
    const gridLine = lines.find((line) => line.includes('001 ['));

    expect(gridLine).toBeDefined();
    expect(gridLine).toMatch(/001 \[[^\]]+\]✓ +002 \[[^\]]+\]✗ +003 \[[^\]]+\]⊘/);
    expect(gridLine).not.toContain('Completed');
    expect(gridLine).not.toContain('Failed');
    expect(gridLine).not.toContain('Aborted');
  });

  it('advances from queued when a subagent tool call starts and marks terminal states', () => {
    const component = createComponent();

    registerSubagents(component, 2);
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });

    let output = renderText(component);
    expect(output).toContain('001 [');
    expect(output).toContain('Running');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('002 [');

    component.markCompleted('agent-1');
    component.markFailed('agent-2');

    output = renderText(component);
    expect(output).toContain('001 [');
    expect(output).toContain('✓');
    expect(output).toContain('Completed.');
    expect(output).toContain('002 [');
    expect(output).toContain('Failed');
  });

  it('renders completed subagent output with a success mark', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.markCompleted('agent-1', 'Reviewed imports and found no regressions');

    const output = renderText(component);

    expect(output).toContain('✓ Reviewed imports and found no regressions');
    expect(output).toContain('Completed.');
  });

  it('renders failure details from live subagent failures', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.markFailed('agent-1', 'Provider request failed\nRetry budget exhausted');

    const output = renderText(component);

    expect(output).toContain('✗ Provider request failed Retry budget exhausted');
    expect(output).not.toContain('Failed:');
  });

  it('renders suspended subagents as rate limited and clears the state when they start again', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.markStarted('agent-1');
    component.markSuspended({
      agentId: 'agent-1',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });

    let output = renderText(component);
    expect(output).toContain('Rate limited...');
    expect(output).not.toContain('Queued...');
    expect(output).not.toContain('Provider rate limit');
    expect(output).not.toContain('Failed');

    component.markStarted('agent-1');

    output = renderText(component);
    expect(output).toContain('Running');
    expect(output).not.toContain('Rate limited...');
  });

  it('renders rate-limited subagents as cancelled when cancelled', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.markStarted('agent-1');
    component.markSuspended({
      agentId: 'agent-1',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });
    component.markCancelled('agent-1');

    const cellLine = renderLines(component)
      .find((line) => line.includes('001 ['));

    expect(cellLine).toBeDefined();
    expect(cellLine).toContain('⊘ Cancelled.');
    expect(cellLine).not.toContain('Rate limited...');
  });

  it('renders failure details from AgentSwarm result output', () => {
    const component = createComponent();

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts'],
    });
    component.applyResult([
      '<agent_swarm_result>',
      '<summary>failed: 1</summary>',
      '<subagent index="1" agent_id="agent-1" outcome="failed">Agent timed out after 30s.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));

    const output = renderText(component);

    expect(output).toContain('✗ Agent timed out after 30s.');
    expect(output).not.toContain('Failed:');
  });

  it('applies no-index AgentSwarm result statuses by tag order', () => {
    const component = createComponent();

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const applied = component.applyResult([
      '<agent_swarm_result>',
      '<summary>failed: 1, aborted: 1</summary>',
      '<subagent agent_id="agent-1" item="src/a.ts" outcome="failed">' +
        'Agent timed out after 30s.</subagent>',
      '<subagent agent_id="agent-2" item="src/b.ts" outcome="aborted">' +
        'User interrupted.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));

    const output = renderText(component, 120);

    expect(applied).toBe(true);
    expect(output).toContain('✗ Agent timed out after 30s.');
    expect(output).toContain('⊘ Cancelled.');
    expect(output).not.toContain('002 [');
    expect(output).not.toContain('Completed.');
  });

  it('strips nested AgentSwarm prefixes from failure details', () => {
    const component = createComponent();

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts'],
    });
    component.applyResult([
      '<agent_swarm_result>',
      '<summary>failed: 1</summary>',
      '<subagent index="1" agent_id="agent-1" outcome="failed">agent_swarm: failed',
      'description: Nested review',
      'items: 1',
      'completed: 0',
      'failed: 1',
      '',
      '[agent 1]',
      'status: failed',
      '',
      'subagent error: [provider.rate_limit] 429 request reached user+model max RPM.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));

    const output = renderText(component, 120);

    expect(output).toContain('✗ [provider.rate_limit] 429 request reached user+model max RPM.');
    expect(output).not.toContain('agent_swarm:');
    expect(output).not.toContain('Failed:');
  });

  it('renders completed summaries from AgentSwarm result output', () => {
    const component = createComponent();

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts'],
    });
    component.applyResult([
      '<agent_swarm_result>',
      '<summary>completed: 1</summary>',
      '<subagent index="1" agent_id="agent-1" outcome="completed">Reviewed src/a.ts and confirmed imports are stable.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));

    const output = renderText(component);

    expect(output).toContain('✓ Reviewed src/a.ts and confirmed imports are stable.');
    expect(output).toContain('Completed.');
  });

  it('shows completed total status when only some subagents fail', () => {
    const component = createComponent();

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
    });
    component.applyResult([
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<subagent index="1" agent_id="agent-1" outcome="completed">Reviewed src/a.ts and confirmed imports are stable.</subagent>',
      '<subagent index="2" agent_id="agent-2" outcome="failed">Agent timed out after 30s.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));

    const output = renderText(component, 120);
    const totalStatusLine = output.split('\n').find((line) => line.includes('Completed.'));

    expect(totalStatusLine).toBeDefined();
    expect(totalStatusLine).not.toContain('Failed.');
    expect(output).toContain('✓ Reviewed src/a.ts');
    expect(output).toContain('✗ Agent timed out after 30s.');
  });

  it('uses the latest assistant line as completed output when no summary is available', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.appendModelDelta({
      agentId: 'agent-1',
      delta: 'Reviewing src/a.ts\nImports look stable',
    });
    component.markCompleted('agent-1');

    const output = renderText(component);

    expect(output).toContain('✓ Imports look stable');
    expect(output).toContain('Completed.');
  });

  it('shows latest assistant text after the progress bar with ellipsis truncation', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    component.markInputComplete();
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });
    component.appendModelDelta({
      agentId: 'agent-1',
      delta: 'Reviewing src/a.ts and checking imports for regressions in detail',
    });

    const output = renderText(component, 44);
    expect(output).toContain('001 [');
    expect(output).toContain('Reviewing');
    expect(output).toContain('…');
  });

  it('uses natural status label width for prompting text', () => {
    const prompting = createComponent({
      description: '',
    });
    prompting.updateArgs({}, {
      streamingArguments: '{"prompt_template":"Review the changed TypeScript files carefully',
    });

    const promptLine = renderLines(prompting, 80)
      .find((line) => line.includes('Prompting...'));
    expect(promptLine).toBeDefined();

    const working = createComponent();
    registerSubagents(working, 1);
    startSubagents(working, 1);

    const workingLine = renderLines(working, 80)
      .find((line) => line.includes('Working...'));
    expect(workingLine).toBeDefined();

    const promptTextIndex = promptLine?.indexOf('Review the changed') ?? -1;
    const progressBarIndex = workingLine?.indexOf('━') ?? -1;
    expect(promptTextIndex).toBeGreaterThan(0);
    expect(progressBarIndex).toBeGreaterThan(0);
    expect(promptTextIndex).toBe(visibleWidth('  Prompting... '));
    expect(progressBarIndex).toBe(visibleWidth('  Working...  '));
  });

  it('renders the activity spinner before the total status line', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    startSubagents(component, 1);
    component.setActivitySpinnerText(() => '🌗');

    const statusLine = renderLines(component, 80)
      .find((line) => line.includes('Working...'));

    expect(statusLine).toBeDefined();
    expect(statusLine?.startsWith(' 🌗 Working...')).toBe(true);
  });

  it('keeps a two-cell placeholder after the AgentSwarm tool call ends', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    startSubagents(component, 1);
    component.setActivitySpinnerText(() => '🌗');
    component.markToolCallEnded();
    component.setActivitySpinnerText(() => '🌘');

    const statusLine = renderLines(component, 80)
      .find((line) => line.includes('Working...'));

    expect(statusLine).toBeDefined();
    expect(statusLine?.startsWith('    Working...')).toBe(true);
    expect(statusLine).not.toContain('🌗');
    expect(statusLine).not.toContain('🌘');
  });

  it('renders terminal total status lines after the tool call ends', () => {
    const completed = createComponent();
    registerSubagents(completed, 1);
    completed.markInputComplete();
    completed.markCompleted('agent-1', 'Imports are stable');
    completed.markToolCallEnded();

    expect(renderLines(completed, 80).some((line) => line.startsWith('  ✓ Completed.'))).toBe(true);

    const failed = createComponent();
    registerSubagents(failed, 1);
    failed.markInputComplete();
    failed.markFailed('agent-1', 'Agent timed out');
    failed.markToolCallEnded();

    expect(renderLines(failed, 80).some((line) => line.startsWith('  ✗ Failed.'))).toBe(true);

    const aborted = createComponent();
    registerSubagents(aborted, 1);
    aborted.markInputComplete();
    aborted.markStarted('agent-1');
    aborted.markActiveCancelled();
    aborted.markToolCallEnded();

    const abortedOutput = renderText(aborted, 80);
    expect(abortedOutput).toContain('⊘ Aborted.');
    expect(abortedOutput).not.toContain('Cancelled.');
  });

  it('reserves one trailing cell for prompting streaming text', () => {
    const prompting = createComponent({
      description: '',
    });
    prompting.updateArgs({}, {
      streamingArguments: '{"prompt_template":"Review every changed TypeScript file and summarize regressions carefully before reporting',
    });

    const promptLine = renderLines(prompting, 50)
      .find((line) => line.includes('Prompting...'));

    expect(promptLine).toBeDefined();
    expect(visibleWidth(promptLine ?? '')).toBeLessThan(50);
  });

  it('renders boosted fractional progress ticks without leaking undefined cells', () => {
    vi.useFakeTimers();
    const component = createComponent();

    vi.setSystemTime(0);
    registerSubagents(component, 1);
    component.markStarted('agent-1');
    for (let index = 0; index < 10; index += 1) {
      vi.setSystemTime(1_000 + index * 1_000);
      component.recordToolCall({ agentId: 'agent-1', toolCallId: `done-${index}` });
    }
    vi.setSystemTime(40_000);
    component.markCompleted('agent-1');

    component.registerSubagent({
      agentId: 'agent-2',
      description: `${DEFAULT_DESCRIPTION} #2 (coder)`,
    });
    component.markStarted('agent-2');
    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(45_000 + index * 5_000);
      component.recordToolCall({ agentId: 'agent-2', toolCallId: `running-${index}` });
    }

    vi.setSystemTime(60_000);
    component.render(100);
    vi.setSystemTime(61_000);
    const output = renderText(component);

    expect(output).toContain('002 [');
    expect(output).not.toContain('undefined');
  });

  it('creates pending rows from streamed args items', () => {
    const component = createComponent({
      description: '',
    });

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const output = renderText(component);

    expect(output).toContain('Agent Swarm');
    expect(output).toContain('Review changed files');
    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 src/b.ts');
  });

  it('creates pending rows from resume_agent_ids before streamed args items', () => {
    const component = createComponent({
      description: '',
    });

    component.updateArgs({
      description: 'Review changed files',
      resume_agent_ids: {
        'agent-old-1': 'continue',
        'agent-old-2': 'continue',
      },
      items: ['src/a.ts'],
    });
    const output = renderText(component);

    expect(output).toContain('001 (resumed)');
    expect(output).toContain('002 (resumed)');
    expect(output).toContain('003 src/a.ts');
    expect(output).not.toContain('001 [');
  });

  it('counts partial items before each string is complete', () => {
    expect(
      agentSwarmPartialItemsCountFromArguments('{"items":["src/a.ts","src/b'),
    ).toBe(2);
    expect(
      agentSwarmPartialItemsCountFromArguments('{"items":["src/a.ts","src/\\"b.ts","src/c'),
    ).toBe(3);
    expect(
      agentSwarmPartialItemsFromArguments('{"items":["src/a.ts","src/\\"b.ts","src/c'),
    ).toEqual(['src/a.ts', 'src/"b.ts', 'src/c']);
  });

  it('creates pending rows from partial streaming arguments', () => {
    const component = createComponent({
      description: '',
    });

    component.updateArgs({}, {
      streamingArguments: '{"description":"Review changed files","items":["src/a.ts","src/b',
    });
    const output = renderText(component);

    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 src/b');
  });

  it('creates pending rows from partial streaming resume_agent_ids', () => {
    const component = createComponent({
      description: '',
    });

    component.updateArgs({}, {
      streamingArguments:
        '{"description":"Resume reviews","resume_agent_ids":{"agent-old-1":"continue","agent-old-2":"cont',
    });
    const output = renderText(component);

    expect(output).toContain('001 (resumed)');
    expect(output).toContain('002 (resumed)');
    expect(output).not.toContain('003');
  });

  it('adds subagent rows incrementally as spawn events arrive', () => {
    const component = createComponent();

    registerSubagents(component, 1);
    let output = renderText(component);
    expect(output).toContain('001 Queued...');
    expect(output).not.toContain('001 [');
    expect(output).not.toContain('002');

    component.registerSubagent({
      agentId: 'agent-2',
      description: `${DEFAULT_DESCRIPTION} #2 (coder)`,
    });
    output = renderText(component);
    expect(output).toContain('001 Queued...');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('001 [');
    expect(output).not.toContain('002 [');

    component.markInputComplete();
    output = renderText(component);
    expect(output).toContain('001 Queued...');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('001 [');
  });

  it('maps subagents by structured swarm indexes when descriptions include issue references', () => {
    const component = createComponent({
      description: 'Fix #123',
    });

    component.updateArgs({
      description: 'Fix #123',
      items: ['src/a.ts', 'src/b.ts'],
    });
    component.registerSubagent({
      agentId: 'agent-2',
      description: 'Fix #123 #2 (coder)',
      swarmIndex: 2,
    });
    component.markStarted('agent-2');

    const output = renderText(component);

    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 [');
    expect(output).not.toContain('123 [');
  });

  it('extracts description and item list from AgentSwarm args', () => {
    const args = {
      description: 'Review changed files',
      items: ['src/a.ts', 123],
    };

    expect(agentSwarmDescriptionFromArgs(args)).toBe('Review changed files');
    expect(agentSwarmItemsFromArgs(args)).toEqual(['src/a.ts', '123']);
  });
});

describe('AgentSwarmProgressEstimator', () => {
  it('counts a started subagent as one progress tick before tool calls arrive', () => {
    const estimator = new AgentSwarmProgressEstimator();

    estimator.markStarted('001', 0);
    const estimate = estimator.estimate({
      memberKey: '001',
      phase: 'running',
      capacityTicks: 56,
      nowMs: 1_000,
    });

    expect(estimate.rawTicks).toBe(1);
    expect(estimate.displayTicks).toBe(1);
  });

  it('keeps raw tool-call ticks without completed samples and deduplicates calls', () => {
    const estimator = new AgentSwarmProgressEstimator();

    estimator.markStarted('001', 0);
    expect(
      estimator.recordToolCall({ memberKey: '001', toolCallId: 'read', nowMs: 1_000 }),
    ).toEqual({ accepted: true, rawTicks: 2 });
    expect(
      estimator.recordToolCall({ memberKey: '001', toolCallId: 'read', nowMs: 2_000 }),
    ).toEqual({ accepted: false, rawTicks: 2 });

    const estimate = estimator.estimate({
      memberKey: '001',
      phase: 'running',
      capacityTicks: 56,
      nowMs: 3_000,
    });

    expect(estimate.rawTicks).toBe(2);
    expect(estimate.displayTicks).toBe(2);
    expect(estimate.estimatedTotalToolCalls).toBeUndefined();
    expect(estimate.boosted).toBe(false);
  });

  it('does not catch up progress using queued wait before start', () => {
    const estimator = new AgentSwarmProgressEstimator({
      catchupTimeMs: 1_000,
      maxCatchupTicksPerSecond: 100,
    });

    estimator.markStarted('001', 0);
    for (let index = 0; index < 10; index += 1) {
      estimator.recordToolCall({
        memberKey: '001',
        toolCallId: `done-${index}`,
        nowMs: 1_000 + index * 1_000,
      });
    }
    estimator.markCompleted('001', 40_000);

    estimator.ensureMember('002', 0);
    estimator.estimate({
      memberKey: '002',
      phase: 'queued',
      capacityTicks: 56,
      nowMs: 0,
    });
    estimator.markStarted('002', 60_000);

    const estimate = estimator.estimate({
      memberKey: '002',
      phase: 'running',
      capacityTicks: 56,
      nowMs: 60_000,
    });

    expect(estimate.rawTicks).toBe(1);
    expect(estimate.displayTicks).toBe(1);
    expect(estimate.targetTicks).toBeGreaterThan(1);
    expect(estimate.boosted).toBe(false);
  });

  it('smoothly catches up toward completed-agent estimates without jumping to them', () => {
    const estimator = new AgentSwarmProgressEstimator({
      catchupTimeMs: 1_000,
      maxCatchupTicksPerSecond: 100,
    });

    estimator.markStarted('001', 0);
    for (let index = 0; index < 10; index += 1) {
      estimator.recordToolCall({
        memberKey: '001',
        toolCallId: `done-${index}`,
        nowMs: 1_000 + index * 1_000,
      });
    }
    estimator.markCompleted('001', 40_000);

    estimator.markStarted('002', 0);
    for (let index = 0; index < 3; index += 1) {
      estimator.recordToolCall({
        memberKey: '002',
        toolCallId: `running-${index}`,
        nowMs: 5_000 + index * 5_000,
      });
    }

    const first = estimator.estimate({
      memberKey: '002',
      phase: 'running',
      capacityTicks: 56,
      nowMs: 20_000,
    });

    expect(first.rawTicks).toBe(4);
    expect(first.displayTicks).toBe(4);
    expect(first.estimatedTotalToolCalls).toBeGreaterThan(4);
    expect(first.targetTicks).toBeGreaterThan(4);
    expect(estimator.hasPendingCatchup()).toBe(true);

    const second = estimator.estimate({
      memberKey: '002',
      phase: 'running',
      capacityTicks: 56,
      nowMs: 21_000,
    });

    expect(second.displayTicks).toBeGreaterThan(4);
    expect(second.displayTicks).toBeLessThan(second.targetTicks ?? 0);
    expect(second.boosted).toBe(true);
  });
});
