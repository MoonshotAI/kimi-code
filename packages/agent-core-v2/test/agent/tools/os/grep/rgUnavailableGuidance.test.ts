import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableToolResult } from '#/tool/toolContract';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import {
  ensureRgPath,
  getShareBinRgPath,
} from '#/os/backends/node-local/tools/rgLocator';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import type { GrepInput } from '#/agent/tools/os/grep/grep';
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
    stat: () => notImplemented('stat'),
    lstat: () => notImplemented('lstat'),
    readdir: () => notImplemented('readdir'),
    mkdir: () => notImplemented('mkdir'),
    remove: () => notImplemented('remove'),
    realpath: () => notImplemented('realpath'),
  };
  return Object.assign(
    new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: options.environmentId, generation: 'test' },
      { capabilities: ['fs', 'process'], host: { homeDir: options.homeDir } },
    ),
    { process: processService, fs },
  );
}

class TestGrepTool extends GrepTool {
  constructor(backend: FakeEnvironment) {
    const environment: IAgentEnvironmentService = {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      inspect: () => backend,
      acquire: () => ({ environment: backend, track: (resource) => resource, dispose: () => {} }),
      acquireWhenReady: async () => ({
        environment: backend,
        track: (resource) => resource,
        dispose: () => {},
      }),
      reconnect: async () => {},
      workspaceRoots: () => ({ workDir: '/workspace', additionalDirs: [] }),
    };
    super(environment, stubWorkspaceContext('/workspace'), noopTelemetryService);
  }
}

async function execute(tool: GrepTool, args: GrepInput): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(args);
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_grep',
    signal: new AbortController().signal,
  });
}

function outputOf(result: ExecutableToolResult): string {
  if (typeof result.output !== 'string') {
    throw new TypeError(`expected string output, got ${typeof result.output}`);
  }
  return result.output;
}

describe('GrepTool rg-unavailable guidance', () => {
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

  it('names the bound runtime and the target-side share-bin path on a remote environment', async () => {
    ensureRgPathMock.mockRejectedValue(new Error('boom'));
    const tool = new TestGrepTool(createBackend({ environmentId: 'ssh-dev', homeDir: REMOTE_HOME }));

    const result = await execute(tool, { pattern: 'needle' });

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
    const tool = new TestGrepTool(createBackend({ environmentId: 'local', homeDir: '/home/test' }));

    const result = await execute(tool, { pattern: 'needle' });

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
    const tool = new TestGrepTool(
      createBackend({
        environmentId: 'ssh-dev',
        homeDir: REMOTE_HOME,
        spawn: async () => {
          throw enoent;
        },
      }),
    );

    const result = await execute(tool, { pattern: 'needle' });

    expect(result.isError).toBe(true);
    const output = outputOf(result);
    expect(output).toContain('ssh-dev');
    expect(output).toContain(REMOTE_SHARE_BIN_RG);
    expect(output).not.toContain(getShareBinRgPath());
  });
});
