import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

// Dark dance colors the footer never uses outside of /dance.
const RAINBOW_CYAN = '91,192,190';
const RAINBOW_GREEN = '78,200,126';

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

describe('FooterComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('paints the model name in rainbow while colored', () => {
    setDanceView(true, 0);
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('repaints from the active palette on the next render (no setColors needed)', () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join('\n');
      // Reads currentTheme live, so a palette swap changes the emitted colours.
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it('shows the effort for an effort-capable model', () => {
    const effortModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'max',
      availableModels: { 'kimi-k2': effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: max');
  });

  it('does not show the effort for a legacy boolean model', () => {
    const plainModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      capabilities: ['thinking'],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join('\n');

    expect(rendered).toContain('thinking');
    expect(rendered).not.toContain('thinking:high');
  });
});

describe('FooterComponent overrides', () => {
  it('shows the overridden effort list', () => {
    const effortModelWithOverride: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: high');
  });
});

describe('FooterComponent displayName override', () => {
  it('renders the overridden display name', () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('Custom Name');
    expect(footer.render(120).join('\n')).not.toContain('Remote Name');
  });
});

describe('FooterComponent subagent model badge', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('hides the subagent badge when the dual-model-routing flag is off', () => {
    setExperimentalFeatures([]);
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      subagentModel: 'glm-5.2',
      availableModels: {
        'kimi-k3': { provider: 'managed:kimi-code', model: 'kimi-k3', maxContextSize: 1_048_576 },
        'glm-5.2': { provider: 'zai', model: 'glm-5.2', maxContextSize: 1_000_000, displayName: 'GLM-5.2' },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(140).join('\n');

    // Even with a subagentModel set, the badge is hidden when the flag is off.
    expect(rendered).not.toContain('subagents:');
  });

  it('hides the subagent badge when no subagent model is set', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    const footer = new FooterComponent(appState);
    const rendered = footer.render(120).join('\n');

    expect(rendered).not.toContain('subagents:');
  });

  it('shows the subagent model when the flag is on and a distinct model is set', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      subagentModel: 'glm-5.2',
      availableModels: {
        'kimi-k3': {
          provider: 'managed:kimi-code',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
        },
        'glm-5.2': {
          provider: 'zai',
          model: 'glm-5.2',
          maxContextSize: 1_000_000,
          displayName: 'GLM-5.2',
        },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(140).join('\n');

    expect(rendered).toContain('subagents:');
    expect(rendered).toContain('GLM-5.2');
  });

  it('hides the subagent badge when subagentModel equals the main model', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      subagentModel: 'kimi-k3',
      availableModels: {
        'kimi-k3': {
          provider: 'managed:kimi-code',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
          displayName: 'Kimi K3',
        },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(140).join('\n');

    // Even with the flag on and a subagentModel set, the badge is hidden
    // when the alias is identical to the main model (nothing distinct to show).
    expect(rendered).not.toContain('subagents:');
  });

  it('shows the badge when the model is the same but the thinking effort differs', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      thinkingEffort: 'low',
      subagentModel: 'kimi-k3',
      subagentThinkingEffort: 'high',
      availableModels: {
        'kimi-k3': {
          provider: 'managed:kimi-code',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
          displayName: 'Kimi K3',
        },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(140).join('\n');

    expect(rendered).toContain('subagents:');
    expect(rendered).toContain('Kimi K3 · high');
  });

  it('shows the badge with provider prefix when the model name is the same but the provider differs', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    // Two aliases serve the same underlying model (kimi-k3) via different
    // providers: the main agent uses managed:kimi-code, the subagent uses
    // opencode-go. The badge shows the provider prefix on the subagent side
    // so the user can tell the routes apart.
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      subagentModel: 'kimi-k3-opencode',
      availableModels: {
        'kimi-k3': {
          provider: 'managed:kimi-code',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
          displayName: 'Kimi K3',
        },
        'kimi-k3-opencode': {
          provider: 'opencode-go',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
          displayName: 'Kimi K3',
        },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(160).join('\n');

    expect(rendered).toContain('subagents:');
    // The provider prefix is shown so the user can tell the routes apart.
    expect(rendered).toContain('opencode-go/Kimi K3');
  });

  it('appends the thinking-effort suffix to the subagent badge when set', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      subagentModel: 'glm-5.2',
      subagentThinkingEffort: 'high',
      availableModels: {
        'kimi-k3': {
          provider: 'managed:kimi-code',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
        },
        'glm-5.2': {
          provider: 'zai',
          model: 'glm-5.2',
          maxContextSize: 1_000_000,
          displayName: 'GLM-5.2',
        },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(140).join('\n');

    expect(rendered).toContain('GLM-5.2 · high');
  });

  it('shows no effort suffix when subagentThinkingEffort is unset', () => {
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    const state: AppState = {
      ...appState,
      model: 'kimi-k3',
      subagentModel: 'glm-5.2',
      availableModels: {
        'kimi-k3': {
          provider: 'managed:kimi-code',
          model: 'kimi-k3',
          maxContextSize: 1_048_576,
        },
        'glm-5.2': {
          provider: 'zai',
          model: 'glm-5.2',
          maxContextSize: 1_000_000,
          displayName: 'GLM-5.2',
        },
      },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(140).join('\n');

    expect(rendered).toContain('GLM-5.2');
    expect(rendered).not.toContain('GLM-5.2 ·');
  });
});
