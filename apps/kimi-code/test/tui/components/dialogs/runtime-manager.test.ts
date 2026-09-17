import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  RuntimeManagerComponent,
  type RuntimeManagerOptions,
  type RuntimeManagerRuntime,
} from '#/tui/components/dialogs/runtime-manager';

const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const UP = '[A';
const DOWN = '[B';

const SGR = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'g');

// Truecolor SGR fragments for the darkColors tokens asserted below.
const ERROR = '38;2;232;84;84'; // colors.error #E85454
const SUCCESS = '38;2;78;200;126'; // colors.success #4EC87E

function rendered(component: RuntimeManagerComponent, width = 120): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

const LOCAL: RuntimeManagerRuntime = { runtimeId: 'local', type: 'local', status: 'ready' };
const DEV_BOX: RuntimeManagerRuntime = {
  runtimeId: 'dev-box',
  type: 'ssh',
  status: 'ready',
  defaultCwd: '/home/me/projects',
};
const SANDBOX: RuntimeManagerRuntime = { runtimeId: 'sandbox', type: 'command', status: 'disconnected' };

function makeComponent(overrides: Partial<RuntimeManagerOptions> = {}): RuntimeManagerComponent {
  return new RuntimeManagerComponent({
    runtimes: [LOCAL, DEV_BOX, SANDBOX],
    currentRuntimeId: 'local',
    onSwitch: vi.fn(),
    onReconnect: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });
}

describe('RuntimeManagerComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('lists local first, then declared runtimes, then the add row', () => {
    const component = makeComponent();
    const plain = rendered(component);
    const localIdx = plain.indexOf('local');
    const devBoxIdx = plain.indexOf('dev-box');
    const sandboxIdx = plain.indexOf('sandbox');
    const addIdx = plain.indexOf('Add Runtime');
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(devBoxIdx).toBeGreaterThan(localIdx);
    expect(sandboxIdx).toBeGreaterThan(devBoxIdx);
    expect(addIdx).toBeGreaterThan(sandboxIdx);
  });

  it('marks the bound runtime with the shared current marker', () => {
    const component = makeComponent({ currentRuntimeId: 'dev-box' });
    const plain = rendered(component);
    expect(plain).toContain('← current');
    const currentLine = plain.split('\n').find((line) => line.includes('← current'));
    expect(currentLine).toContain('dev-box');
  });

  it('shows type, status, and defaultCwd on the secondary line', () => {
    const component = makeComponent();
    const plain = rendered(component);
    expect(plain).toContain('ssh · ready · /home/me/projects');
    expect(plain).toContain('command · disconnected');
    expect(plain).toContain('this machine');
  });

  it('renders the disconnected status in the error color and ready in success', () => {
    const component = makeComponent();
    const lines = component.render(120);
    const disconnectedLine = lines.find((line) => line.includes('disconnected'));
    expect(disconnectedLine).toBeDefined();
    expect(disconnectedLine).toContain(ERROR);
    const readyLine = lines.find((line) => line.includes('ssh · '));
    expect(readyLine).toBeDefined();
    expect(readyLine).toContain(SUCCESS);
  });

  it('shows the first line of the disconnect reason next to a disconnected status', () => {
    const component = makeComponent({
      runtimes: [
        LOCAL,
        {
          runtimeId: 'dev-box',
          type: 'ssh',
          status: 'disconnected',
          connectError: 'ssh: connect failed\nretry guidance must not render',
        },
      ],
    });
    const plain = rendered(component);
    expect(plain).toContain('ssh · disconnected · ssh: connect failed');
    expect(plain).not.toContain('retry guidance');
  });

  it('uses the provider-manager header shape (one top border, title, hint, no inner border)', () => {
    const component = makeComponent();
    const lines = component.render(120).map((line) => line.replaceAll(SGR, ''));
    const isBorder = (line: string | undefined): boolean => /^─+$/.test((line ?? '').trim());
    const titleIdx = lines.findIndex((line) => line.includes('Runtimes'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(isBorder(lines[titleIdx + 1])).toBe(false);
    expect(lines[titleIdx + 1]).toContain('navigate');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
    expect(lines[titleIdx + 2]).toBe('');
    expect(lines.filter(isBorder).length).toBe(2);
  });

  it('moves the selection with arrow keys and calls onSwitch on Enter', () => {
    const onSwitch = vi.fn();
    const component = makeComponent({ onSwitch });
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    expect(onSwitch).toHaveBeenCalledWith('dev-box');
  });

  it('does not call onSwitch when Enter lands on the current runtime', () => {
    const onSwitch = vi.fn();
    const component = makeComponent({ onSwitch, currentRuntimeId: 'local' });
    component.handleInput(ENTER);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('calls onAdd when Enter lands on the add row', () => {
    const onAdd = vi.fn();
    const component = makeComponent({ onAdd });
    component.handleInput(DOWN);
    component.handleInput(DOWN);
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('offers R reconnect only on the disconnected bound remote row', () => {
    const onReconnect = vi.fn();
    const component = makeComponent({ onReconnect, currentRuntimeId: 'sandbox' });
    // Selection starts on the current (sandbox) row, which is disconnected.
    expect(rendered(component)).toContain('R reconnect');
    component.handleInput('r');
    expect(onReconnect).toHaveBeenCalledWith('sandbox');
  });

  it('ignores R on rows that are not the disconnected bound one', () => {
    const onReconnect = vi.fn();
    const component = makeComponent({ onReconnect, currentRuntimeId: 'local' });
    expect(rendered(component)).not.toContain('R reconnect');
    component.handleInput(DOWN);
    component.handleInput(DOWN);
    component.handleInput('r');
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('closes on Esc, and clears an inline error before closing', () => {
    const onClose = vi.fn();
    const component = makeComponent({ onClose });
    component.showError('handshake failed: exit code 127');
    expect(rendered(component)).toContain('handshake failed: exit code 127');
    component.handleInput(ESC);
    expect(onClose).not.toHaveBeenCalled();
    expect(rendered(component)).not.toContain('handshake failed');
    component.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks input while busy and renders the busy message', () => {
    const onSwitch = vi.fn();
    const onClose = vi.fn();
    const component = makeComponent({ onSwitch, onClose });
    component.setBusy('Connecting to dev-box…');
    expect(rendered(component)).toContain('Connecting to dev-box…');
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    component.handleInput(ESC);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the selection by runtime id across setOptions refreshes', () => {
    const component = makeComponent();
    component.handleInput(DOWN);
    component.setOptions({
      runtimes: [LOCAL, DEV_BOX, { ...SANDBOX, status: 'ready' }],
      currentRuntimeId: 'local',
      onSwitch: vi.fn(),
      onReconnect: vi.fn(),
      onAdd: vi.fn(),
      onClose: vi.fn(),
    });
    const plain = rendered(component);
    const selectedLine = plain.split('\n').find((line) => line.includes('❯'));
    expect(selectedLine).toContain('dev-box');
    expect(plain).toContain('command · ready');
  });

  it('bounds the inline error to a few lines', () => {
    const component = makeComponent();
    component.showError('line1\nline2\nline3\nline4\nline5\nline6');
    const plain = rendered(component);
    expect(plain).toContain('line4');
    expect(plain).not.toContain('line5');
  });
});
