import { describe, expect, it, vi } from 'vitest';

import type { IFileEditService } from '#/app/edit/fileEdit';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import type { Environment, EnvironmentBinding, EnvironmentCapability } from '#/environment/environment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import {
  EnvironmentRegistry,
  environmentIsReady,
  type EnvironmentRegistrationHandle,
} from '#/environment/environmentRegistry';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ModelCapability } from '#human/llm/capability';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { WorkspaceConfig } from '#/tool/path-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { ensureRgPath } from '#/os/backends/node-local/tools/rgLocator';
import { EditTool } from '#/agent/tools/edit/editTool';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';
import { stubConfigService } from '../../../app/config/stubs';
import { stubToolResultTruncationService } from '../../toolResultTruncation/stubs';
import { stubWorkspaceContext } from '../../../session/workspaceContext/stub-workspace-context';

vi.mock('#/os/backends/node-local/tools/rgLocator', async (importOriginal) => {
  const original = await importOriginal<typeof import('#/os/backends/node-local/tools/rgLocator')>();
  return { ...original, ensureRgPath: vi.fn() };
});

const ensureRgPathMock = vi.mocked(ensureRgPath);

const ENVIRONMENT_CHANGED_OUTPUT = 'Environment changed before execution. Retry the tool call.';
const BINDING: EnvironmentBinding = { workspaceId: 'workspace', environmentId: 'remote' };
const WORKSPACE: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };

const skillCatalog = { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog;
const profile = {
  getModelCapabilities: () => ({ image_in: true, video_in: true }),
} as unknown as IAgentProfileService;
const toolPolicy = { isToolActive: () => true } as unknown as IAgentToolPolicyService;
const toolRegistry = { resolve: () => ({}) } as unknown as IAgentToolRegistryService;

function modelCapabilities(): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
  };
}

function registryBackedService(registry: EnvironmentRegistry): IAgentEnvironmentService {
  return {
    _serviceBrand: undefined,
    onDidChange: (listener) => registry.onDidChange(() => listener()),
    isAvailable: (required: readonly EnvironmentCapability[] = []) => {
      try {
        const environment = registry.inspect(BINDING);
        return (
          environmentIsReady(environment) &&
          required.every((capability) => environment.capabilities.has(capability))
        );
      } catch {
        return false;
      }
    },
    inspect: () => registry.inspect(BINDING),
    acquire: (required = []) => registry.acquire(BINDING, required),
    acquireWhenReady: async (required = []) => {
      const environment = registry.inspect(BINDING);
      if (!environmentIsReady(environment) && typeof environment.connect === 'function') {
        await environment.connect();
      }
      return registry.acquireWhenReady(BINDING, required);
    },
    reconnect: async () => {},
    workspaceRoots: () => ({ workDir: '/workspace', additionalDirs: [] }),
  };
}

function connectSwappingHarness(readyFs: IHostFileSystem) {
  const registry = new EnvironmentRegistry('workspace');
  const calls: string[] = [];
  let registration: EnvironmentRegistrationHandle;
  const ready = Object.assign(
    new FakeEnvironment(
      { ...BINDING, generation: 'remote-ready' },
      { status: 'ready', capabilities: ['fs', 'process'] },
    ),
    { fs: readyFs, process: {} },
  );
  const pending = Object.assign(
    new FakeEnvironment(
      { ...BINDING, generation: 'remote-pending' },
      { status: 'pending', capabilities: [] },
    ),
    {
      connect: async () => {
        calls.push('connect');
        await registration.replace(ready);
      },
    },
  );
  registration = registry.register(pending);
  return { registration, service: registryBackedService(registry), calls };
}

function readyHarness(fs: IHostFileSystem) {
  const registry = new EnvironmentRegistry('workspace');
  const ready = Object.assign(
    new FakeEnvironment(
      { ...BINDING, generation: 'remote-one' },
      { status: 'ready', capabilities: ['fs', 'process'] },
    ),
    { fs, process: {} },
  );
  const registration = registry.register(ready);
  return { registration, service: registryBackedService(registry) };
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
  yield `${content}\n`;
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
  readonly resolve: (service: IAgentEnvironmentService) => ToolExecution | Promise<ToolExecution>;
  readonly expectOutcome: (result: ExecutableToolResult) => void;
}

const editService = {
  edit: async () => ({ ok: true as const, count: 1 }),
} as unknown as IFileEditService;

function toolCases(): readonly ToolCase[] {
  const workspace = stubWorkspaceContext('/workspace');
  return [
    {
      name: 'Read',
      fs: textFs('visible content'),
      resolve: (service) =>
        new ReadTool(
          service,
          workspace,
          skillCatalog,
          stubToolResultTruncationService(),
          stubConfigService(),
          profile,
          toolPolicy,
          toolRegistry,
        ).resolveExecution({ path: '/workspace/a.txt' }),
      expectOutcome: (result) => {
        expect(result.isError).not.toBe(true);
        expect(result.output).toContain('visible content');
      },
    },
    {
      name: 'Write',
      fs: writableFs(),
      resolve: (service) =>
        new WriteTool(service, workspace).resolveExecution({ path: '/workspace/a.txt', content: 'hello' }),
      expectOutcome: (result) => {
        expect(result.isError).not.toBe(true);
        expect(result.output).toContain('Wrote 5 bytes');
      },
    },
    {
      name: 'Edit',
      fs: createFakeHostFs(),
      resolve: (service) =>
        new EditTool(editService, service, workspace).resolveExecution({
          path: '/workspace/a.txt',
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
        new GrepTool(service, workspace, noopTelemetryService).resolveExecution({ pattern: 'needle' }),
      expectOutcome: (result) => {
        expect(outputText(result)).toContain('ripgrep');
      },
    },
    {
      name: 'Glob',
      fs: writableFs(),
      resolve: (service) =>
        new GlobTool(service, workspace, noopTelemetryService).resolveExecution({ pattern: '**/*.ts' }),
      expectOutcome: (result) => {
        expect(outputText(result)).toContain('ripgrep');
      },
    },
    {
      name: 'ReadMediaFile',
      fs: pngFs(),
      resolve: (service) =>
        new ReadMediaFileTool(service, WORKSPACE, modelCapabilities(), undefined, noopTelemetryService).resolveExecution({
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
      const resolved = tool.resolve(harness.service);

      await harness.registration.replace(replacementReadyEnvironment());

      const result = await finish(resolved);
      expect(result.isError).toBe(true);
      expect(result.output).toBe(ENVIRONMENT_CHANGED_OUTPUT);
    });
  }
});
