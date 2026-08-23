/**
 * Scenario: /update-all-session-models command behavior in the interactive TUI.
 * Responsibilities: reuse /model's picker UX, show the active-session count and
 * require confirmation, apply the chosen model to every active session (current
 * included), skip/fail resiliently, and persist the new-session default.
 * Wiring: real command + dialogs with the SDK/session boundaries stubbed by a
 * small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/update-all-session-models.test.ts
 */
import type { ModelAlias, Session, SessionSummary, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleUpdateAllSessionModelsCommand } from '#/tui/commands/config';
import { ConfirmDialogComponent } from '#/tui/components/dialogs/confirm-dialog';
import {
  TabbedModelSelectorComponent,
  type TabbedModelSelectorOptions,
} from '#/tui/components/dialogs/tabbed-model-selector';
import { type ConfirmDialogOptions } from '#/tui/components/dialogs/confirm-dialog';

interface RigOptions {
  readonly listed?: readonly SessionSummary[];
  readonly getSessionReturns?: Session | undefined;
  readonly resumeRejects?: boolean;
}

function model(name: string): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeSession(id: string): Session {
  return {
    id,
    workDir: '/tmp/work',
    setModel: vi.fn(async () => {}),
  } as unknown as Session;
}

function makeHost(options?: RigOptions) {
  const current = makeSession('ses-current');
  const other = makeSession('ses-other');
  const appState = {
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
    model: 'k2',
    thinkingEffort: 'off',
  };
  const listed: readonly SessionSummary[] =
    options?.listed ?? [
      {
        id: 'ses-other',
        workDir: '/tmp/work',
        sessionDir: '/tmp/work',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
  const host = {
    state: { appState, transcriptEntries: [] },
    session: current,
    harness: {
      listSessions: vi.fn(async () => listed),
      getSession: vi.fn(() => options?.getSessionReturns),
      resumeSession: vi.fn(async (input: { id: string }) =>
        options?.resumeRejects ? Promise.reject(new Error('model k2 not found')) : input.id === 'ses-other' ? other : makeSession(input.id),
      ),
      getConfig: vi.fn(async () => ({})),
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      listSessions: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
      resumeSession: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    session: Session;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
  };
  return { host, current, other };
}

function picker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): TabbedModelSelectorOptions {
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: TabbedModelSelectorOptions }).opts;
}

function confirmDialog(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): ConfirmDialogOptions {
  const component = host.mountEditorReplacement.mock.calls[1]![0];
  expect(component).toBeInstanceOf(ConfirmDialogComponent);
  return (component as unknown as { opts: ConfirmDialogOptions }).opts;
}

const SELECTION = { alias: 'cheap', thinking: 'off' as ThinkingEffort };

describe('handleUpdateAllSessionModelsCommand', () => {
  it('opens the same model picker as /model with the active-session set', async () => {
    const { host } = makeHost();

    await handleUpdateAllSessionModelsCommand(host, '');

    expect(host.harness.listSessions).toHaveBeenCalled();
    // Current session is folded into the listed set, so two active sessions.
    expect(Object.keys(picker(host).models)).toEqual(['k2', 'cheap']);
  });

  it('requires confirmation, then applies to every session and persists the default', async () => {
    const { host, current, other } = makeHost();

    await handleUpdateAllSessionModelsCommand(host, '');
    picker(host).onSelect(SELECTION);
    const dialog = confirmDialog(host);
    expect(dialog.title).toContain('2 active sessions');

    dialog.onResolve(true);

    await vi.waitFor(() => {
      expect(current.setModel).toHaveBeenCalledWith('cheap');
    });
    expect(other.setModel).toHaveBeenCalledWith('cheap');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ defaultModel: 'cheap' });
    expect(host.setAppState).toHaveBeenCalledWith({ model: 'cheap' });
    expect(host.showStatus).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('makes no changes when the user cancels the confirmation', async () => {
    const { host, current, other } = makeHost();

    await handleUpdateAllSessionModelsCommand(host, '');
    picker(host).onSelect(SELECTION);
    confirmDialog(host).onResolve(false);

    expect(current.setModel).not.toHaveBeenCalled();
    expect(other.setModel).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Cancelled — no sessions were changed.', 'textDim');
  });

  it('resumes sessions not already open, and reports a skipped session without aborting the rest', async () => {
    const { host, current } = makeHost({ getSessionReturns: undefined, resumeRejects: true });

    await handleUpdateAllSessionModelsCommand(host, '');
    picker(host).onSelect(SELECTION);
    confirmDialog(host).onResolve(true);

    await vi.waitFor(() => {
      expect(host.showNotice).toHaveBeenCalled();
    });
    // The current session still switches; the unresolvable one is reported, not fatal.
    expect(current.setModel).toHaveBeenCalledWith('cheap');
    expect(host.showStatus).toHaveBeenCalled();
  });
});
