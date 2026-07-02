import { describe, expect, it, vi } from 'vitest';

import type { ISessionAgentFileSystem, ISessionFsService } from '#/session/agentFs';
import { AgentFileToolsService } from '#/agent/fileTools';
import type { IHostEnvironment } from '#/app/hostEnvironment';
import type { ISessionProcessRunner } from '#/session/process';
import { noopTelemetryService } from '#/app/telemetry';
import type { IDisposable } from '#/_base/di';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext';

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
const fakeEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home',
  ready: Promise.resolve(),
};
const fakeRunner = { _serviceBrand: undefined, exec: vi.fn() } as unknown as ISessionProcessRunner;
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
      fakeEnv,
      fakeWorkspace,
      fakeFsService,
      fakeRunner,
      noopTelemetryService,
    );
    expect(names()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });
});
