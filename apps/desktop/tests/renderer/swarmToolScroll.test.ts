// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({ name: 'Markdown', setup: () => () => vue.h('div') }),
  };
});

vi.mock('vue-i18n', async (importActual) => {
  const actual = await importActual<typeof import('vue-i18n')>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, named?: Record<string, unknown>) => (named ? `${key}(${JSON.stringify(named)})` : key),
      te: (key: string) => !key.endsWith('.mystery'),
    }),
  };
});

import { SwarmTool } from '@moonshot-ai/app-components';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { ResolveSwarmMembersKey } from '@moonshot-ai/app-client/contracts';
import { panelApiKey, type PanelApi } from '@moonshot-ai/app-client/panel';
import { useAppearance } from '@moonshot-ai/app-core/composables';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import type { SwarmMember } from '@moonshot-ai/app-core/client';

const tool = {
  id: 'call_swarm',
  name: 'AgentSwarm',
  arg: JSON.stringify({ description: 'd' }),
  status: 'running',
  output: [],
} as ToolCall;

const members: SwarmMember[] = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`,
  agentId: `agent-m${i}`,
  name: `task ${i}`,
  phase: 'completed',
  swarmIndex: i,
}));

let app: App | null = null;
let host: HTMLDivElement;
const resizeCallbacks = new Set<() => void>();

function fireResize(): void {
  for (const cb of resizeCallbacks) cb();
}

function mount(list: SwarmMember[] = members, panelApi?: PanelApi): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(SwarmTool as never, { tool }) });
  app.provide(IconResolverKey, (name: string) =>
    defineComponent({ setup: () => () => h('svg', { 'data-icon': name }) }),
  );
  app.provide(ResolveSwarmMembersKey, () => list);
  if (panelApi) app.provide(panelApiKey, panelApi);
  app.mount(host);
  const el = host.querySelector<HTMLElement>('.ui-scroll-area__viewport');
  expect(el).not.toBeNull();
  return el!;
}

beforeEach(() => {
  resizeCallbacks.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resizeCallbacks.add(cb); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('swarm member list scroll affordances', () => {
  it('tracks edge fades with the scroll position and shows the overlay thumb', async () => {
    const el = mount();
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    const edges = host.querySelector<HTMLElement>('.sw-edges');
    expect(edges).not.toBeNull();

    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(edges!.style.getPropertyValue('--sw-edge-top')).toBe('0');
    expect(edges!.style.getPropertyValue('--sw-edge-bottom')).toBe('1');

    el.scrollTop = 150;
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(edges!.style.getPropertyValue('--sw-edge-top')).toBe('1');
    expect(edges!.style.getPropertyValue('--sw-edge-bottom')).toBe('1');

    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(edges!.style.getPropertyValue('--sw-edge-top')).toBe('1');
    expect(edges!.style.getPropertyValue('--sw-edge-bottom')).toBe('0');

    const thumb = host.querySelector<HTMLElement>('.ui-scroll-area__thumb');
    expect(thumb).not.toBeNull();
    expect(Number.parseFloat(thumb!.style.height)).toBeGreaterThan(0);
  });

  it('passes wheel scrolling on to the conversation once the list reaches an end', () => {
    const el = mount();
    expect(el.style.getPropertyValue('overscroll-behavior')).toBe('auto');
  });

  it('renders no thumb when the list fits without scrolling', async () => {
    const el = mount();
    Object.defineProperty(el, 'scrollHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    const edges = host.querySelector<HTMLElement>('.sw-edges');
    expect(edges!.style.getPropertyValue('--sw-edge-top')).toBe('0');
    expect(edges!.style.getPropertyValue('--sw-edge-bottom')).toBe('0');
    expect(host.querySelector('.ui-scroll-area__thumb')).toBeNull();
  });

  it('recomputes scroll geometry on content resize such as a font-scale change', async () => {
    const { setFontScale } = useAppearance();
    const el = mount();
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    const edges = host.querySelector<HTMLElement>('.sw-edges');
    expect(edges!.style.getPropertyValue('--sw-edge-bottom')).toBe('0');

    try {
      Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true });
      setFontScale('large');
      fireResize();
      await nextTick();
      expect(edges!.style.getPropertyValue('--sw-edge-bottom')).toBe('1');
    } finally {
      setFontScale('medium');
    }
  });

  it('shows the error icon with the message in a tooltip, never inline', async () => {
    vi.useFakeTimers();
    try {
      mount([{ id: 'm0', agentId: 'agent-m0', name: 'task 0', phase: 'failed', text: 'Provider rate limit; subagent retrying', swarmIndex: 0 }]);
      const err = host.querySelector<HTMLElement>('.sw-err');
      expect(err).not.toBeNull();
      expect(host.textContent).not.toContain('Provider rate limit');
      expect(host.querySelector('.sw-act')).toBeNull();
      expect(host.querySelector('.sw-err')).not.toBeNull();
      const row = host.querySelector<HTMLElement>('.sw-row');
      expect(row?.getAttribute('aria-description')).toContain('Provider rate limit; subagent retrying');

      await nextTick();
      err!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      err!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 27, clientY: 10 }));
      await vi.advanceTimersByTimeAsync(200);
      await nextTick();
      const bubble = document.body.querySelector('.ui-tip__bubble');
      expect(bubble?.textContent).toContain('Provider rate limit; subagent retrying');
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the full multi-line error detail in the failure tooltip and description', async () => {
    vi.useFakeTimers();
    try {
      mount([
        { id: 'm0', name: 'task 0', phase: 'failed', text: 'Step 1 failed\n  at frame A\n\nProvider rate limit', swarmIndex: 0 },
        { id: 'm1', agentId: 'agent-m1', name: 'task 1', phase: 'failed', text: 'Tool crashed\nexit code 2', swarmIndex: 1 },
      ]);
      const [first, second] = [...host.querySelectorAll<HTMLElement>('.sw-row')];
      const note = first!.querySelector<HTMLElement>('.sw-err');
      expect(first!.getAttribute('aria-description')).toBe('Step 1 failed\nat frame A\nProvider rate limit');
      expect(second!.getAttribute('aria-description')).toBe('Tool crashed\nexit code 2');

      await nextTick();
      note!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      note!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 27, clientY: 10 }));
      await vi.advanceTimersByTimeAsync(200);
      await nextTick();
      const bubble = document.body.querySelector('.ui-tip__bubble');
      expect(bubble?.textContent).toContain('Step 1 failed');
      expect(bubble?.textContent).toContain('at frame A');
      expect(bubble?.textContent).toContain('Provider rate limit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps a long error in the hint and expands a panel-less failed row to the full result', async () => {
    const text = [...Array.from({ length: 80 }, (_, i) => `log line ${i}`), 'FINAL ERROR'].join('\n');
    mount([{ id: 'm0', name: 'task 0', phase: 'failed', text, swarmIndex: 0 }]);
    const row = host.querySelector<HTMLElement>('.sw-row');
    const hint = row?.getAttribute('aria-description') ?? '';
    expect(hint.length).toBeLessThanOrEqual(400);
    expect(hint.startsWith('…')).toBe(true);
    expect(hint.endsWith('FINAL ERROR')).toBe(true);
    expect(host.querySelector('.sw-err')?.hasAttribute('tabindex')).toBe(false);

    expect(row?.tagName).toBe('BUTTON');
    row!.click();
    await nextTick();
    expect(row!.getAttribute('aria-expanded')).toBe('true');
    const body = host.querySelector<HTMLElement>('.sw-body');
    expect(body!.style.display).toBe('');
    expect(body!.textContent).toContain('log line 0');
    expect(body!.textContent).toContain('FINAL ERROR');
  });

  it('keeps a paused member\'s reason in the status tooltip and the row description, never inline', async () => {
    vi.useFakeTimers();
    try {
      mount([
        { id: 'm0', name: 'task 0', phase: 'suspended', suspendedReason: 'Waiting for approval', swarmIndex: 0 },
        { id: 'm1', agentId: 'agent-m1', name: 'task 1', phase: 'suspended', suspendedReason: 'Waiting for input', swarmIndex: 1 },
        { id: 'm2', name: 'task 2', phase: 'suspended', swarmIndex: 2 },
      ]);
      const [first, second, third] = [...host.querySelectorAll<HTMLElement>('.sw-row')];
      expect(host.textContent).not.toContain('Waiting for');

      expect(first!.tagName).toBe('BUTTON');
      expect(first!.getAttribute('aria-description')).toBe('Waiting for approval');
      const note = first!.querySelector<HTMLElement>('.sw-paused');
      expect(note?.hasAttribute('tabindex')).toBe(false);
      expect(note?.textContent).toContain('tools.swarm.phaseSuspended');

      expect(second!.getAttribute('aria-description')).toBe('Waiting for input');
      expect(second!.querySelector('.sw-paused')?.hasAttribute('tabindex')).toBe(false);

      expect(third!.querySelector('.sw-paused')).toBeNull();
      expect(third!.getAttribute('aria-description')).toBe('tasks.openDetail');
      expect(third!.textContent).toContain('tools.swarm.phaseSuspended');

      await nextTick();
      note!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      note!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 27, clientY: 10 }));
      await vi.advanceTimersByTimeAsync(200);
      await nextTick();
      const bubble = document.body.querySelector('.ui-tip__bubble');
      expect(bubble?.textContent).toContain('Waiting for approval');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the panel by task id for a live member that has no agent id yet', async () => {
    const openAgent = vi.fn<(target: string) => void>();
    mount(
      [
        { id: 'task-q', name: 'queued task', phase: 'queued', swarmIndex: 0 },
        { id: 'task-w', name: 'working task', phase: 'working', swarmIndex: 1 },
        { id: 'task-s', name: 'paused task', phase: 'suspended', swarmIndex: 2 },
        { id: 'task-a', agentId: 'agent-a', name: 'agent task', phase: 'working', swarmIndex: 3 },
        { id: 'task-c', name: 'finished task', phase: 'completed', text: 'saved', swarmIndex: 4 },
      ],
      { openAgent } as unknown as PanelApi,
    );
    const rows = [...host.querySelectorAll<HTMLElement>('.sw-row')];
    for (const row of rows.slice(0, 4)) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.hasAttribute('aria-expanded')).toBe(false);
      expect(row.querySelector('.sw-go-off')).toBeNull();
      row.click();
    }
    expect(openAgent.mock.calls.map(([target]) => target)).toEqual(['task-q', 'task-w', 'task-s', 'agent-a']);

    rows[4]!.click();
    await nextTick();
    expect(openAgent).toHaveBeenCalledTimes(4);
    expect(rows[4]!.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles the inline detail of a panel-less terminal row and refreshes the geometry', async () => {
    mount([{ id: 'm0', name: 'task 0', phase: 'completed', text: 'saved result line 1\nline 2', swarmIndex: 0 }]);
    const row = host.querySelector<HTMLElement>('.sw-row');
    expect(row?.tagName).toBe('BUTTON');
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    const body = host.querySelector<HTMLElement>('.sw-body');
    expect(body).not.toBeNull();
    expect(body!.style.display).toBe('none');

    row!.click();
    await nextTick();
    expect(row!.getAttribute('aria-expanded')).toBe('true');
    expect(body!.style.display).toBe('');
    expect(body!.textContent).toContain('saved result line 1');
    expect(body!.textContent).toContain('line 2');
    expect(host.querySelector('.sw-go-open')).not.toBeNull();

    row!.click();
    await nextTick();
    expect(row!.getAttribute('aria-expanded')).toBe('false');
    expect(body!.style.display).toBe('none');
    expect(host.querySelector('.sw-go-open')).toBeNull();
  });

  it('names every operable row after its own member, in both expanded and collapsed states', async () => {
    mount([
      { id: 'm0', name: 'alpha task', phase: 'completed', text: 'saved result', swarmIndex: 0 },
      { id: 'm1', agentId: 'agent-m1', name: 'beta task', phase: 'completed', swarmIndex: 1 },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('.sw-row')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.hasAttribute('aria-label')).toBe(false);
    }

    expect(rows[0]!.textContent).toContain('alpha task');
    expect(rows[0]!.textContent).toContain('tools.swarm.phaseCompleted');
    expect(rows[0]!.getAttribute('aria-expanded')).toBe('false');

    expect(rows[1]!.textContent).toContain('beta task');
    expect(rows[1]!.getAttribute('aria-description')).toBe('tasks.openDetail');
    expect(rows[1]!.hasAttribute('aria-expanded')).toBe(false);

    rows[0]!.click();
    await nextTick();
    expect(rows[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows[0]!.hasAttribute('aria-label')).toBe(false);
    expect(rows[0]!.textContent).toContain('alpha task');
  });

  it('keeps the failure status reachable without a pointer when the row cannot be opened', async () => {
    vi.useFakeTimers();
    try {
      mount([{ id: 'm0', name: 'task 0', phase: 'failed', swarmIndex: 0 }]);
      const row = host.querySelector<HTMLElement>('.sw-row');
      expect(row?.tagName).toBe('DIV');
      const err = host.querySelector<HTMLElement>('.sw-err');
      expect(err?.getAttribute('tabindex')).toBe('0');
      expect(err?.getAttribute('role')).toBe('note');
      expect(err?.getAttribute('aria-label')).toBe('tools.swarm.phaseFailed');

      await nextTick();
      err!.focus();
      err!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      await nextTick();
      const bubble = document.body.querySelector('.ui-tip__bubble');
      expect(bubble?.textContent).toContain('tools.swarm.phaseFailed');
    } finally {
      vi.useRealTimers();
    }
  });
});
