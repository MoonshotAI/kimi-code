import { describe, expect, it } from 'vitest';
import { agentResultBody } from '../src/lib/parseAgentToolResult';

describe('agentResultBody', () => {
  it('hides the background launch receipt', () => {
    expect(
      agentResultBody([
        [
          'task_id: agent-x9h4raoi',
          'status: running',
          'agent_id: agent-9',
          'actual_subagent_type: coder',
          'automatic_notification: true',
          '',
          'description: test',
          '',
          'next_step: The completion arrives automatically in a later turn.',
          'resume_hint: To continue or recover this same subagent later, call Agent(resume="agent-9", prompt="...").',
        ].join('\n'),
      ]),
    ).toEqual([]);
  });

  it('keeps only the summary of a finished agent', () => {
    expect(
      agentResultBody([
        [
          'agent_id: agent-1',
          'actual_subagent_type: explore',
          'status: completed',
          'stop_reason: completed',
          '',
          '[summary]',
          'Found 3 files.',
          '',
          'next_step: none here',
          '- a.ts',
          '',
          'resume_hint: Continue with Agent(resume="agent-1", prompt="...").',
        ].join('\n'),
      ]),
    ).toEqual(['Found 3 files.', '', 'next_step: none here', '- a.ts']);
  });

  it('keeps the summary before a trailing next_step', () => {
    expect(
      agentResultBody([
        'agent_id: agent-1\nstatus: completed\nstop_reason: repeat_breaker\nnotice: stopped\n\n[summary]\nPartial.\n\nresume_hint: Continue.\nnext_step: Change the instructions.',
      ]),
    ).toEqual(['Partial.']);
  });

  it('keeps only the error message of a failed agent', () => {
    expect(
      agentResultBody([
        'agent_id: agent-2\nactual_subagent_type: coder\nstatus: failed\nstop_reason: error\n\nsubagent error: Boom\nresume_hint: Continue.\nnext_step: Resume.',
      ]),
    ).toEqual(['Boom']);
  });

  it('leaves unrecognised output unchanged', () => {
    expect(agentResultBody(['Background agents are unavailable.'])).toEqual([
      'Background agents are unavailable.',
    ]);
    expect(agentResultBody(undefined)).toEqual([]);
  });
});
