import { afterEach, describe, expect, it, vi } from 'vitest';

import { restoreTerminalModes } from '#/utils/terminal-restore';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreTerminalModes', () => {
  it('disables terminal mouse reporting during emergency restoration', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    restoreTerminalModes();

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('\u001B[?1000l');
    expect(output).toContain('\u001B[?1002l');
    expect(output).toContain('\u001B[?1003l');
    expect(output).toContain('\u001B[?1006l');
  });
});
