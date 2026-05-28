import type { Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  MemoryBrowserApp,
  type MemoryBrowserProps,
  type MemoryFactView,
} from '@/tui/memory/browser';
import { darkColors } from '@/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function fakeTerminal(rows: number, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

function makeFact(overrides: Partial<MemoryFactView> = {}): MemoryFactView {
  return {
    scope: 'project',
    slug: 'code-style',
    type: 'project',
    description: 'project code style guidelines',
    body: '---\nname: code-style\ndescription: project code style guidelines\ntype: project\n---\n\nUse Biome with 2-space indent.\n',
    shadowed: false,
    path: '/repo/.kimi-code/memory/code-style.md',
    ...overrides,
  };
}

function makeProps(overrides: Partial<MemoryBrowserProps> = {}): MemoryBrowserProps {
  return {
    facts: [],
    selectedSlug: undefined,
    selectedScope: undefined,
    detailOpen: false,
    confirmingDelete: false,
    scopeFilter: 'all',
    flashMessage: undefined,
    colors: darkColors,
    onSelect: vi.fn(),
    onToggleDetail: vi.fn(),
    onCycleFilter: vi.fn(),
    onRequestDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    onCancelDelete: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function makeApp(props: Partial<MemoryBrowserProps> = {}, rows = 30): MemoryBrowserApp {
  return new MemoryBrowserApp(makeProps(props), fakeTerminal(rows));
}

describe('MemoryBrowserApp — grouped list rendering', () => {
  it('fills exactly terminal.rows lines (height takeover)', () => {
    const lines = makeApp({}, 25).render(120);
    expect(lines.length).toBe(25);
  });

  it('groups facts under "Project" and "User" headers', () => {
    const facts: readonly MemoryFactView[] = [
      makeFact({ scope: 'project', slug: 'alpha', description: 'alpha desc' }),
      makeFact({ scope: 'user', slug: 'beta', type: 'user', description: 'beta desc' }),
    ];
    const out = strip(makeApp({ facts }).render(120).join('\n'));
    expect(out).toMatch(/Project/);
    expect(out).toMatch(/User/);
    // Row format includes slug, type, description.
    expect(out).toContain('alpha');
    expect(out).toContain('(project)');
    expect(out).toContain('alpha desc');
    expect(out).toContain('beta');
    expect(out).toContain('(user)');
  });

  it('annotates user-scope facts shadowed by the project scope', () => {
    const facts: readonly MemoryFactView[] = [
      makeFact({ scope: 'project', slug: 'code-style' }),
      makeFact({
        scope: 'user',
        slug: 'code-style',
        type: 'user',
        description: 'user-level code style',
        shadowed: true,
      }),
    ];
    const out = strip(makeApp({ facts }).render(120).join('\n'));
    expect(out).toMatch(/shadowed by project/i);
  });
});

describe('MemoryBrowserApp — detail pane', () => {
  it('shows the read-only body with frontmatter when a fact is selected and detail is open', () => {
    const facts = [makeFact({ slug: 'alpha', body: '---\nname: alpha\n---\n\nbody-text\n' })];
    const out = strip(
      makeApp({
        facts,
        selectedSlug: 'alpha',
        selectedScope: 'project',
        detailOpen: true,
      }).render(120).join('\n'),
    );
    expect(out).toContain('name: alpha');
    expect(out).toContain('body-text');
  });

  it('does not expose any edit affordance label in the footer', () => {
    const facts = [makeFact({ slug: 'alpha' })];
    const out = strip(
      makeApp({
        facts,
        selectedSlug: 'alpha',
        selectedScope: 'project',
        detailOpen: true,
      }).render(120).join('\n'),
    );
    expect(out).not.toMatch(/edit/i);
  });
});

describe('MemoryBrowserApp — delete confirmation flow', () => {
  it('emits onRequestDelete when the user presses "d"', () => {
    const onRequestDelete = vi.fn();
    const facts = [makeFact({ slug: 'alpha' })];
    const app = makeApp({
      facts,
      selectedSlug: 'alpha',
      selectedScope: 'project',
      onRequestDelete,
    });

    app.handleInput('d');

    expect(onRequestDelete).toHaveBeenCalledWith('project', 'alpha');
  });

  it('shows a confirmation footer when confirmingDelete is true', () => {
    const facts = [makeFact({ slug: 'alpha' })];
    const out = strip(
      makeApp({
        facts,
        selectedSlug: 'alpha',
        selectedScope: 'project',
        confirmingDelete: true,
      }).render(120).join('\n'),
    );
    expect(out.toLowerCase()).toMatch(/confirm/);
  });

  it('emits onConfirmDelete on Enter while confirming', () => {
    const onConfirmDelete = vi.fn();
    const facts = [makeFact({ slug: 'alpha' })];
    const app = makeApp({
      facts,
      selectedSlug: 'alpha',
      selectedScope: 'project',
      confirmingDelete: true,
      onConfirmDelete,
    });

    app.handleInput('\r');

    expect(onConfirmDelete).toHaveBeenCalledWith('project', 'alpha');
  });

  it('emits onCancelDelete on Escape while confirming', () => {
    const onCancelDelete = vi.fn();
    const facts = [makeFact({ slug: 'alpha' })];
    const app = makeApp({
      facts,
      selectedSlug: 'alpha',
      selectedScope: 'project',
      confirmingDelete: true,
      onCancelDelete,
    });

    app.handleInput('');

    expect(onCancelDelete).toHaveBeenCalled();
  });
});

describe('MemoryBrowserApp — navigation and filters', () => {
  it('emits onSelect when arrow-down moves the cursor', () => {
    const onSelect = vi.fn();
    const facts = [
      makeFact({ slug: 'alpha', scope: 'project' }),
      makeFact({ slug: 'beta', scope: 'project' }),
    ];
    const app = makeApp({
      facts,
      selectedSlug: 'alpha',
      selectedScope: 'project',
      onSelect,
    });

    // Down arrow (ESC [ B)
    app.handleInput('[B');

    expect(onSelect).toHaveBeenCalled();
    const args = onSelect.mock.calls.at(-1)!;
    expect(args[0]).toBe('project');
    expect(args[1]).toBe('beta');
  });

  it('emits onCycleFilter when the user presses "s"', () => {
    const onCycleFilter = vi.fn();
    const app = makeApp({ facts: [], onCycleFilter });
    app.handleInput('s');
    expect(onCycleFilter).toHaveBeenCalled();
  });

  it('emits onCancel on q or Escape (when not confirming delete)', () => {
    const onCancel = vi.fn();
    const app = makeApp({ facts: [], onCancel });
    app.handleInput('q');
    expect(onCancel).toHaveBeenCalledTimes(1);
    app.handleInput('');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
