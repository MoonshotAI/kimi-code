import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyCodeBlockFallback } from './clipboard';

// The package test suite runs in the default node environment (no jsdom), so
// we mock the tiny `navigator` / `document` surface that the helper touches.

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

describe('copyCodeBlockFallback', () => {
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

  it('does nothing when the Clipboard API already wrote the text', () => {
    installNavigator({ writeText: vi.fn() });
    const doc = installDocument(true);

    copyCodeBlockFallback('const host = "example.test";');

    expect(doc.execCommand).not.toHaveBeenCalled();
  });
});
