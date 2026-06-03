import { describe, expect, it, vi } from 'vitest';

import {
  AgentSwarmProgressComponent,
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
} from '#/tui/components/messages/agent-swarm-progress';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('AgentSwarmProgressComponent', () => {
  it('renders an orchestrating panel before subagents spawn', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('Agent swarm: Review changed files');
    expect(output).toContain('Orchestrating...');
    expect(output).not.toContain('01');
  });

  it('renders spawned subagents as text-only spawning rows', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('agents=2');
    expect(output).toContain('running=2');
    expect(output).toContain('01 Spawning...');
    expect(output).toContain('02 Spawning...');
    expect(output).not.toContain('01 [');
  });

  it('advances one step when a subagent tool call starts and marks terminal states', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });

    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('01 [');
    expect(output).toContain('Working');
    expect(output).toContain('02 Spawning...');

    component.markCompleted('agent-1');
    component.markFailed('agent-2');

    output = strip(component.render(100).join('\n'));
    expect(output).toContain('complete=1');
    expect(output).toContain('failed=1');
    expect(output).toContain('01 [');
    expect(output).toContain('Completed');
    expect(output).toContain('02 [');
    expect(output).toContain('Failed');
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
    expect(output).toContain('01 [');
    expect(output).toContain('Reviewing');
    expect(output).toContain('…');
    expect(output).not.toContain('Working');
  });

  it('switches spawned rows to animated spawning once AgentSwarm input is complete', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
      requestRender,
    });

    try {
      component.registerSubagent({
        agentId: 'agent-1',
        description: 'Review changed files #1 (coder)',
      });
      let output = strip(component.render(100).join('\n'));
      expect(output).toContain('01 Spawning...');
      expect(output).not.toContain('01 [');

      component.markInputComplete();
      output = strip(component.render(100).join('\n'));
      expect(output).toContain('01 [');
      expect(output).toContain('Spawning');

      const before = output;
      vi.advanceTimersByTime(80);
      const after = strip(component.render(100).join('\n'));
      expect(requestRender).toHaveBeenCalled();
      expect(after).not.toBe(before);
    } finally {
      component.dispose();
      vi.useRealTimers();
    }
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

    expect(output).toContain('Agent swarm: Review changed files');
    expect(output).toContain('agents=2');
    expect(output).toContain('01 src/a.ts');
    expect(output).toContain('02 src/b.ts');
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

    expect(output).toContain('agents=2');
    expect(output).toContain('01 src/a.ts');
    expect(output).toContain('02 src/b');
  });

  it('adds subagent rows incrementally as spawn events arrive', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('agents=1');
    expect(output).toContain('01 Spawning...');
    expect(output).not.toContain('02');

    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    output = strip(component.render(100).join('\n'));
    expect(output).toContain('agents=2');
    expect(output).toContain('02 Spawning...');
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
