/**
 * `sandbox` domain (L3) — effective sandbox policy resolution.
 *
 * Pure function folding the `[sandbox]` config section, the session workspace
 * roots, and host path facts into a `ResolvedSandboxPolicy`: the writable-root
 * set for the mode (`workspace-write` = workspace + additionalDirs + tmpdir +
 * `filesystem.allowWrite`; `read-only` = tmpdir + `filesystem.allowWrite`),
 * and the deny lists, all as normalized absolute paths with `~` expanded
 * against the host home directory and a trailing `/**` stripped (backends
 * mask literal paths; subtree semantics live in the matchers). `denyRead`
 * always starts from the built-in masks — `DEFAULT_DENY_READ` credential
 * locations, `DEFAULT_DENY_READ_SOCKETS` host daemon sockets plus the
 * `$XDG_RUNTIME_DIR` bus/agent sockets (unix sockets bypass `--unshare-net`),
 * and a literal `.env` under every writable root — none of it can be turned
 * off; `filesystem.denyRead` appends. In `read-only` mode, workspace roots
 * sitting under the tmpdir subtree would be re-opened for writing by the
 * tmpdir writable root, so they are automatically re-protected through
 * `denyWrite`. `resolveSandboxPolicy` itself stays pure; callers resolve the
 * host facts (`tmpdir`, `homeDir`, `resolveXdgRuntimeDir`).
 */

import { normalize } from 'pathe';

import { tmpdir } from 'node:os';

import { isWithinDirectory } from '#/tool/path-access';

import type { ResolvedSandboxPolicy, SandboxConfig, SandboxMode } from './sandboxTypes';

export interface SandboxWorkspaceRoots {
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
}

export interface SandboxPathEnv {
  readonly tmpdir: string;
  readonly homeDir: string;
  readonly xdgRuntimeDir?: string | undefined;
}

export const DEFAULT_DENY_READ: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.azure',
  '~/.config/gcloud',
  '~/.kube',
  '~/.docker',
  '~/.netrc',
  '~/.git-credentials',
  '~/.config/gh',
];

export const DEFAULT_DENY_READ_SOCKETS: readonly string[] = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run/containerd.sock',
  '/run/containerd/containerd.sock',
  '/run/crio/crio.sock',
  '/run/podman/podman.sock',
];

const XDG_RUNTIME_SOCKETS: readonly string[] = [
  'bus',
  'docker.sock',
  'podman/podman.sock',
  'gnupg',
];

const SUBTREE_SUFFIX = '/**';

export function resolveSandboxPolicy(
  config: SandboxConfig,
  workspace: SandboxWorkspaceRoots,
  env: SandboxPathEnv,
): ResolvedSandboxPolicy {
  const mode: SandboxMode = config.mode ?? 'workspace-write';
  const expand = (p: string): string =>
    stripTrailingSlash(normalize(expandHome(stripSubtreeSuffix(p), env.homeDir)));
  const allowWrite = (config.filesystem?.allowWrite ?? []).map(expand);
  const writableRoots = dedupe(
    (mode === 'read-only'
      ? [env.tmpdir, ...allowWrite]
      : [workspace.workDir, ...workspace.additionalDirs, env.tmpdir, ...allowWrite]
    ).map(expand),
  );
  const xdgSockets =
    env.xdgRuntimeDir === undefined
      ? []
      : XDG_RUNTIME_SOCKETS.map((rel) => `${env.xdgRuntimeDir}/${rel}`);
  const denyRead = dedupe([
    ...DEFAULT_DENY_READ.map(expand),
    ...DEFAULT_DENY_READ_SOCKETS,
    ...xdgSockets.map(expand),
    ...writableRoots.map((root) => `${root}/.env`),
    ...(config.filesystem?.denyRead ?? []).map(expand),
  ]);
  const tmpdirRoot = expand(env.tmpdir);
  const readonlyReprotected =
    mode === 'read-only'
      ? [workspace.workDir, ...workspace.additionalDirs]
          .map(expand)
          .filter((root) => isWithinDirectory(root, tmpdirRoot))
      : [];
  return {
    mode,
    writableRoots,
    denyRead,
    denyWrite: dedupe([
      ...(config.filesystem?.denyWrite ?? []).map(expand),
      ...readonlyReprotected,
    ]),
    networkEnabled: config.network?.enabled ?? false,
  };
}

export function resolveXdgRuntimeDir(
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): string | undefined {
  const dir = env['XDG_RUNTIME_DIR'];
  if (dir !== undefined && dir !== '') return dir;
  return uid === undefined ? undefined : `/run/user/${String(uid)}`;
}

export function hostSandboxPathEnv(homeDir: string): SandboxPathEnv {
  return {
    tmpdir: tmpdir(),
    homeDir,
    xdgRuntimeDir: resolveXdgRuntimeDir(process.env, hostUid()),
  };
}

function hostUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return `${homeDir}/${p.slice(2)}`;
  return p;
}

function stripSubtreeSuffix(p: string): string {
  return p.endsWith(SUBTREE_SUFFIX) ? p.slice(0, -SUBTREE_SUFFIX.length) : p;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function dedupe(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}
