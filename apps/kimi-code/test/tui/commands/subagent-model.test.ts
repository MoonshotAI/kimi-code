import { describe, expect, it, vi } from 'vitest';

import { handleSubagentModelCommand } from '#/tui/commands/subagent-model';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

function makeHost(options: {
  bindings?: Record<string, { model?: string; thinkingEffort?: string; inherit?: boolean }>;
  availableModels?: Record<string, { supportEfforts?: string[] }>;
}) {
  const bindings = options.bindings ?? {};
  const availableModels = options.availableModels ?? { 'k3': {}, 'glm': { supportEfforts: ['low', 'high'] } };
  const state = {
    appState: {
      availableModels,
      streamingPhase: 'idle',
      isCompacting: false,
    },
  };
  let mountedPanel: MountedPanel | null = null;
  const session = {
    id: 'session-1',
    getSubagentBindings: vi.fn(async () => bindings),
    setSubagentBinding: vi.fn(
      async (_type: string, _binding?: unknown) => ({ configPath: '/repo/.kimi-code/local.toml' }),
    ),
  };
  const host = {
    state,
    session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mountedPanel = panel;
    }),
    restoreEditor: vi.fn(() => {
      mountedPanel = null;
    }),
  } as unknown as SlashCommandHost & {
    session: typeof session;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
  };
  return { host, session, getMountedPanel: () => mountedPanel };
}

describe('handleSubagentModelCommand', () => {
  it('shows guidance when no bindings exist', async () => {
    const { host } = makeHost({ bindings: {} });

    await handleSubagentModelCommand(host, '');

    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('No subagent model bindings'));
  });

  it('lists current bindings', async () => {
    const { host } = makeHost({
      bindings: {
        coder: { model: 'k3', thinkingEffort: 'high' },
        explore: { inherit: true },
      },
    });

    await handleSubagentModelCommand(host, 'list');

    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('coder: k3, thinking high'),
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('explore: inherit from main agent'),
    );
  });

  it('clears a binding', async () => {
    const { host, session } = makeHost({});

    await handleSubagentModelCommand(host, 'clear coder');

    expect(session.setSubagentBinding).toHaveBeenCalledWith('coder', undefined);
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Cleared model binding for "coder"'),
      'success',
    );
  });

  it('binds a model without an effort question when the model declares no efforts', async () => {
    const { host, session, getMountedPanel } = makeHost({});

    await handleSubagentModelCommand(host, 'set coder');
    // Options: [inherit, glm, k3] — pick k3 (no declared efforts).
    getMountedPanel()?.handleInput('[B');
    getMountedPanel()?.handleInput('[B');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.setSubagentBinding).toHaveBeenCalledWith('coder', { model: 'k3' });
    });
  });

  it('binds a model with a chosen thinking effort', async () => {
    const { host, session, getMountedPanel } = makeHost({});

    await handleSubagentModelCommand(host, 'set explore');
    // Options: [inherit, glm, k3] — pick glm.
    getMountedPanel()?.handleInput('[B');
    getMountedPanel()?.handleInput(' ');
    // Effort options: [inherit, low, high] — pick high.
    await vi.waitFor(() => expect(getMountedPanel()).not.toBeNull());
    getMountedPanel()?.handleInput('[B');
    getMountedPanel()?.handleInput('[B');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.setSubagentBinding).toHaveBeenCalledWith('explore', {
        model: 'glm',
        thinkingEffort: 'high',
      });
    });
  });

  it('records an explicit inherit choice', async () => {
    const { host, session, getMountedPanel } = makeHost({});

    await handleSubagentModelCommand(host, 'set explore');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.setSubagentBinding).toHaveBeenCalledWith('explore', { inherit: true });
    });
  });

  it('rejects a set without a type', async () => {
    const { host } = makeHost({});

    await handleSubagentModelCommand(host, 'set');

    expect(host.showError).toHaveBeenCalledWith('Usage: /subagent-model set <type>');
  });
});
