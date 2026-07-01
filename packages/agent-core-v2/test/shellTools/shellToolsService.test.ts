import { describe, expect, it, vi } from 'vitest';

import type { IBackgroundService } from '#/background';
import type { IDisposable } from '#/_base/di';
import type { IKaos } from '#/kaos';
import type { IProcessRunner } from '#/process';
import type { IProfileService } from '#/profile';
import { ShellToolsService } from '#/shellTools';
import type { IToolRegistry } from '#/toolRegistry';

function fakeToolRegistry(): { registry: IToolRegistry; names: () => string[] } {
  const tools = new Map<string, unknown>();
  const registry: IToolRegistry = {
    _serviceBrand: undefined,
    register: vi.fn((tool: { name: string }): IDisposable => {
      tools.set(tool.name, tool);
      return { dispose: () => tools.delete(tool.name) };
    }),
    list: () => [...tools.values()] as never,
  } as unknown as IToolRegistry;
  return { registry, names: () => [...tools.keys()].sort() };
}

const fakeRunner = {} as unknown as IProcessRunner;
const fakeKaos = {
  cwd: '/workspace',
  osEnv: { osKind: 'Linux', osArch: 'x64', osVersion: '', shellName: 'bash', shellPath: '/bin/bash' },
  pathClass: () => 'posix',
} as unknown as IKaos;
const fakeBackground = {} as unknown as IBackgroundService;
const fakeProfile = {
  isToolActive: () => true,
} as unknown as IProfileService;

describe('ShellToolsService', () => {
  it('registers Bash into the tool registry', () => {
    const { registry, names } = fakeToolRegistry();
    new ShellToolsService(registry, fakeRunner, fakeKaos, fakeBackground, fakeProfile);
    expect(names()).toEqual(['Bash']);
  });
});
