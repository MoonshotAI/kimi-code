import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type {
  HostProcessOptions,
  IHostProcess,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import { stubAgentEnvironment } from '../../../../environment/stubs';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: HostProcessOptions | undefined;
}

function notImplemented(method: string): never {
  throw new Error(`not implemented: ${method}`);
}

function directoryStat(): HostFileStat {
  return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
}

function fakeProcess(exitCode: number, stdoutText: string): IHostProcess {
  return {
    _serviceBrand: undefined,
    pid: 4242,
    exitCode,
    stdin: new Writable({
      write: (_chunk, _encoding, callback) => {
        callback();
      },
    }),
    stdout: Readable.from([Buffer.from(stdoutText)]),
    stderr: Readable.from([]),
    wait: async () => exitCode,
    kill: async () => {},
    dispose: () => {},
  };
}

function createBackend(calls: SpawnCall[]): FakeEnvironment {
  const processService: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args = [], options) => {
      calls.push({ command, args, options });
      if (args[0] === '--version') return fakeProcess(0, 'ripgrep 15.0.0\n');
      return fakeProcess(0, 'src/a.ts\n');
    },
  };
  const fs: IHostFileSystem = {
    _serviceBrand: undefined,
    readText: () => notImplemented('readText'),
    writeText: () => notImplemented('writeText'),
    appendText: () => notImplemented('appendText'),
    readBytes: () => notImplemented('readBytes'),
    writeBytes: () => notImplemented('writeBytes'),
    readLines: () => notImplemented('readLines'),
    createExclusive: () => notImplemented('createExclusive'),
    stat: async () => directoryStat(),
    lstat: async () => directoryStat(),
    readdir: () => notImplemented('readdir'),
    mkdir: () => notImplemented('mkdir'),
    remove: () => notImplemented('remove'),
    realpath: async (path: string) => path,
  };
  return Object.assign(
    new FakeEnvironment(
      { environmentId: 'ssh-dev', generation: randomUUID() },
      { capabilities: ['fs', 'process'], host: { homeDir: '/home/remote' } },
    ),
    { process: processService, fs },
  );
}

async function finish(execution: ToolExecution): Promise<ExecutableToolResult> {
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_glob',
    signal: new AbortController().signal,
  });
}

describe('GlobTool rg probe', () => {
  it('spawns the rg probe and the rg run in the session workspace cwd', async () => {
    const calls: SpawnCall[] = [];
    const result = await finish(
      new GlobTool(
        stubAgentEnvironment(createBackend(calls)),
        stubWorkspaceContext('/workspace'),
        noopTelemetryService,
      ).resolveExecution({ pattern: '**/*.ts' }),
    );

    expect(result.isError).not.toBe(true);
    expect(typeof result.output === 'string' && result.output).toContain('src/a.ts');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toMatchObject({ command: 'rg', args: ['--version'] });
    for (const call of calls) {
      expect(call.options?.cwd).toBe('/workspace');
    }
  });
});
