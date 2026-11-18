import { describe, expect, it } from 'vitest';

import { makeSessionContext } from '../../agent-core-v2/src/session/sessionContext/sessionContext';
import type { IHostProcess, IHostProcessService } from '@moonshot-ai/agent-core-v2';

import type { IAcpConnection, IAcpTerminalHandle } from '../src/acp-fs/acpConnection';
import { AcpProcessOverride } from '../src/acp-terminal/acpTerminalRunner';

function makeConnection(
  options: { terminalEnabled?: boolean; createTerminal?: () => IAcpTerminalHandle } = {},
): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: true,
    fsWriteTextFile: true,
    terminalEnabled: options.terminalEnabled ?? true,
    bind: () => {},
    get: () => ({ createTerminal: async () => options.createTerminal?.() }) as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
}

function makeTerminalHandle(): IAcpTerminalHandle {
  return {
    id: 'term-1',
    currentOutput: async () => ({ output: '', truncated: false }),
    waitForExit: async () => ({ exitCode: 0 }),
    kill: async () => ({}),
    release: async () => ({}),
  };
}

const session = makeSessionContext({
  sessionId: 's1',
  workspaceId: 'workspace',
  sessionDir: '/session',
  sessionScope: 'sessions/s1',
  cwd: '/repo',
});

const bashEnv = { NO_COLOR: '1', TERM: 'dumb' };

describe('AcpProcessOverride', () => {
  it('routes Bash-shaped spawns through the ACP terminal', async () => {
    let created = 0;
    const connection = makeConnection({
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    });
    const local = { _serviceBrand: undefined, spawn: async () => ({}) as IHostProcess };
    const process = new AcpProcessOverride(session, connection, local);

    await process.spawn('/bin/bash', ['-c', 'echo hi'], { env: { ...bashEnv } });
    expect(created).toBe(1);
  });

  it('delegates non-Bash spawns to the original process service', async () => {
    let created = 0;
    const calls: string[] = [];
    const local = {
      _serviceBrand: undefined,
      spawn: async (command: string) => {
        calls.push(command);
        return {} as IHostProcess;
      },
    };
    const process = new AcpProcessOverride(session, makeConnection({
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    }), local);

    await process.spawn('rg', ['--files']);
    expect(calls).toEqual(['rg']);
    expect(created).toBe(0);
  });

  it('keeps the original process without the terminal capability', () => {
    const local = { _serviceBrand: undefined, spawn: async () => ({}) as IHostProcess };
    const process = new AcpProcessOverride(session, makeConnection({ terminalEnabled: false }), local);
    expect(process.delegate).toBe(local);
  });
});
