/**
 * `/priority` command scenario: the dispatcher toggles the active session's
 * provider service tier and updates the visible TUI state. The session is the
 * only stubbed boundary; command resolution and dispatch are real.
 */

import { describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';

function makeHost(
  priority: boolean,
  secondaryModel?: { readonly model?: string; readonly priority?: boolean },
) {
  const state = {
    appState: {
      priority,
      streamingPhase: 'idle' as const,
      isCompacting: false,
    },
  };
  const session = {
    setPriority: vi.fn(async (_enabled: boolean) => {}),
    applyPersistedSecondaryModel: vi.fn(async () => {}),
  };
  const host = {
    state,
    session,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    requireSession: () => session,
    harness: {
      getConfig: vi.fn(async () => ({ secondaryModel })),
      setConfig: vi.fn(async () => ({ secondaryModel })),
    },
    setAppState: vi.fn((patch: { priority?: boolean }) => Object.assign(state.appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    track: vi.fn(),
    sendNormalUserInput: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session, state };
}

interface PriorityPickerOptions {
  readonly currentValue: string;
  readonly onSelect: (value: string) => void;
}

function mountedPicker(host: SlashCommandHost): PriorityPickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = vi.mocked(host.mountEditorReplacement).mock.calls[0]![0];
  expect(component).toBeInstanceOf(ChoicePickerComponent);
  return (component as unknown as { opts: PriorityPickerOptions }).opts;
}

describe('/priority command (provider service-tier toggle)', () => {
  it('opens the four-way selector when no secondary model is configured', async () => {
    const { host } = makeHost(false);

    dispatchInput(host, '/priority');

    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    });
    expect(mountedPicker(host).currentValue).toBe('off');
  });

  it('marks the independent main-agent setting as current', async () => {
    const { host } = makeHost(true);

    dispatchInput(host, '/priority');

    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    });
    expect(mountedPicker(host).currentValue).toBe('main');
  });

  it('enables subagent priority without configuring a secondary model', async () => {
    const { host, session } = makeHost(false);

    dispatchInput(host, '/priority');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    });
    mountedPicker(host).onSelect('subagents');

    await vi.waitFor(() => {
      expect(host.harness.setConfig).toHaveBeenCalledWith({
        secondaryModel: { priority: true },
      });
    });
    expect(session.setPriority).not.toHaveBeenCalled();
    expect(session.applyPersistedSecondaryModel).toHaveBeenCalledOnce();
  });

  it('updates both settings independently in one selection', async () => {
    const { host, session, state } = makeHost(false, { priority: true });

    dispatchInput(host, '/priority');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    });
    expect(mountedPicker(host).currentValue).toBe('subagents');
    mountedPicker(host).onSelect('main');

    await vi.waitFor(() => {
      expect(session.setPriority).toHaveBeenCalledWith(true);
      expect(session.applyPersistedSecondaryModel).toHaveBeenCalledOnce();
    });
    expect(state.appState.priority).toBe(true);
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { priority: false },
    });
  });
});
