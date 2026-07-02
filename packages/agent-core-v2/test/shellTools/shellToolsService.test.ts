import { describe, expect, it, vi } from 'vitest';

import type { IAgentBackgroundService } from '#/agent/background';
import type { IDisposable } from '#/_base/di';
import type { IHostEnvironment } from '#/app/hostEnvironment';
import { createExecContext, type IExecContext } from '#/session/execContext';
import type { ISessionProcessRunner } from '#/session/process';
import type { IAgentProfileService } from '#/agent/profile';
import { AgentShellToolsService } from '#/agent/shellTools';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry';

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

const fakeRunner = {} as unknown as ISessionProcessRunner;
const fakeEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: '',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home',
  ready: Promise.resolve(),
};
const fakeCtx: IExecContext = createExecContext('/workspace');
const fakeBackground = {} as unknown as IAgentBackgroundService;
const fakeProfile = {
  isToolActive: () => true,
} as unknown as IAgentProfileService;

describe('AgentShellToolsService', () => {
  it('registers Bash into the tool registry', () => {
    const { registry, names } = fakeToolRegistry();
    new AgentShellToolsService(registry, fakeRunner, fakeEnv, fakeCtx, fakeBackground, fakeProfile);
    expect(names()).toEqual(['Bash']);
  });
});
