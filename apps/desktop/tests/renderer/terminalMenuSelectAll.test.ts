// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { registerTerminalInstance, releaseTerminalInstance, selectAllTerminalIn } from '../../src/renderer/composables/terminalInstances';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

const owners: Array<{ id: string; owner: symbol }> = [];

afterEach(() => {
  for (const { id, owner } of owners.splice(0)) releaseTerminalInstance(id, owner);
});

describe('selectAllTerminalIn', () => {
  it('selects the buffer of the terminal instance hosting the focused element', () => {
    const host = document.createElement('div');
    host.className = 'terminal-host';
    const termEl = document.createElement('div');
    termEl.className = 'xterm';
    const textarea = document.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    termEl.append(textarea);
    host.append(termEl);
    document.body.append(host);
    let called = 0;
    const selectAll = () => { called += 1; };
    const owner = Symbol('test');
    owners.push({ id: 'pty-1', owner });
    registerTerminalInstance('pty-1', { term: { element: termEl, selectAll } as unknown as Terminal, fit: {} as FitAddon }, owner);

    expect(selectAllTerminalIn(textarea)).toBe(true);
    expect(called).toBe(1);
    expect(selectAllTerminalIn(document.body)).toBe(false);
    expect(called).toBe(1);
    host.remove();
  });
});
