import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableToolResult } from '#/tool/toolContract';
import type { IHostFileSystem, HostFileStat } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import {
  ensureRgPath,
  getShareBinRgPath,
} from '#/os/backends/node-local/tools/rgLocator';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import type { GlobInput } from '#/agent/tools/os/glob/glob';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';

vi.mock('#/os/backends/node-local/tools/rgLocator', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('#/os/backends/node-local/tools/rgLocator')>();
  return { ...original, ensureRgPath: vi.fn() };
});

const ensureRgPathMock = vi.mocked(ensureRgPath);

const REMOTE_HOME = '/home/remote';
const REMOTE_SHARE_BIN_RG = '/home/remote/.kimi-code/bin/rg';
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
  readonly runtimeId: string;
  readonly homeDir: string;
  readonly spawn?: IHostProcessService['spawn'];
}): FakeRuntime {
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
    realpath: () => notImplemented('realpath'),
  };
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: options.runtimeId, generation: 'test' },
      { capabilities: ['fs', 'process'], environment: { homeDir: options.homeDir } },
    ),
    { process: processService, fs },
  );
}

class TestGlobTool extends GlobTool {
  constructor(backend: FakeRuntime) {
    const runtime: IAgentRuntimeService = {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      inspect: () => backend,
      acquire: () => ({ runtime: backend, track: (resource) => resource, dispose: () => {} }),
      acquireWhenReady: async () => ({
        runtime: backend,
        track: (resource) => resource,
        dispose: () => {},
      }),
      reconnect: async () => {},
      workspaceRoots: () => ({ workDir: '/workspace', additionalDirs: [] }),
    };
    super(runtime, stubWorkspaceContext('/workspace'), noopTelemetryService);
  }
}

async function execute(tool: GlobTool, args: GlobInput): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(args);
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_glob',
    signal: new AbortController().signal,
  });
}

function outputOf(result: ExecutableToolResult): string {
  if (typeof result.output !== 'string') {
    throw new TypeError(`expected string output, got ${typeof result.output}`);
  }
  return result.output;
}

describe('GlobTool rg-unavailable guidance', () => {
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

  it('names the bound runtime and the target-side share-bin path on a remote runtime', async () => {
    ensureRgPathMock.mockRejectedValue(new Error('boom'));
    const tool = new TestGlobTool(createBackend({ runtimeId: 'ssh-dev', homeDir: REMOTE_HOME }));

    const result = await execute(tool, { pattern: '**/*.ts' });

    expect(result.isError).toBe(true);
    const output = outputOf(result);
    expect(output).toContain('ssh-dev');
    expect(output).toContain(REMOTE_SHARE_BIN_RG);
    expect(output).toContain('on the target');
    expect(output).toContain('brew install ripgrep');
    expect(output).not.toContain(getShareBinRgPath());
  });

  it('keeps the local-binding guidance byte-identical', async () => {
    ensureRgPathMock.mockRejectedValue(new Error('boom'));
    const tool = new TestGlobTool(createBackend({ runtimeId: 'local', homeDir: '/home/test' }));

    const result = await execute(tool, { pattern: '**/*.ts' });

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

  it('names the runtime and target path when the resolved rg fails to spawn', async () => {
    ensureRgPathMock.mockResolvedValue({ path: REMOTE_SHARE_BIN_RG, source: 'share-bin-cached' });
    const enoent = Object.assign(new Error(`spawn ${REMOTE_SHARE_BIN_RG} ENOENT`), {
      code: 'ENOENT',
    });
    const tool = new TestGlobTool(
      createBackend({
        runtimeId: 'ssh-dev',
        homeDir: REMOTE_HOME,
        spawn: async () => {
          throw enoent;
        },
      }),
    );

    const result = await execute(tool, { pattern: '**/*.ts' });

    expect(result.isError).toBe(true);
    const output = outputOf(result);
    expect(output).toContain('ssh-dev');
    expect(output).toContain(REMOTE_SHARE_BIN_RG);
    expect(output).not.toContain(getShareBinRgPath());
  });
});
