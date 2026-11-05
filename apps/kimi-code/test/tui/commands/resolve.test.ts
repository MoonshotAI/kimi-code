import {
  resolveSlashCommandInput,
  setExperimentalFeatures,
  slashBusyMessage,
  slashCommandBusyReason,
} from '#/tui/commands/index';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveUserInput, skillVariantPathsForInput } from '#/tui/commands/resolve';

function resolve(
  input: string,
  overrides: Partial<Parameters<typeof resolveSlashCommandInput>[0]> = {},
) {
  return resolveSlashCommandInput({
    input,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    isStreaming: false,
    isCompacting: false,
    ...overrides,
  });
}

describe('resolveUserInput', () => {
  const options = {
    isStreaming: false,
    isCompacting: false,
    skillCommandMap: new Map([
      ['skill:review', 'review'],
      ['quick', 'review'],
      ['skill:security', 'security'],
      ['skill:team/review', 'team/review'],
    ]),
    pluginCommandMap: new Map([['example:deploy', 'example']]),
  };

  it.each([
    { input: '/skill:review src/app.ts', skills: [{ skillName: 'review', args: 'src/app.ts' }] },
    { input: '/review', skills: [{ skillName: 'review', args: '' }] },
    { input: '/skill:team/review src/app.ts', skills: [{ skillName: 'team/review', args: 'src/app.ts' }] },
    { input: '/team/review src/app.ts', skills: [] },
    { input: 'check /skill:team/review src/app.ts', skills: [] },
    { input: '/quick\ncheck src/app.ts', skills: [] },
    { input: '/skill:review\nexplain this', skills: [] },
    { input: '/skill:review\n\nexplain this', skills: [] },
    { input: '/skill:review\texplain this', skills: [] },
    { input: '/quick \ncheck src/app.ts', skills: [{ skillName: 'review', args: 'check src/app.ts' }] },
    { input: '/quick\n', skills: [{ skillName: 'review', args: '' }] },
    { input: 'please /skill:review src/app.ts', skills: [{ skillName: 'review' }] },
    { input: '/skill:review /review src/app.ts', skills: [{ skillName: 'review' }] },
    { input: '/quick /skill:review src/app.ts', skills: [{ skillName: 'review' }] },
    {
      input: '/skill:security\n/quick /skill:security',
      skills: [{ skillName: 'security' }, { skillName: 'review' }],
    },
    { input: '/unknown /skill:review src/app.ts', skills: [{ skillName: 'review' }] },
    { input: '/help /skill:review', skills: [] },
    { input: '/example:deploy /skill:review', skills: [] },
    { input: 'check src/app.ts https://example.com/review and 1/2', skills: [] },
  ])('resolves $input without changing argument or command precedence', ({ input, skills }) => {
    expect(resolveUserInput({ ...options, input }).activations.map(({ start: _start, occurrences: _occurrences, ...activation }) => activation)).toEqual(skills);
  });

  it('attaches selected variant paths to every matching activation', () => {
    const paths: Record<string, string> = {
      'skill:review': '/work/B/review/SKILL.md',
      'skill:security': '/work/B/security/SKILL.md',
    };
    const skillVariantPathForCommand = (commandName: string, start: number) =>
      start === 0 ? paths[commandName] : undefined;
    expect(
      resolveUserInput({ ...options, input: '/skill:review src/app.ts', skillVariantPathForCommand }).activations,
    ).toEqual([{ skillName: 'review', path: paths['skill:review'], start: 0, args: 'src/app.ts' }]);
    expect(
      resolveUserInput({
        ...options,
        input: '/skill:security /skill:review',
        skillVariantPathForCommand,
      }).activations,
    ).toEqual([
      { skillName: 'security', path: paths['skill:security'], start: 0 },
      { skillName: 'review', start: 16 },
    ]);
  });

  it('keeps different variants of the same skill at their own token positions', () => {
    const text = '/skill:review /skill:review';
    const activations = resolveUserInput({
      ...options,
      input: text,
      skillVariantPathForCommand: (_commandName, start) => `/work/${start === 0 ? 'A' : 'B'}/review/SKILL.md`,
    }).activations;

    expect(activations).toEqual([
      { skillName: 'review', path: '/work/A/review/SKILL.md', start: 0 },
      { skillName: 'review', path: '/work/B/review/SKILL.md', start: 14 },
    ]);
    expect(skillVariantPathsForInput(text, activations, options.skillCommandMap)).toEqual([
      { commandName: 'skill:review', path: '/work/A/review/SKILL.md', start: 0 },
      { commandName: 'skill:review', path: '/work/B/review/SKILL.md', start: 14 },
    ]);
    const deduplicated = resolveUserInput({
      ...options,
      input: text,
      skillVariantPathForCommand: () => '/work/A/review/SKILL.md',
    }).activations;
    expect(deduplicated).toEqual([
      {
        skillName: 'review',
        path: '/work/A/review/SKILL.md',
        start: 0,
        occurrences: [
          { commandName: 'skill:review', start: 0 },
          { commandName: 'skill:review', start: 14 },
        ],
      },
    ]);
    expect(skillVariantPathsForInput(text, deduplicated, options.skillCommandMap)).toEqual([
      { commandName: 'skill:review', path: '/work/A/review/SKILL.md', start: 0 },
      { commandName: 'skill:review', path: '/work/A/review/SKILL.md', start: 14 },
    ]);
  });

  it('restores command aliases for every deduplicated occurrence', () => {
    const text = '/quick /skill:review';
    const path = '/work/B/review/SKILL.md';
    const activations = resolveUserInput({
      ...options,
      input: text,
      skillVariantPathForCommand: () => path,
    }).activations;

    expect(skillVariantPathsForInput(text, activations, options.skillCommandMap)).toEqual([
      { commandName: 'skill:quick', path, start: 0 },
      { commandName: 'skill:review', path, start: 7 },
    ]);
  });

  it('passes selected paths through /btw without treating the builtin as a skill', () => {
    const resolved = resolveUserInput({
      ...options,
      input: '/btw compare /skill:review',
      skillVariantPathForCommand: () => '/work/B/review/SKILL.md',
    });

    expect(resolved.intent).toMatchObject({ kind: 'builtin', name: 'btw' });
    expect(resolved.activations).toEqual([
      { skillName: 'review', path: '/work/B/review/SKILL.md', start: 13 },
    ]);
  });

  it('preserves token offsets when the input starts with whitespace', () => {
    const resolved = resolveUserInput({
      ...options,
      input: '  /skill:review',
      skillVariantPathForCommand: (_commandName, start) =>
        start === 2 ? '/work/B/review/SKILL.md' : undefined,
    });

    expect(resolved.activations).toEqual([
      { skillName: 'review', path: '/work/B/review/SKILL.md', start: 2 },
    ]);
  });

  it('excludes the leading builtin when a skill is named btw', () => {
    const resolved = resolveUserInput({
      ...options,
      skillCommandMap: new Map([...options.skillCommandMap, ['skill:btw', 'btw']]),
      input: '/btw /skill:review',
      skillVariantPathForCommand: (_commandName, start) =>
        start === 5 ? '/work/B/review/SKILL.md' : undefined,
    });

    expect(resolved.intent).toMatchObject({ kind: 'builtin', name: 'btw' });
    expect(resolved.activations).toEqual([
      { skillName: 'review', path: '/work/B/review/SKILL.md', start: 5 },
    ]);
  });

  it('maps returned activations back to their command names', () => {
    const path = '/work/B/review/SKILL.md';
    expect(skillVariantPathsForInput('/review', [{ skillName: 'review', path }], options.skillCommandMap)).toEqual([
      { commandName: 'skill:review', path, start: 0 },
    ]);
    expect(skillVariantPathsForInput('/skill:security /skill:review', [
      { skillName: 'security', path: '/work/B/security/SKILL.md' },
      { skillName: 'review', path },
    ], options.skillCommandMap)).toEqual([
      { commandName: 'skill:security', path: '/work/B/security/SKILL.md', start: 0 },
      { commandName: 'skill:review', path, start: 16 },
    ]);
  });
});

