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
    isStreaming: false,
    isCompacting: false,
    ...overrides,
  });
}

describe('resolveSlashCommandInput', () => {
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
    expect(resolve('/experiments', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'experiments',
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
    expect(resolve('/experiments', { isCompacting: true })).toEqual({
      kind: 'blocked',
      commandName: 'experiments',
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

  it('returns message for unknown slash input', () => {
    expect(resolve('/does-not-exist arg')).toEqual({
      kind: 'message',
      input: '/does-not-exist arg',
    });
  });

});

describe('goal command resolution', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('resolves /goal to the builtin command when goal_command is enabled', () => {
    setExperimentalFeatures([{ id: 'goal_command', enabled: true }]);
    expect(resolve('/goal Ship feature X')).toMatchObject({
      kind: 'builtin',
      name: 'goal',
      args: 'Ship feature X',
    });
  });

  it('treats /goal as a normal message when goal_command is disabled', () => {
    setExperimentalFeatures([]);
    expect(resolve('/goal Ship feature X')).toEqual({
      kind: 'message',
      input: '/goal Ship feature X',
    });
  });

  it('blocks goal creation while streaming', () => {
    setExperimentalFeatures([{ id: 'goal_command', enabled: true }]);
    expect(resolve('/goal Ship feature X', { isStreaming: true })).toEqual({
      kind: 'blocked',
      commandName: 'goal',
      reason: 'streaming',
    });
  });

  it('does not block status/pause/cancel/bare goal while streaming', () => {
    setExperimentalFeatures([{ id: 'goal_command', enabled: true }]);
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
});
