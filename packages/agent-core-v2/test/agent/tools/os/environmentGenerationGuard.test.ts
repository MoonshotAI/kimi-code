import { describe, expect, it, vi } from 'vitest';

import type { IFileEditService } from '#/app/edit/fileEdit';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import type { Environment, EnvironmentAccess, EnvironmentBinding, EnvironmentCapability, EnvironmentHandle, EnvironmentTarget } from '#/environment/environment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import {
  EnvironmentError,
  EnvironmentRegistry,
  environmentIsReady,
  type EnvironmentRegistrationHandle,
} from '#/environment/environmentRegistry';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { WorkspaceConfig } from '#/tool/path-access';
import { ToolAccesses, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { ensureRgPath } from '#/os/backends/node-local/tools/rgLocator';
import { EditTool } from '#/agent/tools/edit/editTool';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';
import { stubConfigService } from '../../../app/config/stubs';
import { stubToolResultTruncationService } from '../../toolResultTruncation/stubs';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';

vi.mock('#/os/backends/node-local/tools/rgLocator', async (importOriginal) => {
  const original = await importOriginal<typeof import('#/os/backends/node-local/tools/rgLocator')>();
  return { ...original, ensureRgPath: vi.fn() };
});

const ensureRgPathMock = vi.mocked(ensureRgPath);

const ENVIRONMENT_CHANGED_OUTPUT = 'Environment changed before execution. Retry the tool call.';
const BINDING: EnvironmentBinding = { environmentId: 'remote' };
const WORKSPACE: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };

