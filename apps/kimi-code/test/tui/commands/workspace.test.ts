import {
  BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
  type ManagedWorkspace,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleWorkspaceCommand } from '#/tui/commands/workspace';

const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;

function makeWorkspaces(): readonly ManagedWorkspace[] {
  return [
    {
      kind: 'personal',
      key: 'personal',
      target: { kind: 'personal' },
      name: 'Alice',
      kindLabel: 'Personal workspace',
      current: true,
      disabled: false,
      switchable: true,
      roles: ['ROLE_OWNER'],
    },
    {
      kind: 'business',
      key: 'business:biz-1',
      target: { kind: 'business', businessId: 'biz-1' },
      businessId: 'biz-1',
      name: 'Moonshot Enterprise',
      status: 'STATUS_ACTIVE',
      kindLabel: 'Business workspace',
      current: false,
      disabled: false,
      switchable: true,
      roles: ['ROLE_OWNER'],
    },
  ];
}

function createHostStub(overrides: {
  hasToken?: boolean;
  listWorkspacesResult?: Awaited<ReturnType<SlashCommandHost['harness']['auth']['listWorkspaces']>>;
  onPanelMounted?: (panel: Component & Focusable) => void;
}) {
  const stopSpinner = vi.fn();
  const host = {
    harness: {
      auth: {
        status: vi.fn(async () => ({
          providers: [
            {
              providerName: 'managed:kimi-code',
              hasToken: overrides.hasToken ?? true,
            },
          ],
        })),
        listWorkspaces: vi.fn(
          async () =>
            overrides.listWorkspacesResult ?? {
              kind: 'ok' as const,
              workspaces: makeWorkspaces(),
            },
        ),
      },
    },
    authFlow: {
      handleBusinessMembershipRevoked: vi.fn(),
      switchWorkspace: vi.fn(async () => ({
        displayName: 'Moonshot Enterprise',
      })),
    },
    setAppState: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    restoreEditor: vi.fn(),
    beginAuthBlock: vi.fn(() => () => {}),
    showLoginProgressSpinner: vi.fn(() => ({
      stop: stopSpinner,
      dismiss: vi.fn(),
    })),
    mountEditorReplacement: vi.fn((panel: Component & Focusable) => {
      overrides.onPanelMounted?.(panel);
    }),
  } as unknown as SlashCommandHost & {
    authFlow: {
      handleBusinessMembershipRevoked: ReturnType<typeof vi.fn>;
      switchWorkspace: ReturnType<typeof vi.fn>;
    };
    setAppState: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
  };

  return { host, stopSpinner };
}

describe('handleWorkspaceCommand', () => {
  it('shows an error when the user is not logged in to Kimi Code', async () => {
    const { host } = createHostStub({ hasToken: false });
    await handleWorkspaceCommand(host);
    expect(host.showError).toHaveBeenCalledWith(
      'Not logged in to Kimi Code. Send /login to authenticate.',
    );
  });

  it('informs pure personal users that no business workspaces are available without opening the picker', async () => {
    const { host } = createHostStub({
      listWorkspacesResult: {
        kind: 'ok',
        workspaces: [makeWorkspaces()[0]!],
      },
    });
    await handleWorkspaceCommand(host);
    expect(host.setAppState).toHaveBeenCalledWith({
      managedWorkspace: { hasBusinessWorkspace: false },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'No business workspaces available for this account.',
    );
  });

  it('switches silently to the selected workspace and prints the billing confirmation', async () => {
    const { host, stopSpinner } = createHostStub({
      onPanelMounted: (panel) => {
        panel.handleInput?.(DOWN);
        panel.handleInput?.('\r');
      },
    });

    await handleWorkspaceCommand(host);

    expect(host.authFlow.switchWorkspace).toHaveBeenCalledWith(
      { kind: 'business', businessId: 'biz-1' },
      expect.objectContaining({ businessId: 'biz-1', name: 'Moonshot Enterprise' }),
    );
    expect(stopSpinner).toHaveBeenCalledWith({
      ok: true,
      label: 'Switched to Moonshot Enterprise. Usage will be billed accordingly.',
    });
  });

  it('switches from a business workspace back to the personal workspace', async () => {
    const { host, stopSpinner } = createHostStub({
      listWorkspacesResult: {
        kind: 'ok',
        workspaces: [
          {
            kind: 'personal',
            key: 'personal',
            target: { kind: 'personal' },
            name: 'Alice',
            kindLabel: 'Personal workspace',
            current: false,
            disabled: false,
            switchable: true,
            roles: ['owner'],
          },
          {
            kind: 'business',
            key: 'business:biz-1',
            target: { kind: 'business', businessId: 'biz-1' },
            businessId: 'biz-1',
            name: 'Moonshot Enterprise',
            status: 'STATUS_ACTIVE',
            kindLabel: 'Business workspace',
            current: true,
            disabled: false,
            switchable: true,
            roles: ['member'],
          },
        ],
      },
      onPanelMounted: (panel) => {
        panel.handleInput?.('\x1b[A');
        panel.handleInput?.('\r');
      },
    });
    host.authFlow.switchWorkspace.mockResolvedValueOnce({
      displayName: 'Alice · Personal workspace',
    });

    await handleWorkspaceCommand(host);

    expect(host.authFlow.switchWorkspace).toHaveBeenCalledWith(
      { kind: 'personal' },
      expect.objectContaining({ kind: 'personal', name: 'Alice' }),
    );
    expect(stopSpinner).toHaveBeenCalledWith({
      ok: true,
      label: 'Switched to Alice · Personal workspace. Usage will be billed accordingly.',
    });
  });

  it('triggers membership revocation handling when listWorkspaces returns REASON_BUSINESS_MEMBER_REMOVED', async () => {
    const { host } = createHostStub({
      listWorkspacesResult: {
        kind: 'error',
        status: 401,
        errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
        message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
      },
    });

    await handleWorkspaceCommand(host);

    expect(host.authFlow.handleBusinessMembershipRevoked).toHaveBeenCalledTimes(1);
    expect(host.showError).toHaveBeenCalledWith(BUSINESS_MEMBERSHIP_REVOKED_MESSAGE);
  });

  it('defers mounting the selector when a tool approval arrives while workspaces are loading', async () => {
    const state = {
      editorReplacementMounted: false,
      activeDialog: null as string | null,
      livePane: {
        pendingApproval: null as object | null,
        pendingQuestion: null as object | null,
      },
    };
    const { host } = createHostStub({});
    (host as unknown as { state: typeof state }).state = state;
    host.harness.auth.listWorkspaces = vi.fn(async () => {
      state.livePane.pendingApproval = { id: 'approval-1' };
      return {
        kind: 'ok' as const,
        workspaces: makeWorkspaces(),
      };
    });

    await handleWorkspaceCommand(host);

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Finish or dismiss the active prompt before switching workspaces.',
      'warning',
    );
  });
});
