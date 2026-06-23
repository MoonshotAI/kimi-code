// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../src/lib/clipboard';

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true,
  });
}

function setExecCommand(result: boolean | Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation(() => {
    if (result instanceof Error) throw result;
    return result;
  });
  // jsdom does not implement execCommand, so define it ourselves.
  Object.defineProperty(document, 'execCommand', {
    value: fn,
    configurable: true,
    writable: true,
  });
  return fn;
}

afterEach(() => {
  // Restore the jsdom defaults: no clipboard, no execCommand.
  setClipboard(undefined);
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'execCommand');
  document.body.innerHTML = '';
});

describe('copyTextToClipboard', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard is undefined', async () => {
    // Simulates an insecure (plain HTTP) context.
    setClipboard(undefined);
    const exec = setExecCommand(true);

    await expect(copyTextToClipboard('abc')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    const exec = setExecCommand(true);

    await expect(copyTextToClipboard('retry')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('resolves false when both paths fail', async () => {
    setClipboard(undefined);
    setExecCommand(false);

    await expect(copyTextToClipboard('nope')).resolves.toBe(false);
  });
});
