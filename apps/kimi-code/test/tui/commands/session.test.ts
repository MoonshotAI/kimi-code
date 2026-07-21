import { describe, expect, it, vi } from 'vitest';

import { handleTitleOffCommand, handleTitleOnCommand } from '#/tui/commands/session';

function fakeHost(showSessionTitleInFooter: boolean) {
  return {
    state: {
      appState: { showSessionTitleInFooter },
    },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    track: vi.fn(),
  };
}

describe('/titleon', () => {
  it('enables the footer session title for the current session only', () => {
    const host = fakeHost(false);

    handleTitleOnCommand(host);

    expect(host.setAppState).toHaveBeenCalledWith({ showSessionTitleInFooter: true });
    expect(host.track).toHaveBeenCalledWith('session_title_footer_changed', { visible: true });
    expect(host.showStatus).toHaveBeenCalledWith(
      'Session title now shown in the footer (this session only).',
    );
  });

  it('is idempotent when the title is already shown', () => {
    const host = fakeHost(true);

    handleTitleOnCommand(host);

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Session title is already shown in the footer.',
    );
  });
});

describe('/titleoff', () => {
  it('disables the footer session title', () => {
    const host = fakeHost(true);

    handleTitleOffCommand(host);

    expect(host.setAppState).toHaveBeenCalledWith({ showSessionTitleInFooter: false });
    expect(host.track).toHaveBeenCalledWith('session_title_footer_changed', { visible: false });
    expect(host.showStatus).toHaveBeenCalledWith('Session title hidden from the footer.');
  });

  it('is idempotent when the title is already hidden', () => {
    const host = fakeHost(false);

    handleTitleOffCommand(host);

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Session title is already hidden from the footer.',
    );
  });
});
