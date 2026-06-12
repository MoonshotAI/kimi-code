import { describe, expect, it, vi } from 'vitest';

import { applySpiceupChoice } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

function fakeHost(overrides?: Partial<AppState>): {
  state: { appState: AppState; theme: { palette: typeof darkColors } };
  setAppState: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  session: { setGenerationKwargs: ReturnType<typeof vi.fn> };
} {
  const appState: AppState = {
    model: 'test-model',
    workDir: '/tmp/test',
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    swarmMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {},
    availableProviders: {},
    generationKwargs: null,
    sessionTitle: null,
    mcpServersSummary: null,
    ...overrides,
  };

  return {
    state: { appState, theme: { palette: darkColors } },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    session: { setGenerationKwargs: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('applySpiceupChoice', () => {
  it('sends converted kwargs to the session and updates app state', async () => {
    const host = fakeHost();

    await applySpiceupChoice(host, {
      temperature: 0.7,
      topP: 0.9,
      topK: 50,
      maxTokens: 4096,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    });

    expect(host.session.setGenerationKwargs).toHaveBeenCalledWith({
      temperature: 0.7,
      top_p: 0.9,
      top_k: 50,
      max_tokens: 4096,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
    });
    expect(host.setAppState).toHaveBeenCalledWith({
      generationKwargs: {
        temperature: 0.7,
        topP: 0.9,
        topK: 50,
        maxTokens: 4096,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
      },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'Sampling overrides set: temperature, top_p, top_k, max_tokens, frequency_penalty, presence_penalty',
    );
  });

  it('clears overrides when the selection is empty', async () => {
    const host = fakeHost({ generationKwargs: { temperature: 0.5 } });

    await applySpiceupChoice(host, {});

    expect(host.session.setGenerationKwargs).toHaveBeenCalledWith({});
    expect(host.setAppState).toHaveBeenCalledWith({ generationKwargs: null });
    expect(host.showStatus).toHaveBeenCalledWith('Sampling overrides cleared for this session.');
  });

  it('shows an error when there is no active session', async () => {
    const host = fakeHost();
    host.session = undefined as unknown as typeof host.session;

    await applySpiceupChoice(host, { temperature: 0.7 });

    expect(host.showError).toHaveBeenCalledWith(
      'No active session. Send /login to login.',
    );
    expect(host.session).toBeUndefined();
  });

  it('surfaces session errors to the user', async () => {
    const host = fakeHost();
    host.session.setGenerationKwargs = vi.fn().mockRejectedValue(new Error('provider refused'));

    await applySpiceupChoice(host, { temperature: 0.7 });

    expect(host.showError).toHaveBeenCalledWith('Failed to set sampling overrides: provider refused');
  });
});
