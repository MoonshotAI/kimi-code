import { Readable, type Writable } from 'node:stream';

import type { Environment, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
import { createBackgroundManager } from '../agent/background/helpers';
import { executeTool } from './fixtures/execute-tool';
import { createFakeKaos } from './fixtures/fake-kaos';

const posixEnv: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
};

function fakeProcess(): KaosProcess {
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 401,
    exitCode: 0,
    wait: vi.fn(async () => 0),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

const signal = new AbortController().signal;

async function captureSpawnEnv(): Promise<Record<string, string>> {
  const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
  const tool = new BashTool(
    createFakeKaos({ execWithEnv, osEnv: posixEnv }),
    '/workspace',
    createBackgroundManager().manager,
  );
  await executeTool(tool, {
    turnId: '0',
    toolCallId: 'tc_env',
    args: { command: 'true', timeout: 1000 },
    signal,
  });
  return execWithEnv.mock.calls[0]?.[1] as Record<string, string>;
}

describe('BashTool noninteractive env semantics', () => {
  it('preserves an existing GIT_TERMINAL_PROMPT from the ambient env', async () => {
    const previous = process.env['GIT_TERMINAL_PROMPT'];
    process.env['GIT_TERMINAL_PROMPT'] = '1';
    try {
      const env = await captureSpawnEnv();
      expect(env['GIT_TERMINAL_PROMPT']).toBe('1');
    } finally {
      if (previous === undefined) delete process.env['GIT_TERMINAL_PROMPT'];
      else process.env['GIT_TERMINAL_PROMPT'] = previous;
    }
  });

  it('defaults GIT_TERMINAL_PROMPT to "0" when the ambient env does not set it', async () => {
    const previous = process.env['GIT_TERMINAL_PROMPT'];
    delete process.env['GIT_TERMINAL_PROMPT'];
    try {
      const env = await captureSpawnEnv();
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    } finally {
      if (previous !== undefined) process.env['GIT_TERMINAL_PROMPT'] = previous;
    }
  });

  it('lets kaos-level env override BashTool env and observes in-place updates', async () => {
    const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
    const sessionEnv = {
      GIT_TERMINAL_PROMPT: 'configured',
      KIMI_CODE_ENV: 'initial',
    };
    const kaos = createFakeKaos({ execWithEnv, osEnv: posixEnv }).withEnv(sessionEnv);
    const tool = new BashTool(kaos, '/workspace', createBackgroundManager().manager);

    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_kaos_env_1',
      args: { command: 'true', timeout: 1000 },
      signal,
    });

    const firstEnv = execWithEnv.mock.calls[0]?.[1] as Record<string, string>;
    expect(firstEnv['GIT_TERMINAL_PROMPT']).toBe('configured');
    expect(firstEnv['KIMI_CODE_ENV']).toBe('initial');

    sessionEnv.KIMI_CODE_ENV = 'updated';
    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_kaos_env_2',
      args: { command: 'true', timeout: 1000 },
      signal,
    });

    const secondEnv = execWithEnv.mock.calls[1]?.[1] as Record<string, string>;
    expect(secondEnv['GIT_TERMINAL_PROMPT']).toBe('configured');
    expect(secondEnv['KIMI_CODE_ENV']).toBe('updated');
  });

  it('injects the sudo askpass env when a provider is wired', async () => {
    const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
      {
        sudoAskpass: {
          envFor: async (command) => ({
            SUDO_ASKPASS: '/session/sudo-askpass/helper.sh',
            KIMI_SUDO_ASKPASS_TOKEN: 'tok',
            KIMI_SUDO_ASKPASS_COMMAND: command,
          }),
        },
      },
    );
    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_askpass',
      args: { command: 'sudo true', timeout: 1000 },
      signal,
    });
    const env = execWithEnv.mock.calls[0]?.[1] as Record<string, string>;
    expect(env['SUDO_ASKPASS']).toBe('/session/sudo-askpass/helper.sh');
    expect(env['KIMI_SUDO_ASKPASS_TOKEN']).toBe('tok');
    expect(env['KIMI_SUDO_ASKPASS_COMMAND']).toBe('sudo true');
  });

  it('injects no askpass env when the provider declines or on Windows', async () => {
    const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
    const declining = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
      { sudoAskpass: { envFor: async () => undefined } },
    );
    await executeTool(declining, {
      turnId: '0',
      toolCallId: 'tc_askpass_off',
      args: { command: 'sudo true', timeout: 1000 },
      signal,
    });
    const env = execWithEnv.mock.calls[0]?.[1] as Record<string, string>;
    expect(env['SUDO_ASKPASS']).toBeUndefined();
    expect(env['KIMI_SUDO_ASKPASS_TOKEN']).toBeUndefined();

    const windowsEnv: Environment = {
      osKind: 'Windows',
      osArch: 'x64',
      osVersion: 'test',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      shellName: 'bash',
    };
    const onWindows = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: windowsEnv }),
      '/workspace',
      createBackgroundManager().manager,
      {
        sudoAskpass: {
          envFor: async () => ({ SUDO_ASKPASS: '/session/sudo-askpass/helper.sh' }),
        },
      },
    );
    await executeTool(onWindows, {
      turnId: '0',
      toolCallId: 'tc_askpass_win',
      args: { command: 'true', timeout: 1000 },
      signal,
    });
    const winEnv = execWithEnv.mock.calls[1]?.[1] as Record<string, string>;
    expect(winEnv['SUDO_ASKPASS']).toBeUndefined();
  });
});
