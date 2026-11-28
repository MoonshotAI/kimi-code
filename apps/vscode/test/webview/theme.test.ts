import { afterEach, describe, expect, it } from 'vitest';
import { isDarkVscodeTheme } from '@/lib/theme';

describe('VS Code webview theme detection', () => {
  afterEach(() => {
    document.body.className = '';
    delete document.body.dataset.vscodeThemeKind;
  });

  it.each([
    { kind: 'vscode-light', classes: ['vscode-light'], expected: false },
    { kind: 'vscode-dark', classes: ['vscode-dark'], expected: true },
    { kind: 'vscode-high-contrast', classes: ['vscode-high-contrast'], expected: true },
    { kind: 'vscode-high-contrast-light', classes: ['vscode-high-contrast-light', 'vscode-high-contrast'], expected: false },
  ])('treats $kind as dark=$expected', ({ kind, classes, expected }) => {
    document.body.classList.add(...classes);
    document.body.dataset.vscodeThemeKind = kind;

    expect(isDarkVscodeTheme(document.body)).toBe(expected);
  });

  it.each([
    { classes: ['vscode-dark'], expected: true },
    { classes: ['vscode-light'], expected: false },
    { classes: ['vscode-high-contrast'], expected: true },
    { classes: ['vscode-high-contrast', 'vscode-high-contrast-light'], expected: false },
  ])('falls back to body classes [$classes] when data-vscode-theme-kind is missing', ({ classes, expected }) => {
    document.body.classList.add(...classes);

    expect(isDarkVscodeTheme(document.body)).toBe(expected);
  });
});
