/**
 * Fake execution-environment atoms — minimal stubs for tool constructor
 * injection in tests.
 *
 * Replaces the old `fake-kaos.ts` fixture. The v2 tools no longer take a
 * single god-object `IKaos`; instead they receive the pieces they actually
 * use:
 *
 *   - `IHostEnvironment` (App-scope) — sync OS/shell/path/home facts.
 *   - `IExecContext` (Session-scope) — the session cwd and env layers.
 *   - `ISessionAgentFileSystem` (Session-scope) — file IO.
 *   - `ISessionProcessRunner` (Session-scope) — process spawn.
 *
 * The `createFake*` factories default every method to a "not implemented"
 * throw; individual tests override the specific methods they exercise with
 * `vi.fn()`.
 *
 * Also re-exports `PERMISSIVE_WORKSPACE` (`/` as workspaceDir) — most tool
 * tests care about behaviour, not path safety, so they default to a
 * workspace that accepts any absolute path. Attack-vector tests create
 * their own `WorkspaceConfig` with narrower bounds.
 */

import type { ExecutableToolResult } from '#/agent/tool';
import type { IHostEnvironment } from '#/app/hostEnvironment';
import type { ISessionAgentFileSystem } from '#/session/agentFs';
import { createExecContext, type IExecContext } from '#/session/execContext';
import type { ISessionProcessRunner } from '#/session/process';

import type { WorkspaceConfig } from '#/_base/tools/support/workspace';

// ── Host environment ─────────────────────────────────────────────────

export const FAKE_HOST_ENVIRONMENT: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

export function createFakeHostEnvironment(
  overrides?: Partial<IHostEnvironment>,
): IHostEnvironment {
  return { ...FAKE_HOST_ENVIRONMENT, ...overrides };
}

// ── Exec context ─────────────────────────────────────────────────────

export function createFakeExecContext(
  cwd: string = '/workspace',
  envLayers: readonly Record<string, string>[] = [],
): IExecContext {
  return createExecContext(cwd, envLayers);
}

// ── Process runner ───────────────────────────────────────────────────

function notImplemented(surface: string, method: string): never {
  throw new Error(`${surface}.${method} not implemented — override in test`);
}

/**
 * Fake `ISessionProcessRunner`. `exec` throws by default; tests override with
 * `vi.fn()`. `envLayers` preserves the merge behaviour that the old
 * `createFakeKaos.execWithEnv` provided — extra layers are applied on top of
 * the per-call `options.env`, later layers winning, mirroring how the real
 * `IExecContext` overlays env for every spawned process.
 */
export function createFakeProcessRunner(
  overrides?: Partial<ISessionProcessRunner>,
  envLayers: readonly Record<string, string>[] = [],
): ISessionProcessRunner {
  const baseExec: ISessionProcessRunner['exec'] = async (args, options) => {
    if (overrides?.exec !== undefined) {
      const mergedEnv = mergeEnvLayers(options?.env, envLayers);
      return overrides.exec(
        args,
        mergedEnv !== options?.env ? { ...options, env: mergedEnv } : options,
      );
    }
    return notImplemented('FakeProcessRunner', 'exec');
  };
  return {
    _serviceBrand: undefined,
    ...overrides,
    exec: baseExec,
  };
}

function mergeEnvLayers(
  invocationEnv: Record<string, string> | undefined,
  envLayers: readonly Record<string, string>[],
): Record<string, string> | undefined {
  if (envLayers.length === 0) return invocationEnv;
  const merged: Record<string, string> = { ...invocationEnv };
  for (const layer of envLayers) Object.assign(merged, layer);
  return merged;
}

// ── Agent filesystem ─────────────────────────────────────────────────

/**
 * Fake `ISessionAgentFileSystem`. Every method throws by default; tests
 * override the specific ones they exercise. `withCwd` returns a fresh fake
 * with the new `cwd` baked in but the same overrides, matching how
 * consumers use it in tests.
 */
export function createFakeAgentFs(
  overrides?: Partial<ISessionAgentFileSystem>,
  cwd: string = '/workspace',
): ISessionAgentFileSystem {
  const fake: ISessionAgentFileSystem = {
    _serviceBrand: undefined,
    cwd,
    readText: () => notImplemented('FakeAgentFs', 'readText'),
    writeText: () => notImplemented('FakeAgentFs', 'writeText'),
    readBytes: () => notImplemented('FakeAgentFs', 'readBytes'),
    readLines: () => notImplemented('FakeAgentFs', 'readLines'),
    writeBytes: () => notImplemented('FakeAgentFs', 'writeBytes'),
    stat: () => notImplemented('FakeAgentFs', 'stat'),
    readdir: () => notImplemented('FakeAgentFs', 'readdir'),
    glob: () => notImplemented('FakeAgentFs', 'glob'),
    mkdir: () => notImplemented('FakeAgentFs', 'mkdir'),
    withCwd: (next: string) => createFakeAgentFs(overrides, next),
    ...overrides,
  };
  return fake;
}

// ── Test-wide helpers ────────────────────────────────────────────────

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
