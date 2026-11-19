import { describe, expect, it } from 'vitest';
import { parseSwarmResult } from '../src/lib/parseSwarmResult';
import { textAttributes } from '../src/lib/textElements';
import { toolChip } from '../src/lib/toolText';

describe('linear metadata and tool text scanning', () => {
  it('reads attributes', () => {
    expect(textAttributes('id="a" broken x="b" id="c" empty=""')).toEqual({ id: 'c', x: 'b', empty: '' });
  });

  it.each(['<summary>', '<resume_hint>', '<subagent '])('handles repeated unclosed swarm tags (%s)', (tag) => {
    const started = performance.now();
    expect(parseSwarmResult('<agent_swarm_result>' + tag.repeat(30_000))).toMatchObject({ summary: '', subagents: [] });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('handles long malformed swarm attributes', () => {
    const started = performance.now();
    const result = parseSwarmResult(`<agent_swarm_result><subagent ${'a'.repeat(200_000)}>body</subagent>`);
    expect(result?.subagents[0]?.body).toBe('body');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('retains tool counts without rescanning digit runs', () => {
    const started = performance.now();
    const digits = '1'.repeat(200_000);
    expect(toolChip((key) => key, { name: 'edit', arg: '', output: ['+' + digits] })).toBe('+' + digits);
    expect(toolChip((key) => key, { name: 'edit', arg: '', output: ['+12 -3 -4'] })).toBe('+12 −4');
    expect(toolChip((key) => key, { name: 'edit', arg: '', output: [''], status: 'ok' })).toBe('tools.chip.edited');
    expect(toolChip((key) => key, { name: 'edit', arg: '', output: [''], status: 'cancelled' })).toBe('');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
