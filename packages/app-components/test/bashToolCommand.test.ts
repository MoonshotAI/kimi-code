// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import BashTool from '../src/chat/tool-calls/BashTool.vue';

const LONG_COMMAND = `rg --hidden --glob '!node_modules' --glob '!dist' -n "resolveToolRenderer" packages apps | head -n 40 && echo "done scanning the workspace for the tool renderer registry"`;
const LONG_TOKEN_COMMAND = `curl -sSL https://example.com/download?payload=${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(6)}`;

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

function tool(command: string, over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'bash-1',
    name: 'Bash',
    arg: JSON.stringify({ command, cwd: '/repo' }),
    status: 'ok',
    output: ['ok'],
    ...over,
  } as ToolCall;
}

function mount(target: ToolCall, locale: 'en' | 'zh' = 'en', history?: Map<string, unknown>): HTMLElement {
  app = createApp({ render: () => h(BashTool, { tool: target }) });
  app.use(createKimiI18n({ locale }));
  if (history) app.provide(HistoryStateKey, history);
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return host;
}

function commandRows(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.bash-cmd .hl-row'), (row) => row.textContent ?? '');
}

async function expand(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('button.tl-car')!.click();
  await nextTick();
}

function styles(rel: string): string {
  const sfc = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  return Array.from(sfc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), (m) => m[1]).join('\n');
}