const skillCatalog = { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog;
const profile = {
  getModelCapabilities: () => ({ image_in: true, video_in: true }),
} as unknown as IAgentProfileService;
const toolPolicy = { isToolActive: () => true } as unknown as IAgentToolPolicyService;
const toolRegistry = { resolve: () => ({}) } as unknown as IAgentToolRegistryService;

const attachmentStore = { put: async () => 'kimi-file://a' } as unknown as ISessionMediaStore;

function registryBackedService(registry: EnvironmentRegistry, environmentId = BINDING.environmentId): IAgentEnvironmentService {
  const binding = { environmentId };
  return {
    _serviceBrand: undefined,
    onDidChange: (listener) => registry.onDidChange(() => listener()),
    targets: () => [{ environmentId: 'local', primary: true }],
    handle(target) { return { ...this, target }; },
    isAvailable: (required: readonly EnvironmentCapability[] = []) => {
      try {
        const environment = registry.inspect(binding);
        return (
          environmentIsReady(environment) &&
          required.every((capability) => environment.capabilities.has(capability))
        );
      } catch {
        return false;
      }
    },
    inspect: () => registry.inspect(binding),
    acquire: (required = []) => registry.acquire(binding, required),
    acquireWhenReady: async (required = []) => {
      const environment = registry.inspect(binding);
      if (!environmentIsReady(environment) && typeof environment.connect === 'function') {
        await environment.connect();
      }
      return registry.acquireWhenReady(binding, required);
    },
    workspaceRoots: () => ({ workDir: '/workspace', additionalDirs: [] }),
  };
}

function connectSwappingHarness(
  readyFs: IHostFileSystem,
  host?: Partial<NonNullable<Environment['host']>>,
  environmentId = BINDING.environmentId,
) {
  const registry = new EnvironmentRegistry();
  const calls: string[] = [];
  let registration: EnvironmentRegistrationHandle;
  const ready = Object.assign(
    new FakeEnvironment(
      { environmentId, generation: `${environmentId}-ready` },
      { status: 'ready', capabilities: ['fs', 'process'], host },
    ),
    { fs: readyFs, process: {} },
  );
  const pending = Object.assign(
    new FakeEnvironment(
      { environmentId, generation: `${environmentId}-pending` },
      { status: 'pending', capabilities: [] },
    ),
    {
      host: undefined,
      connect: async () => {
        calls.push('connect');
        await registration.remove();
        registration = registry.register(ready);
      },
    },
  );
  registration = registry.register(pending);
  return {
    registry,
    get registration() {
      return registration;
    },
    service: registryBackedService(registry, environmentId),
    calls,
  };
}

function readyHarness(fs: IHostFileSystem) {
  const registry = new EnvironmentRegistry();
  const ready = Object.assign(
    new FakeEnvironment(
      { ...BINDING, generation: 'remote-one' },
      { status: 'ready', capabilities: ['fs', 'process'] },
    ),
    { fs, process: {} },
  );
  const registration = registry.register(ready);
  return { registry, registration, service: registryBackedService(registry) };
}

function replacementReadyEnvironment(): Environment {
  return Object.assign(
    new FakeEnvironment(
      { ...BINDING, generation: 'remote-two' },
      { status: 'ready', capabilities: ['fs', 'process'] },
    ),
    { fs: createFakeHostFs(), process: {} },
  );
}

async function* linesOf(content: string): AsyncGenerator<string> {
  yield* (content.endsWith('\n') ? content : `${content}\n`).split(/(?<=\n)/).filter((line) => line.length > 0);
}

function textFs(content: string): IHostFileSystem {
  const bytes = Buffer.from(content, 'utf8');
  return createFakeHostFs({
    stat: async () => ({ isFile: true, isDirectory: false, size: bytes.length }),
    readBytes: async (_path, n) => (n === undefined ? bytes : bytes.subarray(0, n)),
    readLines: () => linesOf(content),
  });
}

function writableFs(): IHostFileSystem {
  return createFakeHostFs({
    stat: async () => ({ isFile: false, isDirectory: true, size: 0 }),
    writeText: async () => {},
  });
}

function pngFs(): IHostFileSystem {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  return createFakeHostFs({
    stat: async () => ({ isFile: true, isDirectory: false, size: png.length }),
    readBytes: async (_path, n) => (n === undefined ? png : png.subarray(0, n)),
  });
}

interface ToolCase {
  readonly name: string;
  readonly fs: IHostFileSystem;
  readonly resolve: (service: IAgentEnvironmentService, path?: string) => ToolExecution | Promise<ToolExecution>;
  readonly expectOutcome: (result: ExecutableToolResult) => void;
}

const editService = {
  edit: async () => ({ ok: true as const, count: 1 }),
} as unknown as IFileEditService;

function bashTool(service: IAgentEnvironmentService): BashTool {
  return new BashTool(
    service,
    makeSessionContext({
      sessionId: 'ses',
      workspaceId: 'ws',
      sessionDir: '/tmp/ses',
      sessionScope: 'ses',
      cwd: '/workspace',
    }),
    {} as never,
    toolPolicy,
    stubConfigService(),
  );
}

function toolCases(): readonly ToolCase[] {
  return [
    {
      name: 'Bash',
      fs: createFakeHostFs(),
      resolve: (service) => bashTool(service).resolveExecution({ command: 'echo hi' }),
      expectOutcome: () => {},
    },
    {
      name: 'Read',
      fs: textFs('visible content'),
      resolve: (service, path = '/workspace/a.txt') =>
        new ReadTool(
          service,
          skillCatalog,
          stubToolResultTruncationService(),
          stubConfigService(),
          profile,
          toolPolicy,
          toolRegistry,
        ).resolveExecution({ path }),
      expectOutcome: (result) => {
        expect(result.isError).not.toBe(true);
        expect(result.output).toContain('visible content');
      },
    },
    {
      name: 'Write',
      fs: writableFs(),
      resolve: (service, path = '/workspace/a.txt') =>
        new WriteTool(service).resolveExecution({ path, content: 'hello' }),
      expectOutcome: (result) => {
        expect(result.isError).not.toBe(true);
        expect(result.output).toContain('Wrote 5 bytes');
      },
    },
    {
      name: 'Edit',
      fs: createFakeHostFs(),
      resolve: (service, path = '/workspace/a.txt') =>
        new EditTool(editService, service).resolveExecution({
          path,
          old_string: 'foo',
          new_string: 'bar',
        }),
      expectOutcome: (result) => {
        expect(result.isError).not.toBe(true);
        expect(result.output).toContain('Replaced 1 occurrence');
      },
    },
    {
      name: 'Grep',
      fs: createFakeHostFs(),
      resolve: (service) =>
        new GrepTool(service, noopTelemetryService).resolveExecution({ pattern: 'needle' }),
      expectOutcome: (result) => {
        expect(outputText(result)).toContain('ripgrep');
      },
    },
    {
      name: 'Glob',
      fs: writableFs(),
      resolve: (service) =>
        new GlobTool(service, noopTelemetryService).resolveExecution({ pattern: '**/*.ts' }),
      expectOutcome: (result) => {
        expect(outputText(result)).toContain('ripgrep');
      },
    },
    {
      name: 'ReadMediaFile',
      fs: pngFs(),
      resolve: (service) =>
        new ReadMediaFileTool(service, WORKSPACE, attachmentStore, noopTelemetryService).resolveExecution({
          path: '/workspace/a.png',
        }),
      expectOutcome: () => {},
    },
  ];
}

async function finish(resolved: ToolExecution | Promise<ToolExecution>): Promise<ExecutableToolResult> {
  const execution = await resolved;
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = {
    turnId: 0,
    toolCallId: 'call_guard',
    signal: new AbortController().signal,
  };
  return execution.execute(ctx);
}

function outputText(result: ExecutableToolResult): string {
  return typeof result.output === 'string'
    ? result.output
    : result.output.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

describe('tool environment generation guard', () => {
  for (const tool of toolCases()) {
    it(`${tool.name} executes against the reconnected environment when the resolve-time environment was pending`, async () => {
      ensureRgPathMock.mockRejectedValue(new Error('rg bootstrap failed'));
      const harness = connectSwappingHarness(tool.fs);

      const result = await finish(tool.resolve(harness.service));

      expect(harness.calls).toEqual(['connect']);
      expect(outputText(result)).not.toContain(ENVIRONMENT_CHANGED_OUTPUT);
      tool.expectOutcome(result);
    });

    it(`${tool.name} rejects execution when the generation changes after a ready resolve`, async () => {
      const harness = readyHarness(tool.fs);
      const resolved = await tool.resolve(harness.service);

      await harness.registration.remove();
      harness.registry.register(replacementReadyEnvironment());

      const result = await finish(resolved);
      expect(result.isError).toBe(true);
      expect(result.output).toBe(ENVIRONMENT_CHANGED_OUTPUT);
    });
  }

  for (const tool of toolCases().filter(({ name }) => ['Read', 'Write', 'Edit'].includes(name))) {
    it(`${tool.name} resolves home paths with the reconnected environment host`, async () => {
      const harness = connectSwappingHarness(tool.fs);

      const execution = await tool.resolve(harness.service, '~/a.txt');
      if (execution.isError === true) throw new Error('expected a runnable execution');
      expect(execution.display).toMatchObject({ kind: 'file_io', path: '/home/fake/a.txt' });

      const result = await finish(execution);
      expect(harness.calls).toEqual(['connect']);
      tool.expectOutcome(result);
    });
  }
});

describe('tilde resolution against the reconnected host', () => {
  it('resolves ~ against the reconnected host home instead of /', async () => {
    const { service, calls } = connectSwappingHarness(createFakeHostFs(), { homeDir: '/home/me' });
    const tool = new GlobTool(service, noopTelemetryService);
    const execution = await tool.resolveExecution({ pattern: '**/*.ts', path: '~/projects' });
    expect(calls).toEqual(['connect']);
    expect((execution as Extract<ToolExecution, { execute: unknown }>).accesses).toEqual(
      ToolAccesses.searchTree('/home/me/projects'),
    );
  });

  it('fails the tool call instead of resolving ~ against / when reconnect fails', async () => {
    const registry = new EnvironmentRegistry();
    const pending = Object.assign(
      new FakeEnvironment(
        { ...BINDING, generation: 'remote-pending' },
        { status: 'pending', capabilities: [] },
      ),
      {
        host: undefined,
        connect: async () => {
          throw new Error('connection refused');
        },
      },
    );
    registry.register(pending);
    const tool = new GlobTool(registryBackedService(registry), noopTelemetryService);
    await expect(tool.resolveExecution({ pattern: '**/*.ts', path: '~/projects' })).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('tool environment routing', () => {
  function routedHarness() {
    const registry = new EnvironmentRegistry();
    const spawns: { readonly environmentId: string; readonly cwd: string | undefined }[] = [];
    for (const [environmentId, content] of [['local', `local content\n${'local tail\n'.repeat(60)}`], ['gpu', `gpu content\n${'gpu tail\n'.repeat(60)}`]] as const) {
      registry.register(Object.assign(
        new FakeEnvironment(
          { environmentId, generation: `${environmentId}-one` },
          { status: 'ready', capabilities: ['fs', 'process'] },
        ),
        {
          fs: textFs(content),
          process: {
            spawn: async (_command: string, _args: readonly string[], options?: { readonly cwd?: string }) => {
              spawns.push({ environmentId, cwd: options?.cwd });
              throw new Error(`spawned on ${environmentId}`);
            },
          },
        },
      ));
    }
    const binding = (environmentId?: string): EnvironmentBinding => ({ environmentId: environmentId ?? 'local' });
    const accessIn = (environmentId?: string): EnvironmentAccess => ({
      isAvailable: (required = []) => {
        const environment = registry.inspect(binding(environmentId));
        return environmentIsReady(environment) && required.every((capability) => environment.capabilities.has(capability));
      },
      inspect: () => registry.inspect(binding(environmentId)),
      acquire: (required = []) => registry.acquire(binding(environmentId), required),
      acquireWhenReady: (required = []) => registry.acquireWhenReady(binding(environmentId), required),
      workspaceRoots: () => ({
        workDir: binding(environmentId).environmentId === 'local' ? '/workspace' : '/gpu',
        additionalDirs: [],
      }),
    });
    const service: IAgentEnvironmentService = {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      targets: () => [
        { environmentId: 'local', primary: true },
        { environmentId: 'gpu', primary: false, cwd: '/gpu' },
      ],
      handle: (target) => ({ ...accessIn(target.environmentId), target }),
      ...accessIn(),
    };
    return { service, spawns };
  }

  it('reads from the requested environment and resolves relative paths against its working directory', async () => {
    const { service } = routedHarness();
    const read = (environment?: EnvironmentTarget) =>
      new ReadTool(
        service,
        skillCatalog,
        stubToolResultTruncationService(),
        stubConfigService(),
        profile,
        toolPolicy,
        toolRegistry,
      ).resolveExecution({ path: 'notes.txt' }, { environment: environment === undefined ? undefined : service.handle(environment) });

    const routed = await read({ environmentId: 'gpu', primary: false });
    expect(routed).toMatchObject({ display: { kind: 'file_io', operation: 'read', path: '/gpu/notes.txt' } });
    expect(outputText(await finish(routed))).toContain('gpu content');

    const primary = await read();
    expect(primary).toMatchObject({ display: { path: '/workspace/notes.txt' } });
    expect(outputText(await finish(primary))).toContain('local content');

    const named = await read({ environmentId: 'local', primary: true });
    expect(named).toMatchObject({ display: { path: '/workspace/notes.txt' } });
    expect(outputText(await finish(named))).toContain('local content');
  });

  it('keeps the routed environment in Next Read arguments', async () => {
    const { service } = routedHarness();
    const read = (environment?: EnvironmentTarget) =>
      new ReadTool(
        service,
        skillCatalog,
        stubToolResultTruncationService(),
        stubConfigService(),
        profile,
        toolPolicy,
        toolRegistry,
      ).resolveExecution({ path: 'notes.txt', max_chars: 600 }, { environment: environment === undefined ? undefined : service.handle(environment) });

    const routed = await finish(await read({ environmentId: 'gpu', primary: false }));
    expect(outputText(routed)).toContain('gpu content');
    expect(routed.note).toContain('Next Read: {"path":"notes.txt","environment":"gpu","line_offset":2');

    const primary = await finish(await read({ environmentId: 'local', primary: true }));
    expect(primary.note).toContain('Next Read: {"path":"notes.txt","line_offset":2');
  });

  it('rejects attachment references routed to another environment', async () => {
    const { service } = routedHarness();
    const gpu = service.handle({ environmentId: 'gpu', primary: false });
    const expected = {
      isError: true,
      output: expect.stringContaining('Omit the `environment` argument'),
    };

    await expect(
      new ReadTool(
        service,
        skillCatalog,
        stubToolResultTruncationService(),
        stubConfigService(),
        profile,
        toolPolicy,
        toolRegistry,
      ).resolveExecution({ path: 'kimi-file://attachment' }, { environment: gpu }),
    ).resolves.toMatchObject(expected);
    await expect(
      new ReadMediaFileTool(service, WORKSPACE, attachmentStore, noopTelemetryService).resolveExecution(
        { path: 'kimi-file://attachment' },
        { environment: gpu },
      ),
    ).resolves.toMatchObject(expected);
  });

  it('refuses a routed Write whose declared working directory is missing', async () => {
    const registry = new EnvironmentRegistry();
    const written: string[] = [];
    let workDirExists = false;
    registry.register(Object.assign(
      new FakeEnvironment({ environmentId: 'gpu', generation: 'gpu-one' }, { status: 'ready', capabilities: ['fs'] }),
      {
        fs: createFakeHostFs({
          stat: async (path) => {
            if (path === '/gpu' && !workDirExists) throw new Error('missing');
            return { isFile: false, isDirectory: true, size: 0 };
          },
          writeText: async (path) => {
            written.push(path);
          },
        }),
      },
    ));
    const service = registryBackedService(registry, 'gpu');
    const gpu: EnvironmentHandle = {
      ...service,
      target: { environmentId: 'gpu', primary: false, cwd: '/gpu' },
      workspaceRoots: () => ({ workDir: '/gpu', additionalDirs: [] }),
    };
    const write = async () => new WriteTool(service).resolveExecution({ path: 'out.txt', content: 'hello' }, { environment: gpu });

    await expect(write()).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining('Working directory /gpu does not exist on environment gpu'),
    });
    expect(written).toEqual([]);

    workDirExists = true;
    expect((await finish(await write())).output).toContain('Wrote 5 bytes');
    expect(written).toEqual(['/gpu/out.txt']);
  });

  it('runs Bash on the requested environment in its working directory', async () => {
    const { service, spawns } = routedHarness();
    const resolved = await bashTool(service).resolveExecution(
      { command: 'pwd' },
      { environment: service.handle({ environmentId: 'gpu', primary: false }) },
    );
    expect(resolved).toMatchObject({ display: { kind: 'command', cwd: '/gpu' } });
    const result = await finish(resolved);

    expect(spawns).toEqual([{ environmentId: 'gpu', cwd: '/gpu' }]);
    expect(outputText(result)).toContain('spawned on gpu');
  });

  it('connects an unready secondary environment before the approval preview', async () => {
    const harness = connectSwappingHarness(createFakeHostFs(), { cwd: '/srv/app' }, 'gpu');
    const { registry, calls } = harness;
    const gpu: EnvironmentHandle = {
      ...harness.service,
      target: { environmentId: 'gpu', primary: false },
      workspaceRoots: () => {
        const workDir = registry.inspect({ environmentId: 'gpu' }).host?.cwd;
        if (workDir === undefined) {
          throw new EnvironmentError('environment.unavailable', 'environment gpu has no working directory until it connects');
        }
        return { workDir, additionalDirs: [] };
      },
    };

    const resolved = await bashTool(harness.service).resolveExecution({ command: 'pwd' }, { environment: gpu });
    expect(calls).toEqual(['connect']);
    expect(resolved).toMatchObject({ display: { kind: 'command', cwd: '/srv/app' } });

    await harness.registration.remove();
    registry.register(Object.assign(
      new FakeEnvironment(
        { environmentId: 'gpu', generation: 'gpu-two' },
        { status: 'ready', capabilities: ['process'], host: { cwd: '/srv/app' } },
      ),
      { process: {} },
    ));
    const result = await finish(resolved);
    expect(result.isError).toBe(true);
    expect(result.output).toBe(ENVIRONMENT_CHANGED_OUTPUT);
  });
});
