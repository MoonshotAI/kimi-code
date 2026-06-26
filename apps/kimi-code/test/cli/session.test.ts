import { describe, expect, it, vi } from 'vitest';

import { registerSessionCommand } from '#/cli/sub/session';
import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';

function createProgramWithDeps(overrides: {
  readonly archiveSession?: () => Promise<SessionSummary>;
  readonly unarchiveSession?: () => Promise<SessionSummary>;
} = {}) {
  const { Command } = require('commander');
  const program = new Command('kimi');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  registerSessionCommand(program, {
    archiveSession: overrides.archiveSession ?? vi.fn().mockResolvedValue({ id: 'ses-1' } as SessionSummary),
    unarchiveSession: overrides.unarchiveSession ?? vi.fn().mockResolvedValue({ id: 'ses-1' } as SessionSummary),
    stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
    exit: (code: number) => { exits.push(code); throw new Error(`exit ${code}`); },
  });
  return { program, stdout, stderr, exits };
}

describe('session CLI subcommand', () => {
  it('archives a session by id', async () => {
    const archiveSession = vi.fn().mockResolvedValue({ id: 'ses-abc' } as SessionSummary);
    const { program, stdout } = createProgramWithDeps({ archiveSession });

    await program.parseAsync(['node', 'kimi', 'session', 'archive', 'ses-abc']);

    expect(archiveSession).toHaveBeenCalledWith('ses-abc');
    expect(stdout.join('')).toContain('Archived session: ses-abc');
  });

  it('unarchives a session by id', async () => {
    const unarchiveSession = vi.fn().mockResolvedValue({ id: 'ses-abc' } as SessionSummary);
    const { program, stdout } = createProgramWithDeps({ unarchiveSession });

    await program.parseAsync(['node', 'kimi', 'session', 'unarchive', 'ses-abc']);

    expect(unarchiveSession).toHaveBeenCalledWith('ses-abc');
    expect(stdout.join('')).toContain('Unarchived session: ses-abc');
  });

  it('prints an error and exits when archiving fails', async () => {
    const archiveSession = vi.fn().mockRejectedValue(new Error('session not found'));
    const { program, stderr, exits } = createProgramWithDeps({ archiveSession });

    await expect(program.parseAsync(['node', 'kimi', 'session', 'archive', 'missing'])).rejects.toThrow('exit 1');
    expect(archiveSession).toHaveBeenCalledWith('missing');
    expect(stderr.join('')).toContain('session not found');
    expect(exits).toEqual([1]);
  });
});