describe('bash tool command', () => {
  it('shows the whole command in the expanded panel', async () => {
    const root = mount(tool(LONG_COMMAND));
    expect(root.querySelector('.tl-body')!.classList.contains('open')).toBe(false);
    expect(root.querySelector('.bash-cmd .hl-code')).toBeNull();
    await expand(root);
    expect(root.querySelector('.tl-body')!.classList.contains('open')).toBe(true);
    expect(root.querySelector<HTMLElement>('.bash-cmd')!.textContent).toBe(LONG_COMMAND);
  });

  async function expectCommandShown(root: HTMLElement, command: string): Promise<void> {
    expect(root.querySelector('.tl-body')!.classList.contains('open')).toBe(true);
    await nextTick();
    expect(commandRows(root)).toEqual([command]);
    const viewport = root.querySelector<HTMLElement>('.bash-cmd')!;
    await vi.waitFor(() => expect(viewport.classList.contains('md-code-scroll-viewport')).toBe(true));
    expect(viewport.parentElement!.querySelector(':scope > .md-code-scrollbar--vertical')).not.toBeNull();
  }

  it('renders the command when the tool call mounts already expanded', async () => {
    const root = mount(tool('ls -la', { defaultExpanded: true }));
    await expectCommandShown(root, 'ls -la');
  });

  it('renders the command when the expanded state is restored from history', async () => {
    const history = new Map<string, unknown>([['tool:bash-1:open', true]]);
    const root = mount(tool('ls -la'), 'en', history);
    await expectCommandShown(root, 'ls -la');
  });

  it('renders the command when history reopens a call that was collapsed before', async () => {
    const history = new Map<string, unknown>([['tool:bash-1:open', false]]);
    let root = mount(tool('ls -la'), 'en', history);
    expect(root.querySelector('.bash-cmd .hl-code')).toBeNull();
    await expand(root);
    expect(history.get('tool:bash-1:open')).toBe(true);
    app!.unmount();
    app = null;
    host.replaceChildren();
    root = mount(tool('ls -la'), 'en', history);
    await expectCommandShown(root, 'ls -la');
  });

  it('renders the command when a default expansion arrives after mount', async () => {
    const target = reactive(tool('', { arg: '', status: 'running', output: [] }));
    const root = mount(target);
    target.arg = JSON.stringify({ command: 'ls -la', cwd: '/repo' });
    target.defaultExpanded = true;
    await nextTick();
    await expectCommandShown(root, 'ls -la');
  });

  it('keeps line breaks and indentation of a multi-line command', async () => {
    const command = 'set -euo pipefail\nfor file in *.log; do\n  wc -l "$file"\ndone';
    const root = mount(tool(command));
    await expand(root);
    expect(commandRows(root)).toEqual(command.split('\n'));
  });

  it('shows an unbroken long token in full', async () => {
    const root = mount(tool(LONG_TOKEN_COMMAND));
    await expand(root);
    expect(root.querySelector<HTMLElement>('.bash-cmd')!.textContent).toBe(LONG_TOKEN_COMMAND);
  });

  it('copies the exact command from the command box copy button', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const command = 'set -euo pipefail\nfor file in *.log; do\n  wc -l "$file"\ndone';
    const root = mount(tool(command));
    await expand(root);
    const block = root.querySelector<HTMLElement>('.bash-cmd')!;
    block.closest('.tp')!.querySelector<HTMLButtonElement>('.tp-head button[aria-label="Copy"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
  });

  it('highlights the command as bash', async () => {
    const root = mount(tool('echo "hello" | grep -n hello > out.txt'));
    await expand(root);
    const code = root.querySelector<HTMLElement>('.bash-cmd .hl-code')!;
    await vi.waitFor(
      () => {
        const colored = Array.from(code.querySelectorAll<HTMLElement>('.hl-text span')).filter((span) => span.style.color);
        expect(new Set(colored.map((span) => span.style.color)).size).toBeGreaterThan(1);
      },
      { timeout: 10000 },
    );
    expect(commandRows(root)).toEqual(['echo "hello" | grep -n hello > out.txt']);
  });

  it('puts the command in its own box above a separate output box', async () => {
    const root = mount(tool(LONG_COMMAND));
    await expand(root);
    const boxes = Array.from(root.querySelectorAll<HTMLElement>('.tl-body .tp'));
    expect(boxes).toHaveLength(2);
    const [commandBox, outputBox] = boxes;
    expect(commandBox.querySelector('.bash-cmd')!.textContent).toBe(LONG_COMMAND);
    expect(commandBox.querySelector('.op')).toBeNull();
    expect(outputBox.querySelector('.bash-cmd')).toBeNull();
    expect(outputBox.querySelector('.op')!.textContent).toBe('ok');
    expect(commandBox.compareDocumentPosition(outputBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('titles the command box Bash next to the working directory and copy button', async () => {
    const root = mount(tool(LONG_COMMAND));
    await expand(root);
    const [commandBox] = Array.from(root.querySelectorAll<HTMLElement>('.tl-body .tp'));
    const head = commandBox.querySelector<HTMLElement>('.tp-head')!;
    expect(head.querySelector('.tp-title')!.textContent).toBe('Bash');
    expect(head.querySelector('.tp-meta')!.textContent).toBe('/repo');
    expect(head.querySelector('button')).not.toBeNull();
    expect(Array.from(root.querySelectorAll('.tl-body .tp-title'), (el) => el.textContent)).toEqual(['Bash', 'Output']);
  });

  it('titles the output box Output in a compact head like the command box', async () => {
    for (const [locale, title] of [['en', 'Output'], ['zh', '输出']] as const) {
      const root = mount(tool(LONG_COMMAND), locale);
      await expand(root);
      const [commandBox, outputBox] = Array.from(root.querySelectorAll<HTMLElement>('.tl-body .tp'));
      const head = outputBox.querySelector<HTMLElement>('.tp-head')!;
      expect(head.querySelector('.tp-title')!.textContent).toBe(title);
      expect(head.querySelector('.tp-meta')).toBeNull();
      expect(outputBox.className).toBe(commandBox.className);
      expect(outputBox.classList.contains('flush')).toBe(true);
      expect(outputBox.classList.contains('compact')).toBe(true);
      app!.unmount();
      app = null;
      host.replaceChildren();
    }
  });

  it('renders the output as plain text with no Bash label or highlighting', async () => {
    const output = ['#!/bin/bash', 'echo "$HOME" && ls -la', 'done'];
    const root = mount(tool(LONG_COMMAND, { output }));
    await expand(root);
    const body = root.querySelector<HTMLElement>('.tl-body')!;
    const outputBox = body.querySelectorAll<HTMLElement>('.tp')[1];
    expect(outputBox.querySelector('.tp-title')!.textContent).toBe('Output');
    expect(outputBox.querySelector('.hl-code')).toBeNull();
    expect(outputBox.textContent).not.toMatch(/\bBash\b/);
    const rows = Array.from(outputBox.querySelectorAll<HTMLElement>('.op > div'));
    expect(rows.map((row) => row.textContent)).toEqual(output);
    for (const row of rows) {
      expect(row.childNodes).toHaveLength(1);
      expect(row.firstChild?.nodeType).toBe(3);
    }
  });

  it('shows only the output box when there is no command', async () => {
    const root = mount(tool('', { arg: JSON.stringify({ cwd: '/repo' }) }));
    await expand(root);
    const boxes = root.querySelectorAll('.tl-body .tp');
    expect(boxes).toHaveLength(1);
    expect(boxes[0].querySelector('.op')).not.toBeNull();
    expect(root.querySelector('.bash-cmd')).toBeNull();
  });

  it('leaves the collapsed strip a single truncated line', async () => {
    const root = mount(tool(LONG_COMMAND));
    const strip = root.querySelector<HTMLElement>('.tl-lead .tl-mono')!;
    expect(strip.textContent).toBe(LONG_COMMAND);
  });

  it('hides the truncated strip command while expanded and restores it when collapsed', async () => {
    const root = mount(tool(LONG_COMMAND));
    expect(root.querySelector('.tl-lead .tl-mono')).not.toBeNull();
    await expand(root);
    expect(root.querySelector('.tl-lead .tl-mono')).toBeNull();
    expect(root.querySelector('.tl-lead')!.textContent).not.toContain(LONG_COMMAND);
    await expand(root);
    expect(root.querySelector<HTMLElement>('.tl-lead .tl-mono')!.textContent).toBe(LONG_COMMAND);
  });

  it('leaves the command unwrapped by default and toggles wrapping from the head', async () => {
    const root = mount(tool(LONG_TOKEN_COMMAND));
    await expand(root);
    const code = () => root.querySelector<HTMLElement>('.bash-cmd .hl-code')!;
    const head = root.querySelector<HTMLElement>('.bash-cmd')!.closest('.tp')!.querySelector<HTMLElement>('.tp-head')!;
    const buttons = Array.from(head.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons).toHaveLength(2);
    const [toggle, copy] = buttons;
    expect(copy.getAttribute('aria-label')).toBe('Copy');
    expect(code().classList.contains('wrap')).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe('Enable word wrap');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.querySelector('svg')!.dataset.icon).toBe('text-wrap');

    toggle.click();
    await nextTick();
    expect(code().classList.contains('wrap')).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Disable word wrap');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.querySelector('svg')!.dataset.icon).toBe('text-wrap-disabled');
    expect(root.querySelector('.tl-body')!.classList.contains('open')).toBe(true);

    toggle.click();
    await nextTick();
    expect(code().classList.contains('wrap')).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe('Enable word wrap');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('leaves the output unwrapped by default and toggles it independently of the command', async () => {
    const root = mount(tool(LONG_COMMAND, { output: [LONG_TOKEN_COMMAND, 'done'] }));
    await expand(root);
    const [commandBox, outputBox] = Array.from(root.querySelectorAll<HTMLElement>('.tl-body .tp'));
    const output = outputBox.querySelector<HTMLElement>('.op')!;
    const commandCode = () => commandBox.querySelector<HTMLElement>('.hl-code')!;
    const commandToggle = commandBox.querySelector<HTMLButtonElement>('.tp-head button')!;
    const outputToggle = outputBox.querySelector<HTMLButtonElement>('.tp-head button')!;
    const boxes = root.querySelector<HTMLElement>('.bash-boxes')!;
    await vi.waitFor(() => expect(output.classList.contains('md-code-scroll-viewport')).toBe(true));

    expect(outputBox.querySelectorAll('button')).toHaveLength(2);
    expect(outputBox.querySelector('.tp-head')!.contains(outputToggle)).toBe(true);
    expect(outputBox.querySelector('.tp-body button')).toBeNull();
    expect(root.querySelector('.bash-out, .bash-out-wrap')).toBeNull();
    expect(boxes.classList.contains('bash-out-nowrap')).toBe(true);
    expect(outputToggle.getAttribute('aria-label')).toBe('Enable word wrap');
    expect(outputToggle.getAttribute('aria-pressed')).toBe('false');
    expect(outputToggle.querySelector('svg')!.dataset.icon).toBe('text-wrap');

    outputToggle.click();
    await nextTick();
    expect(boxes.classList.contains('bash-out-nowrap')).toBe(false);
    expect(outputToggle.getAttribute('aria-label')).toBe('Disable word wrap');
    expect(outputToggle.getAttribute('aria-pressed')).toBe('true');
    expect(outputToggle.querySelector('svg')!.dataset.icon).toBe('text-wrap-disabled');
    expect(commandCode().classList.contains('wrap')).toBe(false);
    expect(commandToggle.getAttribute('aria-pressed')).toBe('false');

    commandToggle.click();
    await nextTick();
    expect(commandCode().classList.contains('wrap')).toBe(true);
    expect(boxes.classList.contains('bash-out-nowrap')).toBe(false);

    outputToggle.click();
    await nextTick();
    expect(boxes.classList.contains('bash-out-nowrap')).toBe(true);
    expect(commandCode().classList.contains('wrap')).toBe(true);
    expect(root.querySelector('.tl-body')!.classList.contains('open')).toBe(true);
    expect(output.classList.contains('md-code-scroll-viewport')).toBe(true);
    expect(output.parentElement!.classList.contains('md-code-scroll-host')).toBe(true);
  });

  it('copies the full output from an Output head copy button placed after the wrap toggle', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}  ${'x'.repeat(i)}`);
    const root = mount(tool(LONG_COMMAND, { output }));
    await expand(root);
    const [commandBox, outputBox] = Array.from(root.querySelectorAll<HTMLElement>('.tl-body .tp'));
    const labels = (box: HTMLElement) => Array.from(box.querySelectorAll('.tp-head button'), (b) => b.getAttribute('aria-label'));
    expect(labels(commandBox)).toEqual(['Enable word wrap', 'Copy']);
    expect(labels(outputBox)).toEqual(['Enable word wrap', 'Copy']);
    outputBox.querySelector<HTMLButtonElement>('.tp-head button[aria-label="Copy"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(output.join('\n')));
  });

  it('keeps the Output head above the waiting text while a command has no output yet', async () => {
    const root = mount(tool(LONG_COMMAND, { status: 'running', output: [] }));
    await expand(root);
    const outputBox = root.querySelectorAll<HTMLElement>('.tl-body .tp')[1];
    expect(outputBox.querySelector('.tp-head .tp-title')!.textContent).toBe('Output');
    expect(outputBox.querySelector('.tp-body .op-empty')!.textContent).toBe('Waiting for output…');
    expect(outputBox.querySelector('button')).toBeNull();
  });

  it('pads each unwrapped output row itself so the inset survives horizontal scrolling', async () => {
    const root = mount(tool(LONG_COMMAND, { output: [LONG_TOKEN_COMMAND, 'ok'] }));
    await expand(root);
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.bash-boxes.bash-out-nowrap .op > div'));
    expect(rows.map((row) => row.textContent)).toEqual([LONG_TOKEN_COMMAND, 'ok']);
    expect(rows.every((row) => row.parentElement!.classList.contains('op'))).toBe(true);
  });

  it('gives both boxes the Markdown code block overlay scrollbars once opened', async () => {
    const root = mount(tool(LONG_COMMAND, { output: ['ok'] }));
    expect(root.querySelector('.md-code-scrollbar')).toBeNull();
    await expand(root);
    await nextTick();
    const command = root.querySelector<HTMLElement>('.bash-cmd')!;
    const output = root.querySelector<HTMLElement>('.tp-body > .op')!;
    for (const viewport of [command, output]) {
      await vi.waitFor(() => expect(viewport.classList.contains('md-code-scroll-viewport')).toBe(true));
      const host = viewport.parentElement!;
      expect(host.classList.contains('md-code-scroll-host')).toBe(true);
      expect(host.querySelector(':scope > .md-code-scrollbar--horizontal')).not.toBeNull();
      expect(host.querySelector(':scope > .md-code-scrollbar--vertical')).not.toBeNull();
    }
    app!.unmount();
    app = null;
    expect(command.classList.contains('md-code-scroll-viewport')).toBe(false);
  });

  it('pads the compact head equally above and below and spaces the icon glyphs evenly', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(resolve(here, '../../app-ui/src/style.css'), 'utf8');
    const px = (name: string) => Number(new RegExp(`${name}: (\\d+)px;`).exec(tokens)![1]);
    const css = styles('../src/chat/tool-calls/ToolPanel.vue');
    const head = /\.tp\.flush\.compact \.tp-head \{([^}]*)\}/.exec(css)![1];
    const [top, right, bottom, left] = /padding: ([^;]+);/.exec(head)![1].split(' ');
    expect(top).toBe(bottom);
    expect(right).toBe(top);
    expect(left).toBe('var(--space-3)');
    expect(top).toBe('var(--space-1-5)');
    const p = px('--space-1-5');
    const inset = (px('--icon-button-sm') - px('--p-ic-md')) / 2;
    const boxGap = p - inset;
    expect(p).toBeLessThan(px('--space-2'));
    expect(boxGap).toBeGreaterThanOrEqual(0);
    const glyphTop = p + inset;
    const glyphRight = p + inset;
    const glyphGap = inset + boxGap + inset;
    expect([glyphTop, glyphRight, glyphGap]).toEqual([11, 11, 11]);
    expect(head).toContain('gap: calc(var(--space-1-5) - var(--tp-glyph-inset));');
    expect(/\.tp-head \{([^}]*)\}/.exec(css)![1]).toContain('align-items: center');
  });
});
