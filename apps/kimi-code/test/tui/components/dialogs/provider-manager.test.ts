import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk';
import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '#/tui/components/dialogs/provider-manager';
import { darkColors } from '#/tui/theme/colors';

const PRIMARY = '38;2;79;168;255';
const MUTED = '38;2;107;107;107';
const BOLD = '[1m';
const ESC = String.fromCodePoint(27);

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function rendered(component: ProviderManagerComponent, width = 120): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

function makeComponent(overrides: Partial<ProviderManagerOptions> = {}): ProviderManagerComponent {
  return new ProviderManagerComponent({
    providers: {} as Record<string, ProviderConfig>,
    onAdd: vi.fn(),
    onDeleteSource: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });
}

function addRowLine(component: ProviderManagerComponent, width = 120): string | undefined {
  return component.render(width).find((line) => line.includes('Add New Platform'));
}

describe('ProviderManagerComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('renders [ Add New Platform ] in the brand color, never muted, when not selected', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(PRIMARY);
    expect(line).not.toContain(MUTED);
  });

  it('bolds [ Add New Platform ] when it is the selected row', () => {
    const component = makeComponent();
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(BOLD);
    expect(line).toContain(PRIMARY);
  });

  it('marks the active provider with the shared "← current" marker, not a bullet', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const plain = component
      .render(120)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('← current');
    expect(plain).not.toContain('●');
  });

  it('uses the same header shape as the model dialog (one top border, title, hint, no inner border)', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const lines = component.render(120).map((l) => l.replaceAll(SGR, ''));
    const isBorder = (l: string | undefined): boolean => /^─+$/.test((l ?? '').trim());

    const titleIdx = lines.findIndex((l) => l.includes('Providers'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(isBorder(lines[titleIdx + 1])).toBe(false);
    expect(lines[titleIdx + 1]).toContain('navigate');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
    expect(lines[titleIdx + 2]).toBe('');
    expect(lines.filter(isBorder).length).toBe(2);
  });

  it('deletes the highlighted provider via the D key with a y/N confirm', () => {
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onDeleteSource,
    });
    component.handleInput('D');
    expect(rendered(component)).toContain('[y/N]');
    component.handleInput('y');
    expect(onDeleteSource).toHaveBeenCalledWith(['acme']);
  });

  it('closes on Esc', () => {
    const onClose = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      onClose,
    });
    component.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  function pointerEvent(
    type: TuiMouseEvent['type'],
    x: number,
    y: number,
    wheelDelta?: number,
  ): TuiMouseEvent {
    return {
      type,
      button: type === 'move' || type === 'wheel' ? 'none' : 'left',
      x,
      y,
      screenX: x,
      screenY: y,
      width: 120,
      height: 30,
      shift: false,
      alt: false,
      ctrl: false,
      ...(wheelDelta !== undefined ? { wheelDelta } : {}),
    };
  }

  function enableFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }

  it('supports hover, row selection, add activation, and wheel paging', () => {
    enableFakeDate();
    const onAdd = vi.fn();
    const providers: Record<string, ProviderConfig> = {};
    for (let i = 1; i <= 9; i++) {
      providers[`prov-${String(i)}`] = {
        baseUrl: `https://prov-${String(i)}.example.test`,
      } as unknown as ProviderConfig;
    }
    const component = makeComponent({
      providers,
      activeProviderId: 'prov-1',
      onAdd,
    });
    const page1 = component.render(120).map((line) => line.replaceAll(SGR, ''));
    const prov2Row = page1.findIndex((line) => line.includes('prov-2'));
    vi.advanceTimersByTime(300);

    expect(component.handleMouse(pointerEvent('click', 6, prov2Row))).toEqual({
      handled: true,
      focus: true,
    });

    component.focused = true;
    expect(component.handleMouse(pointerEvent('move', 6, prov2Row + 1))).toEqual({
      handled: true,
      render: true,
    });
    expect(component.render(120).map((line) => line.replaceAll(SGR, ''))[prov2Row]).toContain(
      '❯ prov-2',
    );

    component.handleMouse(pointerEvent('press', 6, prov2Row));
    component.handleMouse(pointerEvent('click', 6, prov2Row));
    expect(onAdd).not.toHaveBeenCalled();

    expect(component.handleMouse(pointerEvent('wheel', 6, prov2Row, 1))).toEqual({
      handled: true,
      render: true,
    });
    const page2 = component.render(120).map((line) => line.replaceAll(SGR, ''));
    const addRow = page2.findIndex((line) => line.includes('[ Add New Platform ]'));
    expect(addRow).toBeGreaterThanOrEqual(0);
    component.handleMouse(pointerEvent('press', 6, addRow));
    component.handleMouse(pointerEvent('click', 6, addRow));
    expect(onAdd).toHaveBeenCalledTimes(1);

    expect(component.handleMouse(pointerEvent('wheel', 6, addRow, -1))).toEqual({
      handled: true,
      render: true,
    });
    expect(rendered(component)).toContain('prov-1');
  });

  it('locks list mouse during delete confirm, enforces settling, and makes [y/N] clickable', () => {
    enableFakeDate();
    const onAdd = vi.fn();
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.example.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onAdd,
      onDeleteSource,
    });
    component.focused = true;
    vi.advanceTimersByTime(300);

    component.handleInput('D');
    const confirmLines = component.render(120).map((line) => line.replaceAll(SGR, ''));
    const addRow = confirmLines.findIndex((line) => line.includes('[ Add New Platform ]'));
    const confirmRow = confirmLines.findIndex((line) => line.includes('[y/N]'));
    const promptIdx = confirmLines[confirmRow]!.indexOf('[y/N]');
    const yCol = promptIdx + 1;
    const nCol = promptIdx + 3;

    expect(component.handleMouse(pointerEvent('move', 6, addRow))).toBeUndefined();
    expect(component.handleMouse(pointerEvent('wheel', 6, addRow, 1))).toEqual({ handled: true });
    expect(component.handleMouse(pointerEvent('click', 6, addRow))).toBeUndefined();
    expect(onAdd).not.toHaveBeenCalled();

    component.handleMouse(pointerEvent('press', yCol, confirmRow));
    expect(component.handleMouse(pointerEvent('click', yCol, confirmRow))).toEqual({ handled: true });
    expect(onDeleteSource).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    component.handleMouse(pointerEvent('press', nCol, confirmRow));
    component.handleMouse(pointerEvent('click', nCol, confirmRow));
    expect(onDeleteSource).not.toHaveBeenCalled();
    expect(rendered(component)).not.toContain('[y/N]');

    component.handleInput('D');
    const confirmAgain = component.render(120).map((line) => line.replaceAll(SGR, ''));
    const confirmAgainRow = confirmAgain.findIndex((line) => line.includes('[y/N]'));
    const yColAgain = confirmAgain[confirmAgainRow]!.indexOf('[y/N]') + 1;
    vi.advanceTimersByTime(300);
    component.handleMouse(pointerEvent('press', yColAgain, confirmAgainRow));
    component.handleMouse(pointerEvent('click', yColAgain, confirmAgainRow));
    expect(onDeleteSource).toHaveBeenCalledWith(['acme']);
  });
});
