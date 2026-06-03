import { describe, expect, it } from 'vitest';

import {
  AgentSwarmProgressComponent,
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
} from '#/tui/components/messages/agent-swarm-progress';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('AgentSwarmProgressComponent', () => {
  it('renders a full swarm panel with title, summary, and rows', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
      colors: darkColors,
    });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('Agent swarm: Review changed files');
    expect(output).toContain('agents=2');
    expect(output).toContain('running=2');
    expect(output).toContain('swarm-001:  Spawning');
    expect(output).toContain('swarm-002:  Spawning');
  });

  it('advances one step for each subagent tool call and marks terminal states', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });
    component.markCompleted('agent-1');
    component.markFailed('agent-2');

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('complete=1');
    expect(output).toContain('failed=1');
    expect(output).toContain('swarm-001: Completed');
    expect(output).toContain('swarm-002:    Failed');
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
