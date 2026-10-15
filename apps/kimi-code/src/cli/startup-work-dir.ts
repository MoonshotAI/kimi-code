import { workspaceRootKey } from '@moonshot-ai/kimi-code-sdk';

import { quoteShellArg } from '#/utils/shell-quote';

import type { CLIOptions } from './options';

export async function resolveStartupWorkDir(
  opts: Pick<CLIOptions, 'defaultWorkspace'>,
  ensureDefaultWorkspace: () => Promise<string>,
): Promise<string> {
  if (opts.defaultWorkspace !== true) return process.cwd();
  const workDir = await ensureDefaultWorkspace();
  process.chdir(workDir);
  process.env['PWD'] = workDir;
  return workDir;
}

export function resumeCommand(
  opts: Pick<CLIOptions, 'defaultWorkspace'>,
  sessionId: string,
  workDir: string,
  defaultWorkspacePath: string | undefined,
): string {
  if (opts.defaultWorkspace !== true) return `kimi -r ${sessionId}`;
  if (
    defaultWorkspacePath !== undefined &&
    workspaceRootKey(defaultWorkspacePath) === workspaceRootKey(workDir)
  ) {
    return `kimi --default-workspace -r ${sessionId}`;
  }
  return `cd ${quoteShellArg(workDir)} && kimi -r ${sessionId}`;
}
