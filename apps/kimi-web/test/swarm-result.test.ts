import { describe, expect, it } from 'vitest';
import { parseSwarmResult } from '../src/lib/parseSwarmResult';

describe('parseSwarmResult', () => {
  it('returns null when the payload is not an agent_swarm_result', () => {
    expect(parseSwarmResult('all done')).toBeNull();
    expect(parseSwarmResult(undefined)).toBeNull();
    expect(parseSwarmResult([])).toBeNull();
  });

  it('parses the summary counts and each subagent outcome', () => {
    const output = [
      '<agent_swarm_result>',
      '<summary>completed: 2, failed: 1</summary>',
      '<subagent item="alpha" agent_id="a1" outcome="completed">first body</subagent>',
      '<subagent item="beta" agent_id="a2" outcome="completed">second body</subagent>',
      '<subagent item="gamma" outcome="failed">boom</subagent>',
      '</agent_swarm_result>',
    ];
    const result = parseSwarmResult(output);
    expect(result).not.toBeNull();
    expect(result?.summary).toBe('completed: 2, failed: 1');
    expect(result?.completed).toBe(2);
    expect(result?.failed).toBe(1);
    expect(result?.aborted).toBe(0);
    expect(result?.total).toBe(3);
    expect(result?.subagents).toEqual([
      { outcome: 'completed', item: 'alpha', agentId: 'a1', body: 'first body' },
      { outcome: 'completed', item: 'beta', agentId: 'a2', body: 'second body' },
      { outcome: 'failed', item: 'gamma', body: 'boom' },
    ]);
  });

  it('unescapes the item attribute and captures the resume hint', () => {
    const text = [
      '<agent_swarm_result>',
      '<summary>completed: 0, failed: 1, aborted: 0</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent item="a &amp; b" mode="resume" agent_id="a9" state="started" outcome="failed">err</subagent>',
      '</agent_swarm_result>',
    ].join('\n');
    const result = parseSwarmResult(text);
    expect(result?.resumeHint).toContain('resume_agent_ids');
    expect(result?.subagents[0]?.item).toBe('a & b');
    expect(result?.subagents[0]?.mode).toBe('resume');
    expect(result?.subagents[0]?.state).toBe('started');
  });
});
