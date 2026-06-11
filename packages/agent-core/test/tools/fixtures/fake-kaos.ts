/**
 * Fake Kaos — minimal stub for tool constructor injection in tests.
 *
 * All methods throw by default. Individual tests can override specific
 * methods with vi.fn() to provide scripted responses for the tool
 * under test.
 *
 * Also provides `PERMISSIVE_WORKSPACE` (`/` as workspaceDir) — most tool
 * tests care about behaviour, not path safety, so they default to a
 * workspace that accepts any absolute path. Attack-vector tests create
 * their own `WorkspaceConfig` with narrower bounds.
 */

import type { Environment, Kaos } from '@moonshot-ai/kaos';
import type { ExecutableToolResult } from '#/loop';

import type { WorkspaceConfig } from '../../../src/tools/support/workspace';

function notImplemented(method: string): never {
  throw new Error(`FakeKaos.${method} not implemented — override in test`);
}

export const FAKE_OS_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

export function createFakeKaos(
  overrides?: Partial<Kaos>,
  envLayers: readonly Record<string, string>[] = [],
): Kaos {
  // Hold cwd in a closure so `chdir` (which `config.update({cwd})` now
  // routes through) can mutate it and later `getcwd()` calls see the
  // update — mirroring real-kaos semantics without needing a backing fs.
  let cwd = overrides?.getcwd?.() ?? '/workspace';
  const base: Kaos = {
    name: 'fake',
    osEnv: FAKE_OS_ENV,
    pathClass: () => 'posix',
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => cwd,
    withCwd: (next: string) => createFakeKaos({ ...overrides, getcwd: () => next }, envLayers),
    withEnv: (env: Record<string, string>) =>
      createFakeKaos({ ...overrides, getcwd: () => cwd }, [...envLayers, env]),
    chdir: async (next: string) => {
      cwd = next;
    },
    stat: () => notImplemented('stat'),
    iterdir: () => notImplemented('iterdir'),
    glob: () => notImplemented('glob'),
    readBytes: () => notImplemented('readBytes'),
    readText: () => notImplemented('readText'),
    readLines: () => notImplemented('readLines'),
    writeBytes: () => notImplemented('writeBytes'),
    writeText: () => notImplemented('writeText'),
    mkdir: () => notImplemented('mkdir'),
    exec: () => notImplemented('exec'),
    execWithEnv: (args, invocationEnv) => {
      const mergedEnv = mergeEnvLayers(invocationEnv, envLayers);
      if (overrides?.execWithEnv) return overrides.execWithEnv(args, mergedEnv);
      return notImplemented('execWithEnv');
    },
  };
  return {
    ...base,
    ...overrides,
    execWithEnv: base.execWithEnv,
    withCwd: base.withCwd,
    withEnv: base.withEnv,
  } as Kaos;
}

function mergeEnvLayers(
  invocationEnv: Record<string, string> | undefined,
  envLayers: readonly Record<string, string>[],
): Record<string, string> | undefined {
  if (envLayers.length === 0) return invocationEnv;
  const merged: Record<string, string> = { ...invocationEnv };
  for (const layer of envLayers) {
    Object.assign(merged, layer);
  }
  return merged;
}

export const PERMISSIVE_WORKSPACE: WorkspaceConfig = {
  workspaceDir: '/',
  additionalDirs: [],
};

/**
 * Assert that a `ToolResult`'s `content` is a string and return it.
 * Keeps the lint rule `typescript-eslint(no-base-to-string)` happy by
 * narrowing the `string | ToolResultContent[]` union in one place.
 */
export function toolContentString(result: ExecutableToolResult): string {
  const c = result.output;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
}
