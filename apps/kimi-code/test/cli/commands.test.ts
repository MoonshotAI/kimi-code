import { describe, expect, it, vi } from 'vitest';

/**
 * Every CLI invocation registers the whole command tree before Commander picks
 * a command, so anything a subcommand module imports statically is paid for by
 * `kimi -p` and `kimi --version` too. The modules below are only needed once
 * their command actually runs (`kimi web`, the interactive shell) and must stay
 * behind dynamic imports.
 */
const evaluated = vi.hoisted(() => new Set<string>());

vi.mock('@moonshot-ai/kap-server', async (importOriginal) => {
  evaluated.add('@moonshot-ai/kap-server');
  return importOriginal();
});
vi.mock('@moonshot-ai/pi-tui', async (importOriginal) => {
  evaluated.add('@moonshot-ai/pi-tui');
  return importOriginal();
});
vi.mock('cli-highlight', async (importOriginal) => {
  evaluated.add('cli-highlight');
  return importOriginal();
});
vi.mock('lovely-mermaid', async (importOriginal) => {
  evaluated.add('lovely-mermaid');
  return importOriginal();
});
vi.mock('#/tui/kimi-tui', async (importOriginal) => {
  evaluated.add('#/tui/kimi-tui');
  return importOriginal();
});

describe('createProgram import graph', () => {
  it('registers every command without evaluating the web server or the terminal UI', async () => {
    const { createProgram } = await import('#/cli/commands');

    const program = createProgram(
      '0.0.0',
      () => {},
      () => {},
    );

    expect(program.commands.map((command) => command.name())).toContain('web');
    expect([...evaluated]).toEqual([]);
    // Generous: when the guard trips, the mocks load the real modules first.
  }, 60_000);
});
