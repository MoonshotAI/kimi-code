import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import type { IHostFileSystem, HostFileStat } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { ensureRgPath } from '#/os/backends/node-local/tools/rgLocator';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import { stubWorkspaceContext } from '../../../session/workspaceContext/stub-workspace-context';
import { stubAgentEnvironment } from '../../../environment/stubs';

vi.mock('#/os/backends/node-local/tools/rgLocator', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('#/os/backends/node-local/tools/rgLocator')>();
  return { ...original, ensureRgPath: vi.fn() };
});

const ensureRgPathMock = vi.mocked(ensureRgPath);

const LOCAL_SHARE_BIN_RG = join(
  '/kimi-home-test',
  'bin',
  process.platform === 'win32' ? 'rg.exe' : 'rg',
);

function notImplemented(method: string): never {
  throw new Error(`not implemented: ${method}`);
}

function directoryStat(): HostFileStat {
  return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
}

function createBackend(options: {
  readonly environmentId: string;
  readonly homeDir: string;
  readonly spawn?: IHostProcessService['spawn'];
}): FakeEnvironment {
  const processService: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: options.spawn ?? (() => notImplemented('spawn')),
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
      { environmentId: options.environmentId, generation: 'test' },
      { capabilities: ['fs', 'process'], host: { homeDir: options.homeDir } },
    ),
    { process: processService, fs },
  );
}

async function finish(execution: ToolExecution): Promise<ExecutableToolResult> {
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_rg',
    signal: new AbortController().signal,
  });
}

const TOOLS: readonly {
  readonly name: string;
  readonly execute: (backend: FakeEnvironment) => Promise<ExecutableToolResult>;
}[] = [
  {
    name: 'GlobTool',
    execute: async (backend) =>
      finish(
        await new GlobTool(
          stubAgentEnvironment(backend),
          stubWorkspaceContext('/workspace'),
          noopTelemetryService,
        ).resolveExecution({ pattern: '**/*.ts' }),
      ),
  },
  {
    name: 'GrepTool',
    execute: async (backend) =>
      finish(
        await new GrepTool(
          stubAgentEnvironment(backend),
          stubWorkspaceContext('/workspace'),
          noopTelemetryService,
        ).resolveExecution({ pattern: 'needle' }),
      ),
  },
];

function outputOf(result: ExecutableToolResult): string {
  if (typeof result.output !== 'string') {
    throw new TypeError(`expected string output, got ${typeof result.output}`);
  }
  return result.output;
}

describe('rg-unavailable guidance', () => {
  let savedHome: string | undefined;
  beforeEach(() => {
    ensureRgPathMock.mockReset();
    savedHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/kimi-home-test';
  });
  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = savedHome;
    }
  });

  for (const { name, execute } of TOOLS) {
    describe(name, () => {
      it('keeps the local-binding guidance byte-identical', async () => {
        ensureRgPathMock.mockRejectedValue(new Error('boom'));
        const result = await execute(createBackend({ environmentId: 'local', homeDir: '/home/test' }));

        expect(result.isError).toBe(true);
        expect(outputOf(result)).toBe(
          'ripgrep (rg) is not available and the automatic bootstrap failed.\n' +
            '\n' +
            'Error: boom\n' +
            '\n' +
            'Fix options:\n' +
            '  macOS:   brew install ripgrep\n' +
            '  Ubuntu:  sudo apt-get install ripgrep\n' +
            '  Other:   https://github.com/BurntSushi/ripgrep#installation\n' +
            '\n' +
            `Alternatively, drop a static rg binary at ${LOCAL_SHARE_BIN_RG}`,
        );
      });
    });
  }
});
