import { describe, expect, it, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: mocks.createInterface,
}));

import { createStdinLineReader, readStdinText } from '#/utils/process/stdin';

afterEach(() => {
  vi.clearAllMocks();
});

describe('stdin helpers', () => {
  it('reads stdin text until end and trims the result', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const onSpy = vi.spyOn(process.stdin, 'on').mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => void,
    ) => {
      listeners.set(event, handler);
      return process.stdin;
    }) as never);
    const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);

    const pending = readStdinText();
    listeners.get('data')?.(Buffer.from(' hello world \n'));
    listeners.get('end')?.();

    await expect(pending).resolves.toBe('hello world');

    onSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  it('yields lines from readline', async () => {
    mocks.createInterface.mockReturnValue(
      (async function* () {
        yield 'one';
        yield 'two';
      })(),
    );

    const lines: string[] = [];
    for await (const line of createStdinLineReader()) {
      lines.push(line);
    }

    expect(lines).toEqual(['one', 'two']);
    expect(mocks.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      crlfDelay: Infinity,
    });
  });
});
