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
): string {
  return opts.defaultWorkspace === true
    ? `kimi --default-workspace -r ${sessionId}`
    : `kimi -r ${sessionId}`;
}
