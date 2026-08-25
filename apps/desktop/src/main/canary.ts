// Kimi Code Canary channel — gh-CLI utilities shared by the debug menu and
// the update wiring.
//
// Auto-update itself does NOT live here: canary builds update through
// electron-updater with the GitHub provider (canary-updater.ts — runtime
// `gh auth token` + channel/blockmap patches, differential download). What
// remains here:
//   - `probeGh` / `resolveGhBinary`: gh CLI readiness for UI hints (the debug
//     menu greys out actions and explains how to fix gh when it's not ready);
//   - `getCanaryInfo`: channel identity for the renderer (enabled /
//     isCanaryBuild / gh state / workflow page URL);
//   - `triggerBuild`: `gh workflow run desktop-build.yml -f canary=true` —
//     the debug menu's「重新打包 Canary」action.
//
// Deps are injected where it matters (tests drive the module with fakes);
// production wiring at the bottom.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { app } from 'electron';

import { isCanaryChannelEnabled, isCanaryDisplay, isCanaryVersion } from './release-channel';

export const CANARY_REPO = 'MoonshotAI/kimi-code-app';
export const CANARY_WORKFLOW = 'desktop-build.yml';
const ACTIONS_URL = `https://github.com/${CANARY_REPO}/actions/workflows/${CANARY_WORKFLOW}`;

const GH_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export type CanaryGhState = 'ok' | 'missing' | 'unauthenticated' | 'error';

export interface CanaryInfo {
  /** Whether the canary UI shows at all (canary build or dev). */
  enabled: boolean;
  /** True only on a real canary build (version carries `-canary.`) — drives
      the always-on sidebar badge so dev runs of the stable app stay quiet. */
  isCanaryBuild: boolean;
  gh: CanaryGhState;
  /** Deep link to the workflow page (debug 菜单「查看流水线」). */
  actionsUrl: string;
}

export type CanaryTriggerResult = { ok: true } | { ok: false; error: string };

export type ExecFileAsync = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface CanaryDeps {
  exec: ExecFileAsync;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}

/** `gh` lookup: GUI apps get a minimal PATH (no Homebrew on macOS), so probe
    the usual absolute locations first and fall back to a bare `gh`. */
export function resolveGhBinary(deps: Pick<CanaryDeps, 'exists' | 'platform'>): string {
  const candidates: string[] =
    deps.platform === 'darwin'
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
      : deps.platform === 'win32'
        ? ['C:\\Program Files\\GitHub CLI\\gh.exe']
        : ['/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh'];
  for (const candidate of candidates) {
    if (deps.exists(candidate)) {
      return candidate;
    }
  }
  return 'gh';
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim().split('\n')[0]!;
    }
    return error.message;
  }
  return String(error);
}

export async function probeGh(deps: CanaryDeps): Promise<CanaryGhState> {
  const bin = resolveGhBinary(deps);
  try {
    await deps.exec(bin, ['--version'], { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  } catch (error) {
    return isEnoent(error) ? 'missing' : 'error';
  }
  try {
    await deps.exec(bin, ['auth', 'status'], { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return 'ok';
  } catch {
    // `gh auth status` 在没有登录任何 host 时非零退出。
    return 'unauthenticated';
  }
}

export async function triggerBuild(deps: CanaryDeps): Promise<CanaryTriggerResult> {
  const gh = await probeGh(deps);
  if (gh !== 'ok') {
    return { ok: false as const, error: `gh not ready: ${gh}` };
  }
  const bin = resolveGhBinary(deps);
  try {
    await deps.exec(
      bin,
      ['workflow', 'run', CANARY_WORKFLOW, '--repo', CANARY_REPO, '--ref', 'main', '-f', 'canary=true'],
      { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error) };
  }
}

// --- production singleton -----------------------------------------------------

const execFileAsync = promisify(execFile) as ExecFileAsync;

function productionDeps(): CanaryDeps {
  return { exec: execFileAsync, platform: process.platform, exists: existsSync };
}

// IPC entry points (see ipc.ts).
export async function getCanaryInfo(): Promise<CanaryInfo> {
  return {
    enabled: isCanaryChannelEnabled(app.getVersion(), app.isPackaged),
    isCanaryBuild: isCanaryDisplay(app.getVersion(), app.isPackaged),
    gh: await probeGh(productionDeps()),
    actionsUrl: ACTIONS_URL,
  };
}

export function requestCanaryTrigger(): Promise<CanaryTriggerResult> {
  return triggerBuild(productionDeps());
}

/** isCanaryVersion re-export for callers that already import this module. */
export { isCanaryVersion };
