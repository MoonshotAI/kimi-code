import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installExternalLinkGuard } from '../../../src/main/shell/external-links';

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  showFailureFeedback: vi.fn(),
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { error: mocks.error },
  redactUrlForLog: (url: string) => url.split(/[?#]/)[0],
}));

vi.mock('../../../src/main/app/failure-dialog', () => ({
  showFailureFeedback: mocks.showFailureFeedback,
}));

type WindowOpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };
type NavigateListener = (event: { preventDefault: () => void }, url: string) => void;

function contentsStub(): {
  contents: WebContents;
  windowOpen: () => WindowOpenHandler;
  navigate: () => NavigateListener;
} {
  let windowOpenHandler: WindowOpenHandler | undefined;
  let navigateListener: NavigateListener | undefined;
  const contents = {
    setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
      windowOpenHandler = handler;
    }),
    on: vi.fn((event: string, listener: NavigateListener) => {
      if (event === 'will-navigate') navigateListener = listener;
    }),
    getURL: vi.fn(() => 'app://renderer/index.html'),
    session: { downloadURL: vi.fn() },
  } as unknown as WebContents;
  return {
    contents,
    windowOpen: () => {
      if (windowOpenHandler === undefined) throw new Error('window-open handler missing');
      return windowOpenHandler;
    },
    navigate: () => {
      if (navigateListener === undefined) throw new Error('navigation listener missing');
      return navigateListener;
    },
  };
}

async function flushRejection(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('external link failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['window-open', 'will-navigate'])('handles openExternal rejection from %s', async (entry) => {
    const { contents, windowOpen, navigate } = contentsStub();
    const failure = new Error('Failed to open URL');
    const openExternal = vi.fn((_url: string) => Promise.reject(failure));
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      installExternalLinkGuard(contents, openExternal);
      if (entry === 'window-open') {
        expect(windowOpen()({ url: 'https://example.com/docs?token=secret' })).toEqual({ action: 'deny' });
      } else {
        const preventDefault = vi.fn();
        navigate()({ preventDefault }, 'https://example.com/docs?token=secret');
        expect(preventDefault).toHaveBeenCalledOnce();
      }
      await flushRejection();
      expect(unhandled).not.toHaveBeenCalled();
      expect(openExternal).toHaveBeenCalledWith('https://example.com/docs?token=secret');
      expect(mocks.error).toHaveBeenCalledWith(
        '[kimi-desktop] external link open failed: https://example.com/docs',
        failure,
      );
      expect(mocks.showFailureFeedback).toHaveBeenCalledWith(
        'external-link',
        expect.any(Object),
        expect.any(Object),
        'https://example.com/docs?token=secret',
      );
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
