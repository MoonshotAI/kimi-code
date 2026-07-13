import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  rate_limits: [],
};

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  it('terminates the whole shell process tree on timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-status-line-'));
    const pidFile = join(dir, 'child.pid');
    let childPid: number | undefined;
    try {
      const writer = nodeCommand(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      const relay = nodeCommand('process.stdin.resume();');

      const result = await runStatusLineCommand({
        command: `${writer} | ${relay}`,
        timeoutMs: 50,
        payload,
      });

      expect(result).toBeNull();
      childPid = Number(await readFile(pidFile, 'utf8'));
      await expect.poll(() => isProcessAlive(childPid!), { timeout: 500 }).toBe(false);
    } finally {
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, 'SIGKILL');
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
