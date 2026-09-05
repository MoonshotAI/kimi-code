/**
 * Model favorites — rotation logic and host flow (`commands/config.ts`).
 *
 * Covers `nextFavoriteAlias` (pure rotation step: order, wrap-around,
 * non-favorite current model, catalog filtering, single-favorite no-op) and
 * `rotateToNextFavoriteModel` (Alt+M flow: switches the session without
 * persisting a new default, hints when there is nothing to rotate to).
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/model-favorites.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { nextFavoriteAlias, rotateToNextFavoriteModel } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function model(displayName: string, provider = 'managed:kimi-code'): ModelAlias {
  return {
    provider,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities: ['thinking'],
  } as unknown as ModelAlias;
}

const MODELS: Record<string, ModelAlias> = {
  k2: model('Kimi K2'),
  gpt: model('GPT-5', 'openai'),
  glm: model('GLM-4.7', 'zai'),
};

describe('nextFavoriteAlias', () => {
  const available = new Set(Object.keys(MODELS));

  it('advances to the next favorite in add-order', () => {
    expect(nextFavoriteAlias(['k2', 'gpt', 'glm'], 'k2', available)).toBe('gpt');
    expect(nextFavoriteAlias(['k2', 'gpt', 'glm'], 'gpt', available)).toBe('glm');
  });

  it('wraps from the last favorite back to the first', () => {
    expect(nextFavoriteAlias(['k2', 'gpt', 'glm'], 'glm', available)).toBe('k2');
  });

  it('starts at the first favorite when the current model is not a favorite', () => {
    expect(nextFavoriteAlias(['k2', 'gpt'], 'glm', available)).toBe('k2');
  });

  it('is a no-op when the only favorite is the current model', () => {
    expect(nextFavoriteAlias(['k2'], 'k2', available)).toBeUndefined();
  });

  it('switches to the single favorite when it is not the current model', () => {
    expect(nextFavoriteAlias(['gpt'], 'k2', available)).toBe('gpt');
  });

  it('returns undefined when there are no favorites', () => {
    expect(nextFavoriteAlias([], 'k2', available)).toBeUndefined();
  });

  it('skips favorites missing from the available catalog', () => {
    expect(nextFavoriteAlias(['ghost', 'k2', 'phantom', 'gpt'], 'k2', available)).toBe('gpt');
    expect(nextFavoriteAlias(['ghost', 'phantom'], 'k2', available)).toBeUndefined();
  });
});

interface HostOverrides {
  readonly favoriteModels?: readonly string[];
  readonly currentModel?: string;
  readonly availableModels?: Record<string, ModelAlias>;
}

function makeHost(overrides: HostOverrides = {}) {
  const session = {
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ model: undefined, thinkingEffort: 'on' })),
  };
  const appState = {
    model: overrides.currentModel ?? 'k2',
    thinkingEffort: 'on',
    streamingPhase: 'idle',
    favoriteModels: overrides.favoriteModels ?? [],
    availableModels: overrides.availableModels ?? MODELS,
  };
  const host = {
    state: { appState },
    session,
    engineV2: true,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    showError: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session, appState };
}

describe('rotateToNextFavoriteModel', () => {
  it('switches the session to the next favorite without persisting a default', async () => {
    const { host, session } = makeHost({ favoriteModels: ['k2', 'gpt'] });

    await rotateToNextFavoriteModel(host);

    expect(session.setModel).toHaveBeenCalledWith('gpt');
    expect(host.setAppState).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt' }));
    // Session-only rotation: the status line says "for this session only".
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('for this session only'),
      'success',
    );
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('wraps back to the first favorite from the last', async () => {
    const { host, session } = makeHost({ favoriteModels: ['k2', 'gpt'], currentModel: 'gpt' });

    await rotateToNextFavoriteModel(host);

    expect(session.setModel).toHaveBeenCalledWith('k2');
  });

  it('starts from the first favorite when the current model is not a favorite', async () => {
    const { host, session } = makeHost({ favoriteModels: ['gpt', 'glm'], currentModel: 'k2' });

    await rotateToNextFavoriteModel(host);

    expect(session.setModel).toHaveBeenCalledWith('gpt');
  });

  it('hints instead of switching when there are no favorites', async () => {
    const { host, session } = makeHost({ favoriteModels: [] });

    await rotateToNextFavoriteModel(host);

    expect(session.setModel).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledTimes(1);
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('hints when the only favorite is already the current model', async () => {
    const { host, session } = makeHost({ favoriteModels: ['k2'], currentModel: 'k2' });

    await rotateToNextFavoriteModel(host);

    expect(session.setModel).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledTimes(1);
  });

  it('skips favorites missing from the catalog when rotating', async () => {
    const { host, session } = makeHost({ favoriteModels: ['ghost', 'gpt'] });

    await rotateToNextFavoriteModel(host);

    expect(session.setModel).toHaveBeenCalledWith('gpt');
  });
});
