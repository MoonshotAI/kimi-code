import type { ShellEnvironment } from '@moonshot-ai/kimi-code-sdk';

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
