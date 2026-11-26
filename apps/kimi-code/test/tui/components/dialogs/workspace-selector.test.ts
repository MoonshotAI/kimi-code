import type { ManagedWorkspace } from '@moonshot-ai/kimi-code-sdk';
import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSelectorComponent } from '#/tui/components/dialogs/workspace-selector';
import { currentTheme } from '#/tui/theme';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (line: string): string => line.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;

const sampleWorkspaces: readonly ManagedWorkspace[] = [
  {
    kind: 'personal',
    key: 'personal',
    target: { kind: 'personal' },
    name: 'Alice',
    kindLabel: 'Personal workspace',
    current: false,
    disabled: false,
    switchable: true,
    roles: ['ROLE_OWNER'],
  },
  {
    kind: 'business',
    key: 'business:1a17b651-36a2-8eb5-8000-00006b62410d',
    target: { kind: 'business', businessId: '1a17b651-36a2-8eb5-8000-00006b62410d' },
    businessId: '1a17b651-36a2-8eb5-8000-00006b62410d',
    name: 'Acme Corp',
    status: 'STATUS_ACTIVE',
    kindLabel: 'Business workspace',
    current: true,
    disabled: false,
    switchable: true,
    roles: ['ROLE_OWNER'],
  },
  {
    kind: 'business',
    key: 'business:1a17c06a-1782-8010-8000-00006321ed0b',
    target: { kind: 'business', businessId: '1a17c06a-1782-8010-8000-00006321ed0b' },
    businessId: '1a17c06a-1782-8010-8000-00006321ed0b',
    name: 'Acme Corp',
    status: 'STATUS_DISABLED',
    kindLabel: 'Business workspace',
    current: false,
    disabled: true,
    switchable: false,
    roles: ['ROLE_MEMBER'],
  },
];

function renderPlain(selector: WorkspaceSelectorComponent, width = 120): string {
  return selector.render(width).map(strip).join('\n');
}

function mouse(
  type: TuiMouseEvent['type'],
  y: number,
  wheelDelta?: number,
): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 120,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkspaceSelectorComponent', () => {
  it('focuses the current workspace, disambiguates duplicate business names, and marks disabled entries', () => {
    const selector = new WorkspaceSelectorComponent({
      workspaces: sampleWorkspaces,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = renderPlain(selector);
    expect(out).toContain('Switch workspace  (type to search)');
    expect(out).toContain('↑↓ navigate · Enter select · Esc cancel');
    expect(out).toMatch(/Alice\s+Personal workspace/);
    expect(out).toMatch(/❯ Acme Corp\s+Business workspace · 6b62410d ← current/);
    expect(out).toMatch(/Acme Corp\s+Business workspace · 6321ed0b\s+disabled/);
  });

  it('blocks selecting a disabled business workspace and shows an inline warning', () => {
    const onSelect = vi.fn();
    const selector = new WorkspaceSelectorComponent({
      workspaces: sampleWorkspaces,
      onSelect,
      onCancel: vi.fn(),
    });

    selector.handleInput(DOWN);
    selector.handleInput('\r');

    expect(onSelect).not.toHaveBeenCalled();
    expect(renderPlain(selector)).toContain(
      'This business workspace is disabled and cannot be selected.',
    );
  });

  it('clears the search query on the first Esc and cancels on the second Esc', () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const selector = new WorkspaceSelectorComponent({
      workspaces: sampleWorkspaces,
      onSelect,
      onCancel,
    });

    selector.handleInput('P');
    selector.handleInput('e');
    selector.handleInput('r');
    expect(renderPlain(selector)).toContain('Search: Per');

    selector.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    expect(renderPlain(selector)).not.toContain('Search:');

    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports fullscreen mouse focus, hover, wheel navigation, click selection, and disabled click blocking', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const selector = new WorkspaceSelectorComponent({
      workspaces: sampleWorkspaces,
      onSelect,
      onCancel: vi.fn(),
    });

    selector.focused = true;
    const focusedLines = selector.render(120);
    selector.focused = false;
    expect(selector.render(120)).toEqual(focusedLines.map((line) => currentTheme.fade(line)));

    const plainLines = focusedLines.map(strip);
    const personalRow = plainLines.findIndex((line) => line.includes('Personal workspace'));
    const disabledRow = plainLines.findIndex((line) => line.includes('6321ed0b'));

    expect(selector.handleMouse(mouse('click', personalRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(onSelect).not.toHaveBeenCalled();

    selector.focused = true;
    expect(selector.handleMouse(mouse('click', personalRow))).toEqual({
      handled: true,
    });
    expect(onSelect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(selector.handleMouse(mouse('move', disabledRow))).toEqual({
      handled: true,
      render: true,
    });
    for (const type of ['press', 'release', 'click'] as const) {
      selector.handleMouse(mouse(type, disabledRow));
    }
    expect(onSelect).not.toHaveBeenCalled();
    expect(renderPlain(selector)).toContain(
      'This business workspace is disabled and cannot be selected.',
    );

    expect(selector.handleMouse(mouse('wheel', disabledRow, -1))).toEqual({
      handled: true,
      render: true,
    });
    expect(renderPlain(selector)).not.toContain(
      'This business workspace is disabled and cannot be selected.',
    );

    const refreshedRows = selector.render(120).map(strip);
    const nextPersonalRow = refreshedRows.findIndex((line) => line.includes('Personal workspace'));
    for (const type of ['press', 'release', 'click'] as const) {
      selector.handleMouse(mouse(type, nextPersonalRow));
    }
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(sampleWorkspaces[0]);
  });
});
