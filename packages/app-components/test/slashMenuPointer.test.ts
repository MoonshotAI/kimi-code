// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import SlashMenu from '../src/composer/SlashMenu.vue';
import slashMenuSource from '../src/composer/SlashMenu.vue?raw';
import MentionMenu from '../src/composer/MentionMenu.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  document.body.innerHTML = '';
});

function mountMenu(hovered: number[]): void {
  app = createApp({
    render: () => h(SlashMenu, {
      items: [
        { name: '/new', desc: 'commands.new.desc' },
        { name: '/clear', desc: 'commands.clear.desc' },
      ],
      activeIndex: 0,
      onHover: (index: number) => hovered.push(index),
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
}

function pointerMove(target: Element, x: number, y: number): void {
  const event = new Event('pointermove', { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
  });
  target.dispatchEvent(event);
}

describe('SlashMenu pointer selection', () => {
  it('ignores hover events produced when the menu opens under a stationary pointer', async () => {
    const hovered: number[] = [];
    mountMenu(hovered);
    await nextTick();
    const second = document.querySelectorAll('[role="option"]')[1]!;

    second.dispatchEvent(new Event('mouseenter'));
    pointerMove(second, 100, 100);

    expect(hovered).toEqual([]);
  });

  it('selects the hovered option after real pointer movement', async () => {
    const hovered: number[] = [];
    mountMenu(hovered);
    await nextTick();
    const second = document.querySelectorAll('[role="option"]')[1]!;

    pointerMove(second, 100, 100);
    pointerMove(second, 120, 100);

    expect(hovered).toEqual([1]);
  });
});


describe('skill source labels', () => {
  it('renders global and built-in labels in the slash menu only for skill rows', async () => {
    app = createApp({
      render: () => h(SlashMenu, {
        items: [
          { name: '/skill:global', desc: 'Global skill', isSkill: true, sourceKind: 'global' },
          { name: '/builtin', desc: 'Built-in skill', isSkill: true, sourceKind: 'builtin' },
          { name: '/swarm', desc: 'commands.swarm.desc' },
        ],
        activeIndex: 0,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    expect([...document.querySelectorAll('.slash-dir')].map((element) => element.textContent)).toEqual([
      'Global',
      'Built-in',
    ]);
  });

  it('renders global and built-in labels in the mention menu', async () => {
    app = createApp({
      render: () => h(MentionMenu, {
        items: [
          { kind: 'skill', skill: { name: 'global', description: 'Global skill', source: 'user', path: '/user/global/SKILL.md' } },
          { kind: 'skill', skill: { name: 'builtin', description: 'Built-in skill', source: 'builtin', path: 'builtin://builtin' } },
        ],
        activeIndex: 0,
        loading: false,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    expect([...document.querySelectorAll('.mention-dir')].map((element) => element.textContent)).toEqual([
      'Global',
      'Built-in',
    ]);
  });

  it('shows a searching row under a Files header while file results are pending', async () => {
    app = createApp({
      render: () => h(MentionMenu, {
        items: [
          { kind: 'skill', skill: { name: 'readme-writer', description: '', source: 'user', path: '/user/readme-writer/SKILL.md' } },
        ],
        activeIndex: 0,
        loading: true,
        query: 'readm',
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    expect([...document.querySelectorAll('.mention-section-label')].map((element) => element.textContent?.trim()))
      .toEqual(['Skills', 'Files']);
    expect(document.querySelector('.mention-searching')?.textContent).toBe('Searching for “readm”…');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('shows the searching row alone when nothing else matches yet', async () => {
    app = createApp({
      render: () => h(MentionMenu, { items: [], activeIndex: 0, loading: true }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    expect(document.querySelector('.mention-searching')?.textContent).toBe('Searching…');
    expect(document.querySelector('.mention-state')).toBeNull();
    expect(document.querySelector('.composer-menu-hints')).toBeNull();
  });
});

describe('mobile command layout', () => {
  it('keeps ordinary commands stacked while skills stay in rows', async () => {
    app = createApp({
      render: () => h(SlashMenu, {
        items: [
          { name: '/compact', desc: 'commands.compact.desc' },
          { name: '/skill:review', desc: 'Review', isSkill: true, workspaceLabel: 'B' },
        ],
        activeIndex: 0,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    const rows = [...document.querySelectorAll('.slash-item')];
    expect(rows[0]!.classList.contains('is-skill')).toBe(false);
    expect(rows[1]!.classList.contains('is-skill')).toBe(true);
    expect(slashMenuSource).toMatch(/@media \(max-width: 520px\)[\s\S]*\.slash-item:not\(\.is-skill\)\s*\{[^}]*flex-direction:\s*column/);
    expect(slashMenuSource).toMatch(/@media \(max-width: 520px\)[\s\S]*\.slash-item:not\(\.is-skill\) \.slash-name\s*\{[^}]*max-width:\s*none/);
    expect(slashMenuSource).toMatch(/@media \(max-width: 520px\)[\s\S]*\.slash-item\.is-skill \.slash-name\s*\{[^}]*max-width:\s*45%/);
  });
});

describe('skill grouping', () => {
  it('renders a commands section followed by one skills section', async () => {
    app = createApp({
      render: () => h(SlashMenu, {
        items: [
          { name: '/plan', desc: 'commands.plan.desc' },
          { name: '/skill:lark-calendar', desc: 'Calendar', isSkill: true },
          { name: '/skill:lark-approval', desc: 'Approval', isSkill: true },
        ],
        activeIndex: 0,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    const sections = [...document.querySelectorAll('.slash-section-label')];
    expect(sections.map((section) => section.textContent)).toEqual(['Commands', 'Skills']);
    expect(sections[0]?.nextElementSibling?.querySelector('.slash-name')?.textContent).toBe('plan');
    expect(sections[1]?.nextElementSibling?.querySelector('.slash-name')?.textContent).toBe('skill:lark-calendar');
    expect([...document.querySelectorAll('.slash-item')].map((row) => row.querySelector('.slash-icon') !== null))
      .toEqual([false, true, true]);
    expect(document.querySelector('.composer-menu-hints')?.textContent).toContain('complete');
    expect([...document.querySelectorAll('.slash-name')].map((element) => element.textContent)).toEqual([
      'plan',
      'skill:lark-calendar',
      'skill:lark-approval',
    ]);
  });

  it('highlights the match in a name shown without its leading slash', async () => {
    app = createApp({
      render: () => h(SlashMenu, {
        items: [
          { name: '/plan', desc: 'commands.plan.desc' },
          { name: '/skill:lark-calendar', desc: 'Calendar', isSkill: true },
        ],
        ranges: [{ name: [[1, 3]] }, { name: [[0, 2], [7, 11]] }],
        activeIndex: 0,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();

    const names = [...document.querySelectorAll('.slash-name')];
    expect(names.map((name) => name.textContent)).toEqual(['plan', 'skill:lark-calendar']);
    expect(names.map((name) => [...name.querySelectorAll('.slash-match')].map((hit) => hit.textContent)))
      .toEqual([['pl'], ['s', 'lark']]);
  });
});
