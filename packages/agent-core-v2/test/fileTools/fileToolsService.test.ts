import { describe, expect, it, vi } from 'vitest';

import type { ISessionAgentFileSystem, ISessionFsService } from '#/agentFs';
import { AgentFileToolsService } from '#/fileTools';
import type { IKaos } from '#/kaos';
import { noopTelemetryService } from '#/telemetry';
import type { IDisposable } from '#/_base/di';
import type { IAgentToolRegistryService } from '#/toolRegistry';
import type { ISessionWorkspaceContext } from '#/workspaceContext';

function fakeToolRegistry(): { registry: IAgentToolRegistryService; names: () => string[] } {
  const tools = new Map<string, unknown>();
  const registry: IAgentToolRegistryService = {
    _serviceBrand: undefined,
    register: vi.fn((tool: { name: string }): IDisposable => {
      tools.set(tool.name, tool);
      return { dispose: () => tools.delete(tool.name) };
    }),
    list: () => [...tools.values()] as never,
  } as unknown as IAgentToolRegistryService;
  return { registry, names: () => [...tools.keys()].sort() };
}

const fakeFs = { cwd: '/workspace' } as unknown as ISessionAgentFileSystem;
const fakeFsService = {} as unknown as ISessionFsService;
const fakeKaos = {
  cwd: '/workspace',
  pathClass: () => 'posix',
  gethome: () => '/home',
} as unknown as IKaos;
const fakeWorkspace = {
  workDir: '/workspace',
  additionalDirs: [],
} as unknown as ISessionWorkspaceContext;

describe('AgentFileToolsService', () => {
  it('registers Read/Write/Edit/Grep/Glob into the tool registry', () => {
    const { registry, names } = fakeToolRegistry();
    new AgentFileToolsService(
      registry,
      fakeFs,
      fakeKaos,
      fakeWorkspace,
      fakeFsService,
      noopTelemetryService,
    );
    expect(names()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });
});
