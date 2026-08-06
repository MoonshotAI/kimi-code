import { buildSkillSlashCommands, isUserActivatableSkill } from '#/tui/commands/index';
import {
  dispatchInput,
  extractInlineSkillActivations,
  type InlineSkillActivation,
  type SlashCommandHost,
} from '#/tui/commands/dispatch';
import { LLM_NOT_SET_MESSAGE } from '#/tui/constant/kimi-tui';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

function skill(
  name: string,
  type?: SkillSummary['type'],
  extra: Partial<SkillSummary> = {},
): SkillSummary {
  return {
    name,
    type,
    description: `${name} skill`,
    ...extra,
  } as SkillSummary;
}

describe('skill slash commands', () => {
  it('allows user-activatable skill types', () => {
    expect(isUserActivatableSkill(skill('default'))).toBe(true);
    expect(isUserActivatableSkill(skill('prompt', 'prompt'))).toBe(true);
    expect(isUserActivatableSkill(skill('inline', 'inline'))).toBe(true);
    expect(isUserActivatableSkill(skill('flow', 'flow'))).toBe(true);
  });

  it('filters non-user-activatable skill types', () => {
    expect(isUserActivatableSkill(skill('agent', 'agent'))).toBe(false);
  });

  it('builds slash commands and command map entries with skill prefixes for non-built-in skills', () => {
    const built = buildSkillSlashCommands([
      skill('review', 'prompt'),
      skill('nested-review', 'prompt', {
        description: 'Nested review skill',
        path: '/skills/parent/nested-review/SKILL.md',
      }),
      skill('agent-only', 'agent'),
      skill('commit', 'flow'),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual([
      'skill:commit',
      'skill:nested-review',
      'skill:review',
    ]);
    expect(built.commands[0]).toMatchObject({
      name: 'skill:commit',
      aliases: [],
      description: 'commit skill',
    });
    expect(built.commands[1]).toMatchObject({
      name: 'skill:nested-review',
      aliases: [],
      description: 'Nested review skill',
    });
    expect([...built.commandMap.entries()]).toEqual([
      ['skill:commit', 'commit'],
      ['skill:nested-review', 'nested-review'],
      ['skill:review', 'review'],
    ]);
  });

  it('sorts built-in skill slash commands before external skill commands', () => {
    const built = buildSkillSlashCommands([
      skill('zeta', 'prompt', { source: 'user' }),
      skill('alpha', 'prompt', { source: 'project' }),
      skill('update-config', 'inline', { source: 'builtin' }),
      skill('mcp-config', 'inline', { source: 'builtin' }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual([
      'mcp-config',
      'update-config',
      'skill:alpha',
      'skill:zeta',
    ]);
    expect([...built.commandMap.entries()]).toEqual([
      ['mcp-config', 'mcp-config'],
      ['update-config', 'update-config'],
      ['skill:alpha', 'alpha'],
      ['skill:zeta', 'zeta'],
    ]);
  });

  it('keeps disableModelInvocation skills slash-invocable', () => {
    const built = buildSkillSlashCommands([
      skill('mcp-config', 'inline', { disableModelInvocation: true, source: 'builtin' }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual(['mcp-config']);
    expect(built.commandMap.get('mcp-config')).toBe('mcp-config');
  });

  it('keeps sub-skills slash-invocable', () => {
    const built = buildSkillSlashCommands([
      skill('outer.inner', 'prompt', {
        isSubSkill: true,
        source: 'project',
      }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual(['outer.inner']);
    expect(built.commandMap.get('outer.inner')).toBe('outer.inner');
  });
});


function makeSkillCommandMap(): Map<string, string> {
  return new Map([
    ['skill:review', 'review'],
    ['skill:security', 'security'],
    ['mcp-config', 'mcp-config'],
  ]);
}

function makeHost(options: {
  streamingPhase?: 'idle' | 'composing';
  isCompacting?: boolean;
  model?: string;
  hasSession?: boolean;
  skillCommandMap?: Map<string, string>;
} = {}) {
  const {
    streamingPhase = 'idle',
    isCompacting = false,
    model = 'kimi-model',
    hasSession = true,
    skillCommandMap = makeSkillCommandMap(),
  } = options;

  const session = hasSession
    ? {
        id: 'session-1',
        activateSkill: vi.fn(),
      }
    : undefined;

  const state = {
    appState: {
      streamingPhase,
      isCompacting,
      model,
    },
  };

  const host = {
    state,
    session,
    skillCommandMap,
    harness: {} as SlashCommandHost['harness'],
    cancelInFlight: undefined,
    deferUserMessages: false,
    setAppState: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
    requireSession: vi.fn(() => session),
    switchToSession: vi.fn(),
    reloadCurrentSessionView: vi.fn(),
    beginSessionRequest: vi.fn(),
    failSessionRequest: vi.fn(),
    sendQueuedMessage: vi.fn(),
    showLoginProgressSpinner: vi.fn(),
    showLoginAuthorizationPrompt: vi.fn(),
    showProgressSpinner: vi.fn(),
    applyTheme: vi.fn(),
    refreshTerminalThemeTracking: vi.fn(),
    stop: vi.fn(),
    setExitOpenUrl: vi.fn(),
    showHelpPanel: vi.fn(),
    createNewSession: vi.fn(),
    showSessionPicker: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendInlineSkillUserInput: vi.fn(),
    sendSkillActivation: vi.fn(),
    activatePluginCommand: vi.fn(),
    streamingUI: {} as SlashCommandHost['streamingUI'],
    btwPanelController: {} as SlashCommandHost['btwPanelController'],
    tasksBrowserController: {} as SlashCommandHost['tasksBrowserController'],
    authFlow: {} as SlashCommandHost['authFlow'],
  } as unknown as SlashCommandHost & {
    session: typeof session;
    state: typeof state;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    beginSessionRequest: ReturnType<typeof vi.fn>;
    failSessionRequest: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    sendInlineSkillUserInput: ReturnType<typeof vi.fn>;
  };

  return { host, session };
}

describe('extractInlineSkillActivations', () => {
  it('activates a single inline skill token', () => {
    const result = extractInlineSkillActivations('use /skill:review on this', makeSkillCommandMap());
    expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'review' }]);
  });

  it('activates multiple distinct skill tokens in first-occurrence order', () => {
    const result = extractInlineSkillActivations(
      'use /skill:review and /skill:security on this',
      makeSkillCommandMap(),
    );
    expect(result).toEqual<InlineSkillActivation[]>([
      { skillName: 'review' },
      { skillName: 'security' },
    ]);
  });

  it('deduplicates repeated skill tokens, keeping first occurrence position', () => {
    const result = extractInlineSkillActivations(
      'use /skill:review then /skill:security then /skill:review again',
      makeSkillCommandMap(),
    );
    expect(result).toEqual<InlineSkillActivation[]>([
      { skillName: 'review' },
      { skillName: 'security' },
    ]);
  });

  it('resolves builtin-sourced skill tokens', () => {
    const result = extractInlineSkillActivations('configure /mcp-config please', makeSkillCommandMap());
    expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'mcp-config' }]);
  });

  it('ignores unknown slash tokens', () => {
    const result = extractInlineSkillActivations('use /unknown on this', makeSkillCommandMap());
    expect(result).toEqual([]);
  });

  it('ignores slash tokens preceded by non-whitespace', () => {
    const result = extractInlineSkillActivations(
      'src/foo/skill:review and 1/2 and https://example.test/a/b',
      makeSkillCommandMap(),
    );
    expect(result).toEqual([]);
  });

  it('ignores tokens with internal slashes', () => {
    const result = extractInlineSkillActivations('use /skill:review/extra on this', makeSkillCommandMap());
    expect(result).toEqual([]);
  });

  it('treats a newline as a token boundary', () => {
    const result = extractInlineSkillActivations('use /skill:review\nnext line', makeSkillCommandMap());
    expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'review' }]);
  });

  it('treats a newline before slash as an inline trigger', () => {
    const result = extractInlineSkillActivations('hello\n/skill:review', makeSkillCommandMap());
    expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'review' }]);
  });

  it('detects inline tokens on multiple lines', () => {
    const result = extractInlineSkillActivations(
      'line1 /skill:review\nline2 /skill:security',
      makeSkillCommandMap(),
    );
    expect(result).toEqual<InlineSkillActivation[]>([
      { skillName: 'review' },
      { skillName: 'security' },
    ]);
  });

  it('does not treat a leading slash command as an inline skill token', () => {
    const result = extractInlineSkillActivations('/skill:review extra text', makeSkillCommandMap());
    expect(result).toEqual([]);
  });

  it('skips the leading slash command area and still detects later inline tokens', () => {
    const result = extractInlineSkillActivations(
      '/goal next /skill:review and /skill:security',
      makeSkillCommandMap(),
    );
    expect(result).toEqual<InlineSkillActivation[]>([
      { skillName: 'review' },
      { skillName: 'security' },
    ]);
  });

  it('matches tokens after tabs as well as spaces', () => {
    const result = extractInlineSkillActivations('use\t/skill:review', makeSkillCommandMap());
    expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'review' }]);
  });

  describe('includeLeading', () => {
    it('includes a leading skill token when requested', () => {
      const result = extractInlineSkillActivations('/skill:review extra text', makeSkillCommandMap(), {
        includeLeading: true,
      });
      expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'review' }]);
    });

    it('includes leading and inline skill tokens together', () => {
      const result = extractInlineSkillActivations(
        '/skill:review check this /skill:security',
        makeSkillCommandMap(),
        { includeLeading: true },
      );
      expect(result).toEqual<InlineSkillActivation[]>([
        { skillName: 'review' },
        { skillName: 'security' },
      ]);
    });

    it('still ignores a non-skill leading slash command when requested', () => {
      const result = extractInlineSkillActivations('/goal next /skill:review', makeSkillCommandMap(), {
        includeLeading: true,
      });
      expect(result).toEqual<InlineSkillActivation[]>([{ skillName: 'review' }]);
    });
  });
});

