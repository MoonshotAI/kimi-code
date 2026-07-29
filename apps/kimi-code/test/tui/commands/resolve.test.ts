import {
  resolveSkillCommand,
  resolveSlashCommandInput,
  setExperimentalFeatures,
  slashBusyMessage,
  slashCommandBusyReason,
} from '#/tui/commands/index';
import { afterEach, describe, expect, it } from 'vitest';

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

  it('resolves skill commands and blocks them while busy', () => {
    const skillCommandMap = new Map([['skill:review', 'review']]);

    expect(resolve('/skill:review src/app.ts', { skillCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'skill:review',
      skillName: 'review',
      args: 'src/app.ts',
    });
    expect(resolve('/skill:review src/app.ts', { skillCommandMap, isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'skill:review',
      reason: 'streaming',
    });
  });

  it('resolves unprefixed built-in skill commands and blocks them while busy', () => {
    const skillCommandMap = new Map([['mcp-config', 'mcp-config']]);

    expect(resolve('/mcp-config', { skillCommandMap })).toEqual({
      kind: 'skill',
      commandName: 'mcp-config',
      skillName: 'mcp-config',
      args: '',
    });
    expect(resolve('/mcp-config', { skillCommandMap, isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'mcp-config',
      reason: 'compacting',
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
  it('resolves skill command aliases with and without skill prefix', () => {
    const map = new Map([
      ['skill:review', 'review'],
      ['mcp-config', 'mcp-config'],
    ]);

    expect(resolveSkillCommand(map, 'skill:review')).toBe('review');
    expect(resolveSkillCommand(map, 'review')).toBe('review');
    expect(resolveSkillCommand(map, 'mcp-config')).toBe('mcp-config');
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
