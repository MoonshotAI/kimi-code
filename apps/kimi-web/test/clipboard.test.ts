// Scenario: clipboard writes in secure and plain-HTTP web contexts.
// Responsibilities: preserve native selection copies and provide the legacy
// code-block fallback. The test stubs only navigator/document browser APIs.
// Run: pnpm --filter @moonshot-ai/kimi-web test -- clipboard.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyCodeBlockFallback, copyTextToClipboard } from '../src/lib/clipboard';

interface FakeDocument {
  execCommand: ReturnType<typeof vi.fn>;
  createElement: ReturnType<typeof vi.fn>;
  body: { appendChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> };
  textarea: { value: string; setAttribute: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };
}

function installDocument(execResult: boolean | Error): FakeDocument {
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
  };
  const doc: FakeDocument = {
    execCommand: vi.fn().mockImplementation(() => {
      if (execResult instanceof Error) throw execResult;
      return execResult;
    }),
    createElement: vi.fn().mockReturnValue(textarea),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    textarea: textarea as FakeDocument['textarea'],
  };
  vi.stubGlobal('document', doc);
  return doc;
}

function installNavigator(clipboard: unknown): void {
  vi.stubGlobal('navigator', clipboard === undefined ? {} : { clipboard });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyTextToClipboard', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installNavigator({ writeText });

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard is undefined', async () => {
    // Simulates an insecure (plain HTTP) context.
    installNavigator(undefined);
    const doc = installDocument(true);

    await expect(copyTextToClipboard('abc')).resolves.toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(doc.textarea.value).toBe('abc');
    expect(doc.body.appendChild).toHaveBeenCalledTimes(1);
    expect(doc.body.removeChild).toHaveBeenCalledTimes(1);
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    installNavigator({ writeText });
    const doc = installDocument(true);

    await expect(copyTextToClipboard('retry')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
  });

  it('resolves false when both paths fail', async () => {
    installNavigator(undefined);
    installDocument(false);

    await expect(copyTextToClipboard('nope')).resolves.toBe(false);
  });
});

describe('code-block copy fallback', () => {
  it('does not overwrite selected text when a native copy event bubbles on plain HTTP', () => {
    installNavigator(undefined);
    const doc = installDocument(true);
    const copyEvent = { toString: () => '[object ClipboardEvent]' };

    copyCodeBlockFallback(copyEvent);

    expect(doc.execCommand).not.toHaveBeenCalled();
    expect(doc.textarea.value).toBe('');
  });

  it('copies emitted code text when the Clipboard API is unavailable', () => {
    installNavigator(undefined);
    const doc = installDocument(true);

    copyCodeBlockFallback('const host = "example.test";');

    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(doc.textarea.value).toBe('const host = "example.test";');
  });
});
