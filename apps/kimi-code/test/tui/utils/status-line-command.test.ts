import { describe, expect, it } from 'vitest';

import {
  runStatusLineCommand,
  type StatusLineCommandPayload,
} from '#/tui/utils/status-line-command';

const payload: StatusLineCommandPayload = {
  session_id: 'ses-1',
  model: 'kimi-k2',
  display_model: 'Kimi K2',
  cwd: '/tmp/project',
  permission_mode: 'manual',
  plan_mode: false,
  input_mode: 'prompt',
  swarm_mode: false,
  thinking_effort: 'off',
  context: {
    usage: 0.25,
    tokens: 1000,
    max_tokens: 4000,
  },
};

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe('runStatusLineCommand', () => {
  it('passes the payload on stdin and returns the first stdout line', async () => {
    const result = await runStatusLineCommand({
      command: nodeCommand(
        "let input='';process.stdin.on('data',(chunk)=>input+=chunk);process.stdin.on('end',()=>{const payload=JSON.parse(input);console.log(payload.model+' @ '+payload.cwd);console.log('ignored');});",
      ),
      timeoutMs: 500,
      payload,
    });

    expect(result).toBe('kimi-k2 @ /tmp/project');
  });

  it('returns null when the command times out', async () => {
    const result = await runStatusLineCommand({
      command: nodeCommand('setTimeout(() => {}, 1000);'),
      timeoutMs: 10,
      payload,
    });

    expect(result).toBeNull();
  });
});
