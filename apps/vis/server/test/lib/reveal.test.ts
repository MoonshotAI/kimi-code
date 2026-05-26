import { describe, it, expect } from 'vitest';
import { revealCommandFor } from '../../src/lib/reveal';

describe('reveal', () => {
  it('uses `open` on macOS', () => {
    expect(revealCommandFor('/tmp/x', 'darwin')).toEqual({
      command: 'open',
      args: ['/tmp/x'],
    });
  });

  it('uses cmd /c start on Windows', () => {
    expect(revealCommandFor('C:\\x', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'C:\\x'],
    });
  });

  it('uses xdg-open on Linux and other unixes', () => {
    expect(revealCommandFor('/tmp/x', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/x'],
    });
    expect(revealCommandFor('/tmp/x', 'freebsd')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/x'],
    });
  });
});
