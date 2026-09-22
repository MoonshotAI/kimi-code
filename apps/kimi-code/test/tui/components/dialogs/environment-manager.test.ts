import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  EnvironmentManagerComponent,
  type EnvironmentManagerOptions,
  type EnvironmentManagerEnvironment,
} from '#/tui/components/dialogs/environment-manager';
import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';

const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const UP = '[A';
const DOWN = '[B';

const SGR = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'g');

// Truecolor SGR fragments for the darkColors tokens asserted below.
const ERROR = '38;2;232;84;84'; // colors.error #E85454
const SUCCESS = '38;2;78;200;126'; // colors.success #4EC87E

function rendered(component: EnvironmentManagerComponent, width = 120): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

const LOCAL: EnvironmentManagerEnvironment = { environmentId: 'local', type: 'local', status: 'ready' };
const DEV_BOX: EnvironmentManagerEnvironment = {
  environmentId: 'dev-box',
  type: 'ssh',
  status: 'ready',
  defaultCwd: '/home/me/projects',
};
const SANDBOX: EnvironmentManagerEnvironment = { environmentId: 'sandbox', type: 'command', status: 'disconnected' };

function makeComponent(overrides: Partial<EnvironmentManagerOptions> = {}): EnvironmentManagerComponent {
  return new EnvironmentManagerComponent({
    environments: [LOCAL, DEV_BOX, SANDBOX],
    currentEnvironmentId: 'local',
    onSwitch: vi.fn(),
    onReconnect: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    requestRender: vi.fn(),
    ...overrides,
  });
}

describe('EnvironmentManagerComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('lists local first, then declared environments, then the add row', () => {
    const component = makeComponent();
    const plain = rendered(component);
    const localIdx = plain.indexOf('local');
    const devBoxIdx = plain.indexOf('dev-box');
    const sandboxIdx = plain.indexOf('sandbox');
    const addIdx = plain.indexOf('Add Environment');
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(devBoxIdx).toBeGreaterThan(localIdx);
    expect(sandboxIdx).toBeGreaterThan(devBoxIdx);
    expect(addIdx).toBeGreaterThan(sandboxIdx);
  });

  it('marks the bound environment with the shared current marker', () => {
    const component = makeComponent({ currentEnvironmentId: 'dev-box' });
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
      environments: [
        LOCAL,
        {
          environmentId: 'dev-box',
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

  it('renders the pending status dim with no error tone and no reason line', () => {
    const component = makeComponent({
      environments: [
        LOCAL,
        { environmentId: 'dev-box', type: 'ssh', status: 'pending', connectError: 'must not render' },
      ],
    });
    const lines = component.render(120);
    const pendingLine = lines.find((line) => line.includes('pending'));
    expect(pendingLine).toBeDefined();
    expect(pendingLine).toContain('38;2;136;136;136'); // colors.textDim #888888
    expect(pendingLine).not.toContain(ERROR);
    expect(pendingLine).not.toContain('must not render');
  });

  it('uses the provider-manager header shape (one top border, title, hint, no inner border)', () => {
    const component = makeComponent();
    const lines = component.render(120).map((line) => line.replaceAll(SGR, ''));
    const isBorder = (line: string | undefined): boolean => /^─+$/.test((line ?? '').trim());
    const titleIdx = lines.findIndex((line) => line.includes('Environments'));
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

  it('does not call onSwitch when Enter lands on the current environment', () => {
    const onSwitch = vi.fn();
    const component = makeComponent({ onSwitch, currentEnvironmentId: 'local' });
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

  it('offers Enter/R reconnect on the disconnected bound remote row', () => {
    const onReconnect = vi.fn();
    const onSwitch = vi.fn();
    const component = makeComponent({ onReconnect, onSwitch, currentEnvironmentId: 'sandbox' });
    // Selection starts on the current (sandbox) row, which is disconnected.
    expect(rendered(component)).toContain('Enter/R reconnect');
    component.handleInput('r');
    expect(onReconnect).toHaveBeenCalledWith();
    component.handleInput(ENTER);
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('offers Enter/R reconnect on the pending bound remote row', () => {
    const onReconnect = vi.fn();
    const onSwitch = vi.fn();
    const component = makeComponent({
      onReconnect,
      onSwitch,
      currentEnvironmentId: 'sandbox',
      environments: [LOCAL, DEV_BOX, { ...SANDBOX, status: 'pending' }],
    });
    expect(rendered(component)).toContain('Enter/R reconnect');
    component.handleInput('r');
    expect(onReconnect).toHaveBeenCalledWith();
    component.handleInput(ENTER);
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('keeps Enter and R inert unless the selected row is a reconnectable bound remote', () => {
    const onReconnect = vi.fn();
    const onSwitch = vi.fn();
    const component = makeComponent({ onReconnect, onSwitch, currentEnvironmentId: 'dev-box' });
    expect(rendered(component)).not.toContain('R reconnect');
    component.handleInput(ENTER);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
    component.handleInput(DOWN);
    component.handleInput('r');
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
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

  it('keeps the selection by environment id across setOptions refreshes', () => {
    const component = makeComponent();
    component.handleInput(DOWN);
    component.setOptions({
      environments: [LOCAL, DEV_BOX, { ...SANDBOX, status: 'ready' }],
      currentEnvironmentId: 'local',
      onSwitch: vi.fn(),
      onReconnect: vi.fn(),
      onAdd: vi.fn(),
      onClose: vi.fn(),
      requestRender: vi.fn(),
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

  it('animates the busy line with a braille frame until the action clears', () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const component = makeComponent({ requestRender });
      component.setBusy('Connecting to dev-box…');
      const busyLine = () =>
        component
          .render(120)
          .map((line) => line.replaceAll(SGR, ''))
          .find((line) => line.includes('Connecting to dev-box…'));
      const first = busyLine();
      expect(first).toBeDefined();
      expect(BRAILLE_SPINNER_FRAMES.some((frame) => first?.includes(frame))).toBe(true);
      vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS);
      expect(requestRender).toHaveBeenCalled();
      expect(busyLine()).not.toBe(first);
      component.showError('boom');
      requestRender.mockClear();
      vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
      expect(requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the busy spinner on dispose', () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const component = makeComponent({ requestRender });
      component.setBusy('Connecting to dev-box…');
      requestRender.mockClear();
      component.dispose();
      vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 5);
      expect(requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
