import { describe, expect, it, vi } from 'vitest';

import { handleArchiveCommand } from '#/tui/commands/session';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(overrides: {
  readonly hasSession?: boolean;
  readonly archived?: boolean;
} = {}) {
  const session = {
    id: 'ses-1',
    summary: { archived: overrides.archived === true },
    archive: vi.fn(async () => {}),
    unarchive: vi.fn(async () => {}),
  };
  const host = {
    session: overrides.hasSession === false ? undefined : session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleArchiveCommand', () => {
  it('shows an error when there is no active session', async () => {
    const { host } = makeHost({ hasSession: false });
    await handleArchiveCommand(host, '');
    expect(host.showError).toHaveBeenCalled();
    expect(host.session).toBeUndefined();
  });

  it('archives the current session when no subcommand is given', async () => {
    const { host, session } = makeHost({ archived: false });
    await handleArchiveCommand(host, '');
    expect(session.archive).toHaveBeenCalledOnce();
    expect(session.unarchive).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith(
      'Session archived',
      'Hidden from the default session picker.',
    );
    expect(host.track).toHaveBeenCalledWith('session_archived', { session_id: 'ses-1' });
  });

  it('unarchives the current session when given "off"', async () => {
    const { host, session } = makeHost({ archived: true });
    await handleArchiveCommand(host, 'off');
    expect(session.unarchive).toHaveBeenCalledOnce();
    expect(session.archive).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith(
      'Session unarchived',
      'Visible in the default session picker.',
    );
    expect(host.track).toHaveBeenCalledWith('session_unarchived', { session_id: 'ses-1' });
  });

  it('unarchives the current session when given "unarchive"', async () => {
    const { host, session } = makeHost({ archived: true });
    await handleArchiveCommand(host, 'unarchive');
    expect(session.unarchive).toHaveBeenCalledOnce();
    expect(session.archive).not.toHaveBeenCalled();
  });

  it('reports when the session is already archived', async () => {
    const { host, session } = makeHost({ archived: true });
    await handleArchiveCommand(host, '');
    expect(session.archive).not.toHaveBeenCalled();
    expect(session.unarchive).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Session is already archived.');
  });

  it('reports when the session is not archived', async () => {
    const { host, session } = makeHost({ archived: false });
    await handleArchiveCommand(host, 'off');
    expect(session.archive).not.toHaveBeenCalled();
    expect(session.unarchive).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Session is not archived.');
  });
});
