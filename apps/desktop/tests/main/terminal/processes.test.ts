import { describe, expect, it } from 'vitest';
import { parseUnixProcesses, parseWindowsProcesses, terminalActivityOf } from '../../../src/main/terminal/processes';

const terminal = { id: 'term', pid: 10, shell: 'zsh', cwd: '/work' };

describe('terminal process inspection', () => {
  it('distinguishes idle shells from foreground pipelines and background jobs', () => {
    const idle = parseUnixProcesses('10 1 10 10 Ss /bin/zsh\n99 1 99 99 S /bin/sleep');
    expect(terminalActivityOf(terminal, idle).state).toBe('idle');
    const running = parseUnixProcesses('10 1 10 20 Ss /bin/zsh\n20 10 20 20 S node\n21 10 20 20 S tee\n30 10 30 20 S sleep\n31 30 30 20 Z defunct');
    const activity = terminalActivityOf(terminal, running);
    expect(activity.state).toBe('busy');
    expect(activity.binary).toBe('tee');
    expect(activity.processes.map(process => process.binary)).toEqual(['node', 'tee', 'sleep']);
    const background = parseUnixProcesses('10 1 10 10 Ss /bin/zsh\n20 10 20 10 S sleep');
    expect(terminalActivityOf(terminal, background)).toMatchObject({ state: 'busy', binary: 'zsh' });
  });

  it('detects exec replacement and reports unavailable process information conservatively', () => {
    expect(terminalActivityOf(terminal, parseUnixProcesses('10 1 10 10 S python3'))).toMatchObject({ state: 'busy', binary: 'python3' });
    expect(terminalActivityOf(terminal, null).state).toBe('unknown');
    expect(terminalActivityOf(terminal, []).state).toBe('unknown');
  });

  it('reads parenthesised accounting names as the plain binary name', () => {
    expect(terminalActivityOf(terminal, parseUnixProcesses('10 1 10 10 Ss (zsh)'))).toMatchObject({ state: 'idle', binary: 'zsh' });
    expect(terminalActivityOf(terminal, parseUnixProcesses('10 1 10 20 Ss -zsh\n20 10 20 20 S (zsh)'))).toMatchObject({ binary: 'zsh' });
  });

  it('parses Windows descendants while excluding the console host', () => {
    const processes = parseWindowsProcesses(JSON.stringify([
      { ProcessId: 10, ParentProcessId: 1, Name: 'pwsh.exe' },
      { ProcessId: 20, ParentProcessId: 10, Name: 'node.exe' },
      { ProcessId: 21, ParentProcessId: 10, Name: 'conhost.exe' },
    ]));
    expect(terminalActivityOf({ ...terminal, shell: 'pwsh' }, processes)).toMatchObject({
      state: 'busy', binary: 'node', processes: [{ pid: 20, binary: 'node' }],
    });
  });
});