describe('resolveSlashCommandInput', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('returns not-command for normal text', () => {
    expect(resolve('hello')).toEqual({ kind: 'not-command' });
  });

  it('resolves built-in commands by name and alias', () => {
    expect(resolve('/help')).toMatchObject({ kind: 'builtin', name: 'help', args: '' });
    expect(resolve('/q')).toMatchObject({ kind: 'builtin', name: 'exit', args: '' });
    expect(resolve('/clear')).toMatchObject({ kind: 'builtin', name: 'new', args: '' });
    expect(resolve('/fork')).toMatchObject({ kind: 'builtin', name: 'fork', args: '' });
    expect(resolve('/title New title')).toMatchObject({
      kind: 'builtin',
      name: 'title',
      args: 'New title',
    });
    expect(resolve('/add-dir list')).toMatchObject({
      kind: 'builtin',
      name: 'add-dir',
      args: 'list',
    });
    expect(resolve('/init')).toMatchObject({ kind: 'builtin', name: 'init', args: '' });
    expect(resolve('/btw')).toMatchObject({
      kind: 'builtin',
      name: 'btw',
      args: '',
    });
    expect(resolve('/btw what are you doing?')).toMatchObject({
      kind: 'builtin',
      name: 'btw',
      args: 'what are you doing?',
    });
    expect(resolve('/experiments')).toMatchObject({
      kind: 'builtin',
      name: 'experiments',
      args: '',
    });
  });

  it('resolves /remote-control and /rc as built-ins', () => {
    expect(resolve('/rc')).toMatchObject({ kind: 'builtin', name: 'remote-control' });
    expect(resolve('/remote-control')).toMatchObject({ kind: 'builtin', name: 'remote-control' });
  });

  it('blocks idle-only built-ins while streaming', () => {
    expect(resolve('/new', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'new',
      reason: 'streaming',
    });
    expect(resolve('/init', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'init',
      reason: 'streaming',
    });
    expect(resolve('/sessions', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'sessions',
      reason: 'streaming',
    });
    expect(resolve('/resume', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'resume',
      reason: 'streaming',
    });
    expect(resolve('/undo', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'undo',
      reason: 'streaming',
    });
    expect(resolve('/reload', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'reload',
      reason: 'streaming',
    });
    expect(resolve('/add-dir ../shared', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'add-dir',
      reason: 'streaming',
    });
    expect(resolve('/experiments', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'experiments',
      reason: 'streaming',
    });
    expect(resolve('/swarm on', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'swarm',
      reason: 'streaming',
    });
    expect(resolve('/swarm off', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'swarm',
      reason: 'streaming',
    });
  });

  it('blocks model and session pickers while compacting', () => {
    expect(resolve('/sessions', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'sessions',
      reason: 'compacting',
    });
    expect(resolve('/resume', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'resume',
      reason: 'compacting',
    });
    expect(resolve('/reload', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'reload',
      reason: 'compacting',
    });
    expect(resolve('/add-dir ../shared', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'add-dir',
      reason: 'compacting',
    });
    expect(resolve('/experiments', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'experiments',
      reason: 'compacting',
    });
    expect(resolve('/swarm on', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'swarm',
      reason: 'compacting',
    });
    expect(resolve('/swarm off', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'swarm',
      reason: 'compacting',
    });
  });

  it('allows always-available built-ins while streaming', () => {
    expect(resolve('/plan on', { isStreaming: true })).toMatchObject({
      kind: 'builtin',
      name: 'plan',
      args: 'on',
    });
    expect(resolve('/mcp', { isStreaming: true })).toMatchObject({
      kind: 'builtin',
      name: 'mcp',
      args: '',
    });
    expect(resolve('/mcp', { isCompacting: true })).toMatchObject({
      kind: 'builtin',
      name: 'mcp',
      args: '',
    });
    expect(resolve('/reload-tui', { isStreaming: true })).toMatchObject({
      kind: 'builtin',
      name: 'reload-tui',
      args: '',
    });
    expect(resolve('/reload-tui', { isCompacting: true })).toMatchObject({
      kind: 'builtin',
      name: 'reload-tui',
      args: '',
    });
    expect(resolve('/btw side question', { isStreaming: true })).toMatchObject({
      kind: 'builtin',
      name: 'btw',
      args: 'side question',
    });
  });

  it('blocks plan clear while compacting because it is idle-only', () => {
    expect(resolve('/plan clear', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'plan',
      reason: 'compacting',
    });
  });

  it('resolves skill commands and keeps them resolvable while busy (queued downstream)', () => {
    const skillCommandMap = new Map([['skill:review', 'review']]);

    expect(resolve('/skill:review src/app.ts', { skillCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'skill:review',
      skillName: 'review',
      args: 'src/app.ts',
    });
    expect(resolve('/skill:review src/app.ts', { skillCommandMap, isStreaming: true })).toEqual({
      kind: 'skill',
      commandName: 'skill:review',
      skillName: 'review',
      args: 'src/app.ts',
    });
  });

  it('resolves unprefixed built-in skill commands and keeps them resolvable while busy', () => {
    const skillCommandMap = new Map([['mcp-config', 'mcp-config']]);

    expect(resolve('/mcp-config', { skillCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'mcp-config',
      skillName: 'mcp-config',
      args: '',
    });
    expect(resolve('/mcp-config', { skillCommandMap, isCompacting: true })).toEqual({
      kind: 'skill',
      commandName: 'mcp-config',
      skillName: 'mcp-config',
      args: '',
    });
  });

  it('resolves unprefixed sub-skill commands with dotted names', () => {
    const skillCommandMap = new Map([['outer.inner', 'outer.inner']]);

    expect(resolve('/outer.inner src/app.ts', { skillCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'outer.inner',
      skillName: 'outer.inner',
      args: 'src/app.ts',
    });
  });

  it('returns message for unknown slash input', () => {
    expect(resolve('/does-not-exist arg')).toEqual({
      kind: 'message',
      input: '/does-not-exist arg',
    });
  });

  it('resolves /swarm without an experimental flag', () => {
    expect(resolve('/swarm Ship feature X')).toMatchObject({
      kind: 'builtin',
      name: 'swarm',
      args: 'Ship feature X',
    });
  });

  it('resolves /tower to the builtin command when the tower flag is enabled', () => {
    setExperimentalFeatures([{ id: 'tower', enabled: true }]);

    expect(resolve('/tower Ship feature X')).toMatchObject({
      kind: 'builtin',
      name: 'tower',
      args: 'Ship feature X',
    });
  });

  it('does not resolve /tower as a builtin when the tower flag is disabled', () => {
    expect(resolve('/tower Ship feature X')).toEqual({
      kind: 'message',
      input: '/tower Ship feature X',
    });
  });

});

describe('goal command resolution', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('resolves /goal to the builtin command without an experimental flag', () => {
    expect(resolve('/goal Ship feature X')).toMatchObject({
      kind: 'builtin',
      name: 'goal',
      args: 'Ship feature X',
    });
  });

  it('blocks goal creation while streaming', () => {
    expect(resolve('/goal Ship feature X', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'goal',
      reason: 'streaming',
    });
  });

  it('does not block status/pause/cancel/bare goal while streaming', () => {
    for (const sub of ['status', 'pause', 'cancel']) {
      expect(resolve(`/goal ${sub}`, { isStreaming: true })).toMatchObject({
        kind: 'builtin',
        name: 'goal',
      });
    }
    expect(resolve('/goal', { isStreaming: true })).toMatchObject({
      kind: 'builtin',
      name: 'goal',
    });
  });
});

describe('slash command busy helpers', () => {
  it('resolves skill commands by explicit prefixed name and by shorthand', () => {
    const skillCommandMap = new Map([
      ['skill:review', 'review'],
      ['mcp-config', 'mcp-config'],
    ]);

    expect(resolve('/skill:review', { skillCommandMap })).toMatchObject({
      kind: 'skill',
      skillName: 'review',
    });
    expect(resolve('/review', { skillCommandMap })).toMatchObject({
      kind: 'skill',
      skillName: 'review',
    });
    expect(resolve('/mcp-config', { skillCommandMap })).toMatchObject({
      kind: 'skill',
      skillName: 'mcp-config',
    });
  });

  it('resolves a qualified plugin skill by shorthand when no plugin command takes the name', () => {
    const skillCommandMap = new Map([['skill:my-plugin:deploy', 'my-plugin:deploy']]);
    expect(resolve('/my-plugin:deploy', { skillCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'my-plugin:deploy',
      skillName: 'my-plugin:deploy',
      args: '',
    });
  });

  it('resolves a namespaced input to the plugin command when a same-named plugin skill exists', () => {
    const skillCommandMap = new Map([['skill:my-plugin:deploy', 'my-plugin:deploy']]);
    const pluginCommandMap = new Map([['my-plugin:deploy', 'Deploy $ARGUMENTS']]);
    expect(resolve('/my-plugin:deploy prod', { skillCommandMap, pluginCommandMap })).toEqual({
      kind: 'plugin-command',
      commandName: 'deploy',
      pluginId: 'my-plugin',
      args: 'prod',
    });
  });

  it('keeps the colliding plugin skill reachable through its explicit skill command', () => {
    const skillCommandMap = new Map([['skill:my-plugin:deploy', 'my-plugin:deploy']]);
    const pluginCommandMap = new Map([['my-plugin:deploy', 'Deploy']]);
    expect(resolve('/skill:my-plugin:deploy', { skillCommandMap, pluginCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'skill:my-plugin:deploy',
      skillName: 'my-plugin:deploy',
      args: '',
    });
  });

  it('blocks a plugin command while streaming even when a same-named plugin skill exists', () => {
    const skillCommandMap = new Map([['skill:my-plugin:deploy', 'my-plugin:deploy']]);
    const pluginCommandMap = new Map([['my-plugin:deploy', 'Deploy']]);
    expect(
      resolve('/my-plugin:deploy', { skillCommandMap, pluginCommandMap, isStreaming: true }),
    ).toEqual({
      kind: 'blocked',
      commandName: 'my-plugin:deploy',
      reason: 'streaming',
    });
  });

  it('formats busy messages', () => {
    expect(slashCommandBusyReason({ isStreaming: true, isCompacting: false })).toBe('streaming');
    expect(slashCommandBusyReason({ isStreaming: false, isCompacting: true })).toBe('compacting');
    expect(slashBusyMessage('new', 'streaming')).toContain('Cannot /new while streaming');
    expect(slashBusyMessage('new', 'compacting')).toContain('Cannot /new while compacting');
  });

  it('resolves a namespaced plugin command to a plugin-command intent', () => {
    const pluginCommandMap = new Map([['my-plugin:deploy', 'Deploy $ARGUMENTS']]);
    expect(resolve('/my-plugin:deploy prod', { pluginCommandMap })).toEqual({
      kind: 'plugin-command',
      commandName: 'deploy',
      pluginId: 'my-plugin',
      args: 'prod',
    });
  });

  it('resolves a nested plugin command whose name contains a slash', () => {
    const pluginCommandMap = new Map([['my-plugin:frontend/component', 'body']]);
    expect(resolve('/my-plugin:frontend/component spin', { pluginCommandMap })).toEqual({
      kind: 'plugin-command',
      commandName: 'frontend/component',
      pluginId: 'my-plugin',
      args: 'spin',
    });
  });

  it('blocks a plugin command while streaming', () => {
    const pluginCommandMap = new Map([['my-plugin:deploy', 'Deploy']]);
    expect(resolve('/my-plugin:deploy', { pluginCommandMap, isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'my-plugin:deploy',
      reason: 'streaming',
    });
  });
});
