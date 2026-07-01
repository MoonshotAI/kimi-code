import { describe, expect, it } from 'vitest';
import { createAgentProjector, subagentProgressText } from '../src/api/daemon/agentEventProjector';

describe('subagentProgressText', () => {
  it('drops turn.step.started as noise', () => {
    expect(subagentProgressText('turn.step.started', {})).toBeNull();
  });

  it('summarizes a read tool call with its path', () => {
    const text = subagentProgressText('tool.use', { name: 'read', args: { path: 'src/foo.ts' } });
    expect(text).toContain('src/foo.ts');
    expect(text).not.toContain('"path"');
  });

  it('summarizes a bash tool call with its command', () => {
    const text = subagentProgressText('tool.call.started', { name: 'bash', args: { command: 'pnpm test' } });
    expect(text).toContain('pnpm test');
    expect(text).not.toContain('"command"');
  });

  it('drops tool.result lines as noise', () => {
    expect(subagentProgressText('tool.result', { name: 'read' })).toBeNull();
    expect(subagentProgressText('tool.result', { name: 'Read_0' })).toBeNull();
  });

  it('returns tool.progress update text', () => {
    expect(subagentProgressText('tool.progress', { update: { text: 'working…' } })).toBe('working…');
  });

  it('caps a long tool.progress text', () => {
    const long = 'x'.repeat(3000);
    const text = subagentProgressText('tool.progress', { update: { text: long } });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(long.length);
    expect(text!.endsWith('…')).toBe(true);
  });

  it('returns null for unknown event types', () => {
    expect(subagentProgressText('turn.delta', {})).toBeNull();
  });
});

describe('subagent streaming text', () => {
  it('forwards a subagent assistant.delta as a text-kind taskProgress', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: 'Hello' }, 's1');
    expect(events).toContainEqual({
      type: 'taskProgress',
      sessionId: 's1',
      taskId: 'sub-1',
      outputChunk: 'Hello',
      stream: 'stdout',
      kind: 'text',
    });
  });

  it('drops an empty subagent assistant.delta', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: '' }, 's1');
    expect(events).toEqual([]);
  });
});