describe('dispatchInput inline skill activation', () => {
  it('sends normal input unchanged when no inline skill tokens are present', async () => {
    const { host } = makeHost();

    dispatchInput(host, 'hello world');

    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello world');
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
  });

  it('hands inline skill activation to the host instead of sending directly', async () => {
    const { host, session } = makeHost();

    dispatchInput(host, 'use /skill:review on this');

    expect(host.sendInlineSkillUserInput).toHaveBeenCalledWith(session, 'use /skill:review on this', [
      { skillName: 'review' },
    ]);
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.beginSessionRequest).not.toHaveBeenCalled();
  });

  it('passes multiple skills in first-occurrence order and deduplicated', async () => {
    const { host, session } = makeHost();

    dispatchInput(host, 'use /skill:review and /skill:security then /skill:review again');

    expect(host.sendInlineSkillUserInput).toHaveBeenCalledWith(
      session,
      'use /skill:review and /skill:security then /skill:review again',
      [{ skillName: 'review' }, { skillName: 'security' }],
    );
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('blocks inline skill activation while streaming', async () => {
    const { host } = makeHost({ streamingPhase: 'composing' });

    dispatchInput(host, 'use /skill:review on this');

    expect(host.showError).toHaveBeenCalledOnce();
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
  });

  it('blocks inline skill activation while compacting', async () => {
    const { host } = makeHost({ isCompacting: true });

    dispatchInput(host, 'use /skill:review on this');

    expect(host.showError).toHaveBeenCalledOnce();
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
  });

  it('hands inline skill activation to the host when there is no active session (v2 lazy-creates it)', async () => {
    const { host } = makeHost({ hasSession: false });

    dispatchInput(host, 'use /skill:review on this');

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.sendInlineSkillUserInput).toHaveBeenCalledWith(undefined, 'use /skill:review on this', [
      { skillName: 'review' },
    ]);
  });

  it('shows the no-model error when the model is unset', async () => {
    const { host } = makeHost({ model: '' });

    dispatchInput(host, 'use /skill:review on this');

    expect(host.showError).toHaveBeenCalledWith(LLM_NOT_SET_MESSAGE);
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
  });

  it('routes a leading skill alone through sendSkillActivation', async () => {
    const { host } = makeHost();

    dispatchInput(host, '/skill:review some text');

    expect(host.sendSkillActivation).toHaveBeenCalled();
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
  });

  it('routes leading skill plus additional inline skills through inline activation', () => {
    const { host, session } = makeHost();

    dispatchInput(host, '/skill:review also /skill:security');

    expect(host.sendInlineSkillUserInput).toHaveBeenCalledWith(session, '/skill:review also /skill:security', [
      { skillName: 'review', args: 'also /skill:security' },
      { skillName: 'security' },
    ]);
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('preserves leading skill args when combined with inline skills', () => {
    const { host, session } = makeHost();

    dispatchInput(host, '/skill:review src/app.ts then /skill:security');

    expect(host.sendInlineSkillUserInput).toHaveBeenCalledWith(
      session,
      '/skill:review src/app.ts then /skill:security',
      [
        { skillName: 'review', args: 'src/app.ts then /skill:security' },
        { skillName: 'security' },
      ],
    );
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('falls through to normal input for unknown slash tokens, paths, and fractions', async () => {
    const { host } = makeHost();
    const text = 'check src/foo/skill:review and 1/2 then /not-a-skill';

    dispatchInput(host, text);

    expect(host.sendNormalUserInput).toHaveBeenCalledWith(text);
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
  });
});
