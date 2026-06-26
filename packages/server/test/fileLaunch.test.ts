import { describe, expect, it } from 'vitest';
import {
  openFileCommandFor,
  openInAppCommandFor,
  revealFileCommandFor,
} from '../src/lib/fileLaunch';

describe('file launch commands', () => {
  it('uses configured editors and preserves line targets for VS Code style editors', () => {
    expect(openFileCommandFor('/repo/src/App.vue', 12, { KIMI_CODE_EDITOR: 'code -g' }, 'darwin')).toEqual({
      command: "code -g '/repo/src/App.vue:12'",
      args: [],
      shell: true,
    });
  });

  it('falls back to platform openers without an editor', () => {
    expect(openFileCommandFor('/repo/src/App.vue', undefined, {}, 'darwin')).toEqual({
      command: 'open',
      args: ['/repo/src/App.vue'],
    });
    expect(openFileCommandFor('/repo/src/App.vue', undefined, {}, 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo/src/App.vue'],
    });
  });

  it('reveals files with platform-specific commands', () => {
    expect(revealFileCommandFor('/repo/src/App.vue', 'darwin')).toEqual({
      command: 'open',
      args: ['-R', '/repo/src/App.vue'],
    });
    expect(revealFileCommandFor('/repo/src/App.vue', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo/src'],
    });
  });
});

describe('open-in-app launch commands', () => {
  it('opens vscode with line targets', () => {
    expect(openInAppCommandFor('vscode', '/repo/src/App.vue', { line: 12 }, 'darwin')).toEqual({
      command: "code -g '/repo/src/App.vue:12'",
      args: [],
      shell: true,
    });
    expect(openInAppCommandFor('vscode', '/repo/src/App.vue', { line: 12 }, 'linux')).toEqual({
      command: "code -g '/repo/src/App.vue:12'",
      args: [],
      shell: true,
    });
    expect(openInAppCommandFor('vscode', '/repo/src/App.vue', { line: 12 }, 'win32')).toEqual({
      command: 'code -g "/repo/src/App.vue:12"',
      args: [],
      shell: true,
    });
  });

  it('opens vscode without line targets', () => {
    expect(openInAppCommandFor('vscode', '/repo/src/App.vue', {}, 'darwin')).toEqual({
      command: "code '/repo/src/App.vue'",
      args: [],
      shell: true,
    });
  });

  it('opens cursor with line targets', () => {
    expect(openInAppCommandFor('cursor', '/repo/src/App.vue', { line: 12 }, 'darwin')).toEqual({
      command: "cursor -g '/repo/src/App.vue:12'",
      args: [],
      shell: true,
    });
  });

  it('opens finder with reveal-vs-folder semantics', () => {
    expect(openInAppCommandFor('finder', '/repo/src/App.vue', { isDirectory: false }, 'darwin')).toEqual({
      command: 'open',
      args: ['-R', '/repo/src/App.vue'],
    });
    expect(openInAppCommandFor('finder', '/repo', { isDirectory: true }, 'darwin')).toEqual({
      command: 'open',
      args: ['/repo'],
    });
    expect(openInAppCommandFor('finder', '/repo/src/App.vue', { isDirectory: false }, 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,/repo/src/App.vue'],
    });
    expect(openInAppCommandFor('finder', '/repo', { isDirectory: true }, 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/repo'],
    });
    expect(openInAppCommandFor('finder', '/repo/src/App.vue', { isDirectory: false }, 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo/src'],
    });
    expect(openInAppCommandFor('finder', '/repo', { isDirectory: true }, 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo'],
    });
  });

  it('opens macOS-only apps with open -a', () => {
    expect(openInAppCommandFor('iterm', '/repo', {}, 'darwin')).toEqual({
      command: 'open',
      args: ['-a', 'iTerm', '/repo'],
    });
    expect(openInAppCommandFor('terminal', '/repo', {}, 'darwin')).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', '/repo'],
    });
  });

  it('falls back to the platform default for macOS-only apps on other platforms', () => {
    expect(openInAppCommandFor('iterm', '/repo/src/App.vue', {}, 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', '/repo/src/App.vue'],
    });
    expect(openInAppCommandFor('iterm', '/repo/src/App.vue', {}, 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo/src/App.vue'],
    });
  });
});
