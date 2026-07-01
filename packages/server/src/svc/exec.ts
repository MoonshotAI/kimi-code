

import { execFile } from 'node:child_process';

export const DEFAULT_EXEC_FILE_TIMEOUT_MS = 30_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  windowsHide?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function execFileUtf8(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        windowsHide: options.windowsHide === true,
        timeout: options.timeoutMs ?? DEFAULT_EXEC_FILE_TIMEOUT_MS,
        env: options.env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }

        const errorCode = (err as { code?: unknown }).code;
        const code = typeof errorCode === 'number' ? errorCode : -1;
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : message,
          code,
        });
      },
    );
  });
}
