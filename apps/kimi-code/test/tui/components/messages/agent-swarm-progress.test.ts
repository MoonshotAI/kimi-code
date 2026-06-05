import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import {
  AgentSwarmProgressComponent,
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
} from '#/tui/components/messages/agent-swarm-progress';
import { AgentSwarmProgressEstimator } from '#/tui/components/messages/agent-swarm-progress-estimator';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function withAnsiColor<T>(run: () => T): T {
  const previousChalkLevel = chalk.level;
  chalk.level = 3;
  try {
    return run();
  } finally {
    chalk.level = previousChalkLevel;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentSwarmProgressComponent', () => {
  it('renders an orchestrating panel before subagents spawn', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('Agent swarm');
    expect(output).toContain('Review changed files');
    expect(output).toContain('Orchestrating...');
    expect(output).not.toContain('01');
  });

  it('renders a trailing blank line without a bottom divider', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    const lines = strip(component.render(100).join('\n')).split('\n');

    expect(lines.at(-1)).toBe(' ');
    expect(lines.at(-2)).toContain('Orchestrating...');
    expect(lines.at(-2)).not.toMatch(/^─+$/);
  });

  it('reserves one blank column on the right edge', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markInputComplete();
    component.markStarted('agent-1');

    const rendered = component.render(80).map(strip);

    expect(rendered.every((line) => visibleWidth(line) <= 79)).toBe(true);
    expect(rendered.some((line) => line.includes('Agent swarm'))).toBe(true);
    expect(rendered.some((line) => line.includes('Working...'))).toBe(true);
  });

  it('renders orchestrating and prompting labels in primary blue', () => {
    withAnsiColor(() => {
      const orchestrating = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });

      const orchestratingLine = orchestrating.render(100).join('\n')
        .split('\n')
        .find((line) => line.includes('Orchestrating...'));
      expect(orchestratingLine).toContain(chalk.hex(darkColors.primary)('Orchestrating...'));

      const prompting = new AgentSwarmProgressComponent({
        description: '',
        colors: darkColors,
      });
      prompting.updateArgs({}, {
        streamingArguments: '{"prompt_template":"Review every changed TypeScript file',
      });

      const promptingLine = prompting.render(100).join('\n')
        .split('\n')
        .find((line) => line.includes('Prompting...'));
      expect(promptingLine).toContain(chalk.hex(darkColors.primary)('Prompting...'));
    });
  });

  it('renders spawned subagents as queued rows without empty progress bars', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('001 Queued...');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('001 [');
    expect(output).not.toContain('002 [');
    expect(output).not.toContain('agents=2');
  });

  it('renders agent ids in primary blue', () => {
    withAnsiColor(() => {
      const component = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });

      component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      const queuedLine = component.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).startsWith(' 001 Queued...'));
      expect(queuedLine).toContain(chalk.hex(darkColors.primary)('001'));

      component.markInputComplete();
      component.markStarted('agent-1');
      const activeLine = component.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).startsWith(' 001 ['));
      expect(activeLine).toContain(chalk.hex(darkColors.primary)('001'));
    });
  });

  it('renders a blank line above the AgentSwarm header', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });

    const lines = strip(component.render(100).join('\n')).split('\n');

    expect(lines[0]).toBe(' ');
    expect(lines[1]).toContain('Agent swarm');
  });

  it('fits three queued columns with the narrower gap and minimum cell width', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    component.registerSubagent({ agentId: 'agent-3', description: 'Review changed files #3 (coder)' });

    const lines = strip(component.render(96).join('\n')).split('\n');
    const queuedLine = lines.find((line) => line.includes('001 Queued...'));

    expect(queuedLine).toBeDefined();
    expect(queuedLine).toContain('002 Queued...');
    expect(queuedLine).toContain('003 Queued...');
  });

  it('advances from queued when a subagent tool call starts and marks terminal states', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });

    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Running');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('002 [');

    component.markCompleted('agent-1');
    component.markFailed('agent-2');

    output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('✓');
    expect(output).toContain('Completed.');
    expect(output).toContain('002 [');
    expect(output).toContain('Failed');
  });

  it('renders completed subagent output with a success mark', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markCompleted('agent-1', 'Reviewed imports and found no regressions');

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('✓ Reviewed imports and found no regressions');
    expect(output).toContain('Completed.');
  });

  it('renders failure details from live subagent failures', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markFailed('agent-1', 'Provider request failed\nRetry budget exhausted');

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('✗ Provider request failed Retry budget exhausted');
    expect(output).not.toContain('Failed:');
  });

  it('renders suspended subagents as queued and clears the state when they start again', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markStarted('agent-1');
    component.markSuspended({
      agentId: 'agent-1',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });

    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('Queued...');
    expect(output).not.toContain('Suspended');
    expect(output).not.toContain('Provider rate limit');
    expect(output).not.toContain('Failed');

    component.markStarted('agent-1');

    output = strip(component.render(100).join('\n'));
    expect(output).toContain('Running');
    expect(output).not.toContain('Suspended');
  });

  it('renders failure details from AgentSwarm result output', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

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

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('✗ Agent timed out after 30s.');
    expect(output).not.toContain('Failed:');
  });

  it('strips nested AgentSwarm prefixes from failure details', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

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

    const output = strip(component.render(120).join('\n'));

    expect(output).toContain('✗ [provider.rate_limit] 429 request reached user+model max RPM.');
    expect(output).not.toContain('agent_swarm:');
    expect(output).not.toContain('Failed:');
  });

  it('renders completed summaries from AgentSwarm result output', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

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

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('✓ Reviewed src/a.ts and confirmed imports are stable.');
    expect(output).toContain('Completed.');
  });

  it('shows completed total status when only some subagents fail', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

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

    const output = strip(component.render(120).join('\n'));
    const totalStatusLine = output.split('\n').find((line) => line.includes('Completed.'));

    expect(totalStatusLine).toBeDefined();
    expect(totalStatusLine).not.toContain('Failed.');
    expect(output).toContain('✓ Reviewed src/a.ts');
    expect(output).toContain('✗ Agent timed out after 30s.');
  });

  it('uses the latest assistant line as completed output when no summary is available', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.appendAssistantDelta({
      agentId: 'agent-1',
      delta: 'Reviewing src/a.ts\nImports look stable',
    });
    component.markCompleted('agent-1');

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('✓ Imports look stable');
    expect(output).toContain('Completed.');
  });

  it('shows latest assistant text after the progress bar with ellipsis truncation', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markInputComplete();
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });
    component.appendAssistantDelta({
      agentId: 'agent-1',
      delta: 'Reviewing src/a.ts and checking imports for regressions in detail',
    });

    const output = strip(component.render(44).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Reviewing');
    expect(output).toContain('…');
  });

  it('uses natural status label width for prompting text', () => {
    const prompting = new AgentSwarmProgressComponent({
      description: '',
      colors: darkColors,
    });
    prompting.updateArgs({}, {
      streamingArguments: '{"prompt_template":"Review the changed TypeScript files carefully',
    });

    const promptLine = strip(prompting.render(80).join('\n'))
      .split('\n')
      .find((line) => line.includes('Prompting...'));
    expect(promptLine).toBeDefined();

    const working = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });
    working.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    working.markInputComplete();
    working.markStarted('agent-1');

    const workingLine = strip(working.render(80).join('\n'))
      .split('\n')
      .find((line) => line.includes('Working...'));
    expect(workingLine).toBeDefined();

    const promptTextIndex = promptLine?.indexOf('Review the changed') ?? -1;
    const progressBarIndex = workingLine?.indexOf('━') ?? -1;
    expect(promptTextIndex).toBeGreaterThan(0);
    expect(progressBarIndex).toBeGreaterThan(0);
    expect(promptTextIndex).toBe(visibleWidth('  Prompting... '));
  });

  it('renders the activity spinner before the total status line', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markInputComplete();
    component.markStarted('agent-1');
    component.setActivitySpinnerText(() => '🌗');

    const statusLine = strip(component.render(80).join('\n'))
      .split('\n')
      .find((line) => line.includes('Working...'));

    expect(statusLine).toBeDefined();
    expect(statusLine?.startsWith(' 🌗  Working...')).toBe(true);
  });

  it('renders working label blue until a subagent completes, then green', () => {
    withAnsiColor(() => {
      const component = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });

      component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
      component.markInputComplete();
      component.markStarted('agent-1');
      component.markStarted('agent-2');

      const initialRawLine = component.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).includes('Working...'));
      expect(initialRawLine).toContain(chalk.hex(darkColors.primary)(' Working...'));

      component.markCompleted('agent-1');

      const partialRawLine = component.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).includes('Working...'));
      expect(partialRawLine).toContain(chalk.hex(darkColors.success)(' Working...'));
    });
  });

  it('keeps a two-cell placeholder after the AgentSwarm tool call ends', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markInputComplete();
    component.markStarted('agent-1');
    component.setActivitySpinnerText(() => '🌗');
    component.markToolCallEnded();
    component.setActivitySpinnerText(() => '🌘');

    const statusLine = strip(component.render(80).join('\n'))
      .split('\n')
      .find((line) => line.includes('Working...'));

    expect(statusLine).toBeDefined();
    expect(statusLine?.startsWith('     Working...')).toBe(true);
    expect(statusLine).not.toContain('🌗');
    expect(statusLine).not.toContain('🌘');
  });

  it('renders terminal status symbols in the same color as their labels', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      const completed = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });
      completed.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      completed.markInputComplete();
      completed.markCompleted('agent-1', 'Imports are stable');
      completed.setActivitySpinnerText(() => '🌗');
      completed.markToolCallEnded();
      completed.setActivitySpinnerText(() => '🌘');

      const completedRawLine = completed.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).startsWith('  ✓ Completed.'));
      const completedLine = completedRawLine === undefined ? undefined : strip(completedRawLine);
      expect(completedLine).toBeDefined();
      expect(completedLine?.startsWith('  ✓ Completed.')).toBe(true);
      expect(completedRawLine).toContain(chalk.hex(darkColors.success)('✓'));
      expect(completedLine).not.toContain('🌗');
      expect(completedLine).not.toContain('🌘');

      const failed = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });
      failed.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      failed.markInputComplete();
      failed.markFailed('agent-1', 'Agent timed out');
      failed.markToolCallEnded();

      const failedRawLine = failed.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).startsWith('  ✗ Failed.'));
      const failedLine = failedRawLine === undefined ? undefined : strip(failedRawLine);
      expect(failedLine).toBeDefined();
      expect(failedLine?.startsWith('  ✗ Failed.')).toBe(true);
      expect(failedRawLine).toContain(chalk.hex(darkColors.error)('✗'));

      const cancelled = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });
      cancelled.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      cancelled.markInputComplete();
      cancelled.markStarted('agent-1');
      cancelled.markCancelled('agent-1');
      cancelled.markToolCallEnded();

      const cancelledOutput = cancelled.render(80).join('\n');
      expect(strip(cancelledOutput)).not.toContain('Cancelled.');

      const cancelledRawLine = cancelledOutput
        .split('\n')
        .find((line) => strip(line).startsWith('  ⊘ Aborted.'));
      const cancelledLine = cancelledRawLine === undefined ? undefined : strip(cancelledRawLine);
      expect(cancelledLine).toBeDefined();
      expect(cancelledLine?.startsWith('  ⊘ Aborted.')).toBe(true);
      expect(cancelledLine).not.toContain('Cancelled.');
      expect(cancelledRawLine).toContain(chalk.hex(darkColors.warning)('⊘'));

      const aborted = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: darkColors,
      });
      aborted.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      aborted.markInputComplete();
      aborted.markStarted('agent-1');
      aborted.markActiveCancelled();
      aborted.markToolCallEnded();

      const abortedRawLine = aborted.render(80).join('\n')
        .split('\n')
        .find((line) => strip(line).startsWith('  ⊘ Aborted.'));
      const abortedLine = abortedRawLine === undefined ? undefined : strip(abortedRawLine);
      expect(abortedLine).toBeDefined();
      expect(abortedLine?.startsWith('  ⊘ Aborted.')).toBe(true);
      expect(abortedRawLine).toContain(chalk.hex(darkColors.warning)('⊘'));
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('reserves one trailing cell for prompting streaming text', () => {
    const prompting = new AgentSwarmProgressComponent({
      description: '',
      colors: darkColors,
    });
    prompting.updateArgs({}, {
      streamingArguments: '{"prompt_template":"Review every changed TypeScript file and summarize regressions carefully before reporting',
    });

    const promptLine = strip(prompting.render(50).join('\n'))
      .split('\n')
      .find((line) => line.includes('Prompting...'));

    expect(promptLine).toBeDefined();
    expect(visibleWidth(promptLine ?? '')).toBe(48);
  });

  it('renders boosted fractional progress ticks without leaking undefined cells', () => {
    vi.useFakeTimers();
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    vi.setSystemTime(0);
    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markStarted('agent-1');
    for (let index = 0; index < 10; index += 1) {
      vi.setSystemTime(1_000 + index * 1_000);
      component.recordToolCall({ agentId: 'agent-1', toolCallId: `done-${index}` });
    }
    vi.setSystemTime(40_000);
    component.markCompleted('agent-1');

    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    component.markStarted('agent-2');
    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(45_000 + index * 5_000);
      component.recordToolCall({ agentId: 'agent-2', toolCallId: `running-${index}` });
    }

    vi.setSystemTime(60_000);
    component.render(100);
    vi.setSystemTime(61_000);
    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('002 [');
    expect(output).not.toContain('undefined');
  });

  it('keeps spawned rows queued when AgentSwarm input completes', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({
      agentId: 'agent-1',
      description: 'Review changed files #1 (coder)',
    });
    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 Queued...');
    expect(output).not.toContain('001 [');

    component.markInputComplete();
    output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 Queued...');
    expect(output).not.toContain('001 [');
  });

  it('creates pending rows from streamed args items', () => {
    const component = new AgentSwarmProgressComponent({
      description: '',
      colors: darkColors,
    });

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('Agent swarm');
    expect(output).toContain('Review changed files');
    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 src/b.ts');
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
    const component = new AgentSwarmProgressComponent({
      description: '',
      colors: darkColors,
    });

    component.updateArgs({}, {
      streamingArguments: '{"description":"Review changed files","items":["src/a.ts","src/b',
    });
    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 src/b');
  });

  it('adds subagent rows incrementally as spawn events arrive', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 Queued...');
    expect(output).not.toContain('001 [');
    expect(output).not.toContain('002');

    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 Queued...');
    expect(output).toContain('002 Queued...');
    expect(output).not.toContain('001 [');
    expect(output).not.toContain('002 [');
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

  it('excludes queued wait time from completed work samples', () => {
    const estimator = new AgentSwarmProgressEstimator();

    estimator.ensureMember('001', 0);
    estimator.markStarted('001', 60_000);
    estimator.recordToolCall({ memberKey: '001', toolCallId: 'read', nowMs: 61_000 });
    estimator.markQueued('001', 62_000);
    estimator.markStarted('001', 122_000);
    estimator.recordToolCall({ memberKey: '001', toolCallId: 'write', nowMs: 123_000 });
    estimator.markCompleted('001', 124_000);

    const samples = (
      estimator as unknown as {
        completedSamples(): Array<{ totalMs: number; rawTicks: number }>;
      }
    ).completedSamples();
    expect(samples).toEqual([{ totalMs: 4_000, rawTicks: 3 }]);
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
