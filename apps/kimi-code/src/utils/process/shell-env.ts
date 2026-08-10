/** Detected terminal/shell environment (mirror of the SDK `ShellEnvironment`). */
export interface ShellEnvironment {
  readonly term?: string;
  readonly termProgram?: string;
  readonly termProgramVersion?: string;
  readonly multiplexer?: string;
  readonly shell?: string;
  readonly [key: string]: unknown;
}

function detectMultiplexer(): string | undefined {
  if (process.env['TMUX']) return 'tmux';
  if (process.env['STY']) return 'screen';
  if (process.env['ZELLIJ']) return 'zellij';
  return undefined;
}

export function detectShellEnvironment(): ShellEnvironment {
  return {
    term: process.env['TERM'] || undefined,
    termProgram: process.env['TERM_PROGRAM'] || undefined,
    termProgramVersion: process.env['TERM_PROGRAM_VERSION'] || undefined,
    multiplexer: detectMultiplexer(),
    shell: process.env['SHELL'] || undefined,
  };
}
