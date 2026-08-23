// packages/app-composer/test/clipboard-write.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextWithFlavor, takeComposerClipboardFlavor } from '../src/clipboardWrite';

const writeText = vi.fn().mockResolvedValue(undefined);

function stubClipboard(present = true): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: present ? { clipboard: { writeText } } : undefined,
    configurable: true,
    writable: true,
  });
}

interface FakeDocument {
  execCommand: ReturnType<typeof vi.fn>;
  createElement: ReturnType<typeof vi.fn>;
  body: { appendChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> };
  textarea: { value: string; setAttribute: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };
}

/** The node test env has no DOM — stub the tiny `document` surface the
 *  legacy execCommand fallback touches. `execResult` is execCommand's return
 *  (true = copy succeeded), or an Error to make it throw. */
function stubDocument(execResult: boolean | Error): FakeDocument {
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
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  return doc;
}

describe('copyTextWithFlavor + takeComposerClipboardFlavor (in-process stash)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { document?: unknown }).document;
    takeComposerClipboardFlavor('');
  });

  it('stashes the flavor on a successful write and hands it out once', async () => {
    stubClipboard();
    writeText.mockClear();
    expect(await copyTextWithFlavor('plain text', '{"v":1}')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('plain text');

    expect(takeComposerClipboardFlavor('plain text')).toBe('{"v":1}');
    // Single-use: a second take gets nothing, even on the same text.
    expect(takeComposerClipboardFlavor('plain text')).toBeUndefined();
  });

  it('clears the stash on a mismatching paste — every paste is the stash’s single shot', async () => {
    stubClipboard();
    await copyTextWithFlavor('expected', '{"v":1}');

    expect(takeComposerClipboardFlavor('something else')).toBeUndefined();
    // The clipboard's current contents are unobservable (the user may have
    // copied elsewhere since), so the mismatch settles the stash: a later
    // coincidental paste of the old text must NOT resurrect the stale flavor.
    expect(takeComposerClipboardFlavor('expected')).toBeUndefined();
  });

  it('clears the stash when a plain-only copy happens next', async () => {
    stubClipboard();
    await copyTextWithFlavor('with flavor', '{"v":1}');
    await copyTextWithFlavor('plain only');

    expect(takeComposerClipboardFlavor('with flavor')).toBeUndefined();
  });

  it('expires the stash after its TTL (a later same-text paste does not resurrect)', async () => {
    vi.useFakeTimers();
    stubClipboard();
    await copyTextWithFlavor('plain text', '{"v":1}');

    // Inside the window the stash still hits.
    vi.advanceTimersByTime(30_000);
    expect(takeComposerClipboardFlavor('plain text')).toBe('{"v":1}');

    await copyTextWithFlavor('plain text', '{"v":2}');
    // Past the TTL the same text no longer restores — the stash is settled.
    vi.advanceTimersByTime(61_000);
    expect(takeComposerClipboardFlavor('plain text')).toBeUndefined();

    // …and a fresh write after expiry re-arms as usual.
    expect(await copyTextWithFlavor('again', '{"v":3}')).toBe(true);
    expect(takeComposerClipboardFlavor('again')).toBe('{"v":3}');
    vi.useRealTimers();
  });

  it('returns false with no clipboard at all and stashes nothing', async () => {
    stubClipboard(false);
    // No document either (node env): both paths are unavailable.
    expect(await copyTextWithFlavor('x', '{"v":1}')).toBe(false);
    expect(takeComposerClipboardFlavor('x')).toBeUndefined();
  });

  it('falls back to execCommand when the Clipboard API is missing (plain-HTTP web)', async () => {
    stubClipboard(false);
    const doc = stubDocument(true);

    expect(await copyTextWithFlavor('abc', '{"v":1}')).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(doc.textarea.value).toBe('abc');
    expect(doc.body.appendChild).toHaveBeenCalledTimes(1);
    expect(doc.body.removeChild).toHaveBeenCalledTimes(1);
    // A real copy stashes the flavor too — the stash never leaves the process.
    expect(takeComposerClipboardFlavor('abc')).toBe('{"v":1}');
  });

  it('falls back to execCommand when writeText rejects (permission denied)', async () => {
    stubClipboard();
    writeText.mockRejectedValueOnce(new Error('denied'));
    const doc = stubDocument(true);

    expect(await copyTextWithFlavor('abc', '{"v":1}')).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(takeComposerClipboardFlavor('abc')).toBe('{"v":1}');
  });

  it('reports false and stashes nothing when the execCommand fallback fails', async () => {
    // The desktop Electron embedder: execCommand('copy') returns false.
    stubClipboard(false);
    const doc = stubDocument(false);

    expect(await copyTextWithFlavor('abc', '{"v":1}')).toBe(false);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(takeComposerClipboardFlavor('abc')).toBeUndefined();
  });

  it('reports false and stashes nothing when execCommand throws', async () => {
    stubClipboard(false);
    stubDocument(new Error('not allowed'));

    expect(await copyTextWithFlavor('abc', '{"v":1}')).toBe(false);
    expect(takeComposerClipboardFlavor('abc')).toBeUndefined();
  });
});
